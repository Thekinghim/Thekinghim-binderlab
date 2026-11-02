/**
 * Röd granskning: Awish Chrome-tillägget och ingest-API:t (src/server/ingest,
 * src/app/api/ingest/awish, extensions/awish-sync).
 *
 * Konvention (som redteam-fas7-db.test.ts): `it.fails("HÅL …")` beskriver det
 * KORREKTA beteendet för ett fynd som inte är åtgärdat. När felet rättas börjar
 * testet fallera; byt då till `it`. Gruppen "STOD EMOT" är attacker som systemet
 * klarar i dag och som ska fortsätta att göra det.
 *
 * Alla sex hålen är åtgärdade (tillägget, spår tillagg) och körs nu som vanliga tester;
 * titlarna behåller "HÅL" så att de går att spåra till granskningen. Fler tester för
 * åtgärderna: test/db/ingest-granskning.test.ts och src/import/adapters/awish-extension-*.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHtml } from "../../extensions/awish-sync/src/extract-html";
import { AwishReader } from "../../extensions/awish-sync/src/awish";
import { jsonApiFromUrl, type OrderRow } from "../../extensions/awish-sync/src/reader";
import { initialState, runSync, type SyncDeps } from "../../extensions/awish-sync/src/sync";
import {
  makeOrders,
  renderOrdersPage,
  type MockOrder,
} from "../../extensions/awish-sync/test/mock-awish";
import { batchToCsv } from "../../src/import/adapters/awish-extension";
import { LocalFileStore } from "../../src/import/file-store";
import { runImport } from "../../src/import/run-import";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  authenticate,
  checkOrigin,
  createIngestLimiters,
  ingestBatch,
  parseIngestBody,
  type IngestBody,
  type IngestDeps,
} from "../../src/server/ingest";
import { createExtensionSourceFor, createSyncTokenFor } from "../../src/server/ingest/manage";

import {
  asUser,
  attempt,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

// ---------------------------------------------------------------------------
// Hjälp
// ---------------------------------------------------------------------------

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function deps(limiters = createIngestLimiters()): IngestDeps {
  return { db: db(), limiters };
}

function row(externalId: string): IngestBody["rows"][number] {
  return {
    externalId,
    title: "Pokémon 151 Booster",
    machine: "Ica Kvantum Malmborgs",
    amount: "Amount: 170.00",
    isPaid: "Paid Success",
    paidAt: "2026-11-02 00:17:00",
    paymentMethod: "WeChat",
    rowId: externalId,
    orderDate: "2026-11-02",
  };
}

function body(r: IngestBody["rows"]): IngestBody {
  return parseIngestBody(JSON.stringify({ rows: r }));
}

interface Org {
  orgId: string;
  owner: TestUser;
  viewer: Viewer;
  sourceId: string;
  token: string;
}

async function setupOrg(): Promise<Org> {
  const owner = await createUser();
  const orgId = await createOrg(owner, `Röd tillägg ${uniqueSuffix()}`);
  const viewer = await viewerFor(owner, orgId);
  const sourceId = await createExtensionSourceFor(viewer, {
    name: "Awish via tillägg",
    sourceTimezone: "Asia/Shanghai",
  });
  const t = await createSyncTokenFor(viewer, { dataSourceId: sourceId, name: "Dator" });
  return { orgId, owner, viewer, sourceId, token: t.token };
}

// Låtsas-Awish + låtsas-Binderlab för synken (samma mönster som awish-extension-sync.test.ts).
const AWISH = "https://dash.awish.vip";
const BINDERLAB = "https://binderlab.example";
const TOKEN = `blsync_${"A".repeat(43)}`;

interface Fake {
  /** Vad Awish-sidan visar (HTML). */
  page: (n: number) => string;
  known: string[];
  reports: { state: string }[];
  sent: OrderRow[];
}

function syncDeps(f: Fake): SyncDeps {
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === AWISH) {
      const n = Number(url.searchParams.get("page") ?? "1");
      return new Response(f.page(n), { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/api/ingest/awish/status") {
      return json({
        ok: true,
        dataSource: { id: "ds", name: "x", sourceTimezone: "Asia/Shanghai", status: "active" },
        lastSyncedAt: null,
        orders: {
          count: f.known.length,
          latestExternalId: f.known[0] ?? null,
          latestOrderedAt: null,
          knownExternalIds: f.known,
        },
        limits: { maxRows: 500, maxBodyBytes: 2_000_000 },
      });
    }
    const b = JSON.parse(String(init?.body)) as { rows: OrderRow[]; report?: { state: string } };
    if (b.report) f.reports.push(b.report);
    f.sent.push(...b.rows);
    return json({ ok: true, importId: null, summary: null, lastSyncedAt: null });
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    parseHtml: async (html) => extractHtml(html),
    now: () => new Date("2026-11-02T10:00:00Z"),
    sleep: async () => undefined,
    awishOrigin: AWISH,
    ordersPath: "/dashboard/orders/index",
    pageSize: 20,
    apiProbeIntervalMs: 86_400_000,
    version: "redteam",
    pageDelayMs: 0,
    batchSize: 200,
    overlapPages: 1,
    maxIncrementalPages: 2000,
  };
}

