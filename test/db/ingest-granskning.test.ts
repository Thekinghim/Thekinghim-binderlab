/**
 * Ingest-API:t efter granskningen av Awish-tillägget (test/db/redteam-tillagg.test.ts):
 *
 * - Samma Awish-order i en uppladdad CSV-källa och i tilläggets källa blir EN order i
 *   organisationen: ordernummer som finns i en annan Awish-källa räknas som dubbletter,
 *   och status-API:t räknar alla Awish-källor (så att tillägget slutar läsa vid dem).
 *   En annan organisations ordrar påverkar inte.
 * - Datakällor visar andra Awish-källor med ordrar och hur tillägget läser Awish
 *   (sätt, sökväg, kolumner).
 * - En pausad källa ser inte synkad ut (hjärtslaget förnyar inte last_synced_at).
 * - Ogiltiga tokens från samma IP spärrar inte en giltig token.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { batchToCsv } from "../../src/import/adapters/awish-extension";
import { LocalFileStore } from "../../src/import/file-store";
import { runImport } from "../../src/import/run-import";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  authenticate,
  createIngestLimiters,
  IngestError,
  ingestBatch,
  ingestStatus,
  parseIngestBody,
  type IngestBody,
  type IngestDeps,
} from "../../src/server/ingest";
import {
  createExtensionSourceFor,
  createSyncTokenFor,
  loadExtensionPanelFor,
} from "../../src/server/ingest/manage";

import {
  asUser,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function deps(limiters = createIngestLimiters()): IngestDeps {
  return { db: db(), limiters };
}

function row(externalId: string, overrides: Partial<IngestBody["rows"][number]> = {}) {
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
    ...overrides,
  };
}

function body(r: IngestBody["rows"], extra: Record<string, unknown> = {}): IngestBody {
  return parseIngestBody(JSON.stringify({ rows: r, ...extra }));
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
  const orgId = await createOrg(owner, `Tillägg granskning ${uniqueSuffix()}`);
  const viewer = await viewerFor(owner, orgId);
  const sourceId = await createExtensionSourceFor(viewer, {
    name: "Awish via tillägg",
    sourceTimezone: "Asia/Shanghai",
  });
  const t = await createSyncTokenFor(viewer, { dataSourceId: sourceId, name: "Dator" });
  return { orgId, owner, viewer, sourceId, token: t.token };
}

/** En awish_csv-källa med de givna raderna uppladdade som CSV (samma väg som Datakällor). */
async function csvSourceWith(org: Org, r: IngestBody["rows"]): Promise<string> {
  const source = await asUser(org.owner, (tx) =>
    one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
          values (${org.orgId}, 'awish_csv', ${`CSV ${uniqueSuffix()}`}, 'Asia/Shanghai') returning id`,
    ),
  );
  await runImport(db(), {
    organizationId: org.orgId,
    dataSourceId: source.id,
    actorUserId: org.owner.id,
    actorEmail: org.owner.email,
    file: { name: "orderlista.csv", content: batchToCsv(r).csv },
    dryRun: false,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "ingest-granskning-"))),
  });
  return source.id;
}

async function orderCount(orgId: string, ids: string[]): Promise<Record<string, number>> {
  const found = await rows<{ external_id: string; n: number }>(
    db(),
    sql`select external_id, count(*)::int as n from public.orders
        where organization_id = ${orgId}
          and external_id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
        group by external_id`,
  );
  return Object.fromEntries(found.map((f) => [f.external_id, f.n]));
}

describe("samma Awish-order i en CSV-källa och i tilläggets källa", () => {
  let A: Org;
  const suffix = uniqueSuffix().replace(/\D/g, "").slice(-8).padStart(8, "0");
  const shared = [`9${suffix}01`, `9${suffix}02`, `9${suffix}03`];
  const fresh = `9${suffix}99`;

  beforeAll(async () => {
    A = await setupOrg();
    await csvSourceWith(
      A,
      shared.map((id) => row(id)),
    );
  });

  it("status räknar alla Awish-källor, så att tillägget slutar läsa vid CSV-ordrarna", async () => {
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    const status = await ingestStatus(deps(), ctx);
    expect(status.orders.count).toBe(3);
    expect(status.orders.sourceCount).toBe(0);
    expect(status.orders.knownExternalIds.sort()).toEqual([...shared].sort());
  });

  it("ordernummer som redan finns i CSV-källan blir dubbletter, nya importeras", async () => {
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    const res = await ingestBatch(
      deps(),
      ctx,
      body(
        [...shared, fresh].map((id) => row(id)),
        {
          report: {
            state: "ok",
            mode: "html",
            path: "/dashboard/orders/index",
            columns: { externalId: "Order No.", amount: "Order Amount" },
          },
        },
      ),
    );
    expect(res.otherSourceDuplicates).toBe(3);
    expect(res.summary).toMatchObject({ total: 4, new: 1, duplicate: 3 });
    expect(await orderCount(A.orgId, [...shared, fresh])).toEqual(
      Object.fromEntries([...shared, fresh].map((id) => [id, 1])),
    );
    const imp = await one<{
      rows_total: number;
      rows_duplicate: number;
      rows_new: number;
      mapping: { otherSourceDuplicates: number };
    }>(
      db(),
      sql`select rows_total, rows_duplicate, rows_new, mapping from public.imports where id = ${res.importId}`,
    );
    expect(imp).toMatchObject({ rows_total: 4, rows_duplicate: 3, rows_new: 1 });
    expect(imp.mapping.otherSourceDuplicates).toBe(3);
  });

  it("en ny läsning av hela historiken skapar inga nya order", async () => {
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    const res = await ingestBatch(deps(), ctx, body([...shared, fresh].map((id) => row(id))));
    expect(res.summary).toMatchObject({ new: 0, duplicate: 4 });
    expect(Object.values(await orderCount(A.orgId, [...shared, fresh]))).toEqual([1, 1, 1, 1]);
  });

  it("en annan organisations CSV med samma ordernummer påverkar inte", async () => {
    const B = await setupOrg();
    await csvSourceWith(B, [row(`8${suffix}01`)]);
    const ctxA = await authenticate(deps(), `Bearer ${A.token}`);
    const res = await ingestBatch(deps(), ctxA, body([row(`8${suffix}01`)]));
    expect(res.otherSourceDuplicates).toBe(0);
    expect(res.summary?.new).toBe(1);
    const status = await ingestStatus(deps(), await authenticate(deps(), `Bearer ${B.token}`));
    expect(status.orders.knownExternalIds).toEqual([`8${suffix}01`]);
  });

  it("Datakällor visar CSV-källan och hur tillägget läser Awish", async () => {
    const panel = await loadExtensionPanelFor(A.viewer);
    expect(panel.otherAwishSources).toEqual([
      expect.objectContaining({ provider: "awish_csv", orders: 3, archived: false }),
    ]);
    const source = panel.sources.find((s) => s.id === A.sourceId)!;
    expect(source.reading).toMatchObject({
      mode: "html",
      path: "/dashboard/orders/index",
      columns: { externalId: "Order No.", amount: "Order Amount" },
      otherSourceDuplicates: 3,
    });
  });
});

describe("rapportens kolumner", () => {
  it("bara korta fältnamn och högst 20 kolumner tas emot", () => {
    expect(() => body([], { report: { state: "ok", columns: { "x; drop table": "a" } } })).toThrow(
      IngestError,
    );
    expect(() =>
      body([], {
        report: {
          state: "ok",
          columns: Object.fromEntries(
            Array.from({ length: 21 }, (_, i) => [`f${"a".repeat(i)}`, "x"]),
          ),
        },
      }),
    ).toThrow(IngestError);
    expect(body([], { report: { state: "ok", mode: "tab" } }).report?.mode).toBe("tab");
  });
});

describe("pausad källa", () => {
  it("hjärtslaget förnyar inte last_synced_at (källan ska inte se synkad ut)", async () => {
    const A = await setupOrg();
    const old = "2026-11-01T00:00:00.000Z";
    await asUser(A.owner, (tx) =>
      tx.execute(
        sql`update public.data_sources set status = 'paused', last_synced_at = ${old}::timestamptz
            where id = ${A.sourceId}`,
      ),
    );
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    const res = await ingestBatch(deps(), ctx, body([], { report: { state: "ok" } }));
    expect(res.lastSyncedAt).toBeNull();
    const ds = await one<{ last_synced_at: Date }>(
      db(),
      sql`select last_synced_at from public.data_sources where id = ${A.sourceId}`,
    );
    expect(new Date(ds.last_synced_at).toISOString()).toBe(old);
  });
});

describe("spärren för ogiltiga tokens", () => {
  it("skräpanrop från samma IP spärrar inte en giltig token, men skräpet spärras", async () => {
    const A = await setupOrg();
    const d = deps();
    for (let i = 0; i < 20; i++) {
      await authenticate(d, "Bearer skräp", "okänd").catch(() => undefined);
    }
    await expect(authenticate(d, `Bearer ${A.token}`, "okänd")).resolves.toMatchObject({
      dataSourceId: A.sourceId,
    });
    await expect(authenticate(d, "Bearer skräp", "okänd")).rejects.toMatchObject({ status: 429 });
    await expect(authenticate(d, `Bearer blsync_${"Z".repeat(43)}`, "okänd")).rejects.toMatchObject(
      { status: 429 },
    );
  });
});