const settings = { binderlabUrl: BINDERLAB, token: TOKEN };

// ---------------------------------------------------------------------------
// HÅL
// ---------------------------------------------------------------------------

describe("HÅL: tillägget", () => {
  it("HÅL tom ordertabell på sida 1 trots att Binderlab har ordrar rapporteras inte som 'ok' (annars tystnar larmet)", async () => {
    // Sidan har rubrikerna men inga rader (t.ex. en tabell som fylls med JavaScript,
    // ett filter som sitter kvar, eller ett nytt sidformat).
    const f: Fake = {
      page: () => renderOrdersPage([], 1),
      known: makeOrders(40).map((o) => o.orderNo),
      reports: [],
      sent: [],
    };
    const state = await runSync(syncDeps(f), settings, initialState());
    // Korrekt: ett fel (eller åtminstone ingen ok-rapport som förnyar last_synced_at).
    expect(f.reports.at(-1)?.state).not.toBe("ok");
    expect(state.lastError).not.toBeNull();
  });

  it("HÅL ett upptäckt JSON-API utanför orderlistan (t.ex. återbetalningar) används inte som orderkälla", () => {
    const memory = initialState().awish;
    const reader = new AwishReader(
      { ...syncDeps({ page: () => "", known: [], reports: [], sent: [] }) },
      memory,
    );
    // discover.ts rapporterar VARJE samma-ursprungs-JSON med en order_no-nyckel.
    const accepted = reader.useDiscoveredApi(
      `${AWISH}/dashboard/refund/index?sort=id&order=desc&offset=0&limit=10`,
    );
    expect(accepted).toBe(false);
  });

  it("HÅL filter och sortering från panelens senaste anrop följer inte med i det sparade API:t", () => {
    // Användaren har filtrerat på en automat och sorterat äldst först i Awish-panelen.
    const api = jsonApiFromUrl(
      `${AWISH}/dashboard/orders/index?search=&sort=id&order=asc&offset=0&limit=10` +
        `&filter=${encodeURIComponent('{"machine_name":"Ica"}')}&op=${encodeURIComponent('{"machine_name":"="}')}`,
    );
    const u = new URL(api!.url);
    expect(u.searchParams.get("filter") ?? "{}").toBe("{}");
    expect(u.searchParams.get("order") ?? "desc").toBe("desc");
  });

  it("HÅL en ej betald order som blir betald efter att ha hamnat mer än en sida under den nyaste kända ordern skickas ändå", async () => {
    // 60 ordrar, nyast först. Order X (index 45) var ej betald och skickades som ej betald.
    const orders: MockOrder[] = makeOrders(60).map((o) => ({ ...o, paid: true }));
    const x = orders[45]!;
    const known = orders.filter((o) => o !== x).map((o) => o.orderNo);
    const previous = { ...initialState(), sentUnpaid: [x.orderNo] };
    // Nu är X betald (sen betalningsbekräftelse).
    const f: Fake = {
      page: (n) => renderOrdersPage(orders, n),
      known,
      reports: [],
      sent: [],
    };
    await runSync(syncDeps(f), settings, previous);
    expect(f.sent.map((r) => r.externalId)).toContain(x.orderNo);
  });
});

describe("HÅL: servern", () => {
  let A: Org;
  beforeAll(async () => {
    A = await setupOrg();
  });

  it("HÅL samma Awish-order i en befintlig CSV-källa och i tilläggets källa blir inte två order i organisationen", async () => {
    // Beställaren har redan laddat upp Awish orderlista som CSV (awish_csv) och skapar
    // nu en datakälla för tillägget, som läser hela historiken.
    const csvSource = await asUser(A.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
              values (${A.orgId}, 'awish_csv', ${`CSV ${uniqueSuffix()}`}, 'Asia/Shanghai') returning id`,
      ),
    );
    const shared = [row("427801000001"), row("427801000002")];
    await runImport(db(), {
      organizationId: A.orgId,
      dataSourceId: csvSource.id,
      actorUserId: A.owner.id,
      actorEmail: A.owner.email,
      file: { name: "orderlista.csv", content: batchToCsv(shared).csv },
      dryRun: false,
      fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "redteam-tillagg-"))),
    });
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    await ingestBatch(deps(), ctx, body(shared));
    const counts = await rows<{ external_id: string; n: number }>(
      db(),
      sql`select external_id, count(*)::int as n from public.orders
            where organization_id = ${A.orgId} and external_id in ('427801000001', '427801000002')
            group by external_id`,
    );
    // Korrekt: en order per ordernummer i organisationen (eller att ingest/UI vägrar/varnar).
    expect(counts.every((c) => c.n === 1)).toBe(true);
  });

  it("HÅL ogiltiga tokens från en delad/okänd IP spärrar inte en giltig token", async () => {
    // Utan proxyrubriker blir nyckeln "okänd" för ALLA klienter: vem som helst på
    // internet kan med 20 skräpanrop i minuten stoppa synken för alla kunder.
    const d = deps();
    for (let i = 0; i < 20; i++) {
      await authenticate(d, "Bearer skräp", "okänd").catch(() => undefined);
    }
    await expect(authenticate(d, `Bearer ${A.token}`, "okänd")).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// STOD EMOT
// ---------------------------------------------------------------------------

describe("STOD EMOT", () => {
  let A: Org;
  let B: Org;
  beforeAll(async () => {
    A = await setupOrg();
    B = await setupOrg();
  });

  it("ägare i A kan inte skapa en token mot B:s datakälla direkt i tabellen", async () => {
    await asUser(A.owner, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.sync_tokens (organization_id, data_source_id, name, token_hash, token_prefix)
              values (${B.orgId}, ${B.sourceId}, 'x', ${"a".repeat(64)}, 'blsync_abcd')`,
        ),
      );
      expect(r.ok).toBe(false);
      const r2 = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.sync_tokens (organization_id, data_source_id, name, token_hash, token_prefix)
              values (${A.orgId}, ${B.sourceId}, 'x', ${"b".repeat(64)}, 'blsync_abcd')`,
        ),
      );
      expect(r2.ok).toBe(false);
    });
  });

  it("klienten kan inte förfalska kontaktfälten, skaparen eller återställa en återkallad token", async () => {
    await asUser(A.owner, async (tx) => {
      const [t] = await rows<{ id: string }>(
        tx,
        sql`insert into public.sync_tokens (organization_id, data_source_id, name, token_hash, token_prefix, created_by, last_status)
            values (${A.orgId}, ${A.sourceId}, 'egen', ${"c".repeat(64)}, 'blsync_cccc', ${B.owner.id}, 'ok')
            returning id`,
      );
      const stored = await one<{ created_by: string; last_status: string | null }>(
        tx,
        sql`select created_by, last_status from public.sync_tokens where id = ${t!.id}`,
      );
      expect(stored.created_by).toBe(A.owner.id);
      expect(stored.last_status).toBeNull();
      await tx.execute(sql`update public.sync_tokens set revoked_at = now() where id = ${t!.id}`);
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`update public.sync_tokens set revoked_at = null where id = ${t!.id}`),
      );
      expect(r.ok).toBe(false);
    });
  });

  it("B:s ägare ser inte A:s tokens", async () => {
    const seen = await asUser(B.owner, (tx) =>
      rows(tx, sql`select id from public.sync_tokens where organization_id = ${A.orgId}`),
    );
    expect(seen).toEqual([]);
  });

  it("A:s token skriver aldrig i B, även om kroppen innehåller B:s id:n", async () => {
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    const b = parseIngestBody(
      JSON.stringify({
        rows: [row(`rt-${uniqueSuffix()}`)],
        organizationId: B.orgId,
        dataSourceId: B.sourceId,
      }),
    );
    const res = await ingestBatch(deps(), ctx, b);
    expect(res.importId).toBeTruthy();
    const inB = await rows(
      db(),
      sql`select 1 from public.imports where id = ${res.importId} and organization_id = ${B.orgId}`,
    );
    expect(inB).toEqual([]);
  });

  it("SQL- och CSV-injektion i cellerna blir text i en rad, inte nya rader eller SQL", async () => {
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    const id = `rt-inj-${uniqueSuffix()}`;
    const evil = {
      ...row(id),
      title: `x"\n"999","2026-01-01","Fejk","fejk-order","M","","Amount: 1.00","Paid Success","2026-01-01 00:00:00"\n'); drop table public.orders; --`,
    };
    const res = await ingestBatch(deps(), ctx, body([evil]));
    expect(res.summary?.total).toBe(1);
    const fake = await rows(
      db(),
      sql`select 1 from public.orders where organization_id = ${A.orgId} and external_id = 'fejk-order'`,
    );
    expect(fake).toEqual([]);
  });

  it("CORS: vanliga webbsidor och Origin: null nekas, chrome-extension:// släpps", () => {
    const req = (origin: string | null) =>
      new Request("https://x/api/ingest/awish", {
        method: "POST",
        headers: origin === null ? {} : { origin },
      });
    expect(checkOrigin(req("https://evil.example")).denied?.status).toBe(403);
    expect(checkOrigin(req("null")).denied?.status).toBe(403);
    expect(checkOrigin(req(`chrome-extension://${"a".repeat(32)}`)).denied).toBeNull();
    expect(checkOrigin(req(null)).denied).toBeNull();
  });
});
