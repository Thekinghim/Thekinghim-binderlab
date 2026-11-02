/**
 * Ingest-API:t för Awish Chrome-tillägget (src/server/ingest, src/app/api/ingest/awish)
 * mot testdatabasen:
 *
 * - Token: skapas av ägare/admin och visas en gång (bara sha256 sparas), läsaren och
 *   påfyllaren kan inte skapa eller se tokens, en återkallad token nekas, en token
 *   slutar fungera när skaparen tappar rollen, och triggern hindrar ändringar.
 * - Annan organisation är omöjlig: token bestämmer organisation och datakälla, en
 *   annan organisations ägare kan inte återkalla eller läsa.
 * - Importen: samma pipeline som CSV (titlar, okända automater i kön, källans tidszon),
 *   idempotent på ordernummer, trigger 'extension', last_synced_at och hjärtslag.
 * - Gränser: rate limit per token, högst 500 rader och 2 MB per batch.
 * - Larm: importregeln larmar när tillägget inte rapporterat på mer än två timmar.
 * - HTTP: CORS bara för chrome-extension://, inga cookies, 401/403/413/429.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import { collectCandidates } from "../../src/server/alerts/evaluate";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  authenticate,
  createIngestLimiters,
  hashToken,
  IngestError,
  ingestBatch,
  ingestStatus,
  parseIngestBody,
  readIngestBody,
  type IngestBody,
  type IngestDeps,
} from "../../src/server/ingest";
import {
  createExtensionSourceFor,
  createSyncTokenFor,
  ExtensionSetupError,
  loadExtensionPanelFor,
  revokeSyncTokenFor,
} from "../../src/server/ingest/manage";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

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
    page: 1,
    pageRow: 1,
    ...overrides,
  };
}

function body(rows: IngestBody["rows"], extra: Partial<IngestBody> = {}): IngestBody {
  return parseIngestBody(JSON.stringify({ rows, client: { version: "1.0.0" }, ...extra }));
}

interface Org {
  orgId: string;
  owner: TestUser;
  ownerViewer: Viewer;
  sourceId: string;
  token: string;
  tokenId: string;
}

async function setupOrg(): Promise<Org> {
  const owner = await createUser();
  const orgId = await createOrg(owner, `Tillägg ${uniqueSuffix()}`);
  const ownerViewer = await viewerFor(owner, orgId);
  const sourceId = await createExtensionSourceFor(ownerViewer, {
    name: "Awish via tillägg",
    sourceTimezone: "Asia/Shanghai",
  });
  const created = await createSyncTokenFor(ownerViewer, {
    dataSourceId: sourceId,
    name: "Kontorsdatorn",
  });
  return { orgId, owner, ownerViewer, sourceId, token: created.token, tokenId: created.id };
}

let A: Org;
let B: Org;

beforeAll(async () => {
  A = await setupOrg();
  B = await setupOrg();
});

async function ordersOf(org: Org) {
  return rows<{
    external_id: string;
    amount_ore: number;
    ordered_at: Date;
    machine_id: string | null;
  }>(
    db(),
    sql`select external_id, amount_ore, ordered_at, machine_id from public.orders
        where organization_id = ${org.orgId} and data_source_id = ${org.sourceId}
        order by external_id`,
  );
}

describe("token", () => {
  it("visas en gång: bara sha256 och prefixet sparas", async () => {
    expect(A.token).toMatch(/^blsync_[A-Za-z0-9_-]{43}$/);
    const stored = await one<{ token_hash: string; token_prefix: string; created_by: string }>(
      db(),
      sql`select token_hash, token_prefix, created_by from public.sync_tokens where id = ${A.tokenId}`,
    );
    expect(stored.token_hash).toBe(hashToken(A.token));
    expect(stored.token_prefix).toBe(A.token.slice(0, 11));
    expect(stored.created_by).toBe(A.owner.id);
    const leaked = await rows(
      db(),
      sql`select 1 from public.audit_log where organization_id = ${A.orgId}
          and (coalesce(after::text, '') like ${`%${stored.token_hash}%`}
               or coalesce(after::text, '') like ${`%${A.token}%`})`,
    );
    expect(leaked).toEqual([]);
    const audit = await rows<{ action: string }>(
      db(),
      sql`select action::text from public.audit_log
          where organization_id = ${A.orgId} and table_name = 'sync_tokens' and row_id = ${A.tokenId}`,
    );
    expect(audit.map((a) => a.action)).toContain("insert");
  });

  it("giltig token ger organisation, datakälla och skaparen", async () => {
    const ctx = await authenticate(deps(), `Bearer ${A.token}`);
    expect(ctx).toEqual({
      tokenId: A.tokenId,
      organizationId: A.orgId,
      dataSourceId: A.sourceId,
      actorUserId: A.owner.id,
    });
  });

  it.each([
    ["saknas", null],
    ["fel schema", `Basic blsync_${"x".repeat(43)}`],
    ["fel form", "Bearer blsync_kort"],
    ["okänd", `Bearer blsync_${"x".repeat(43)}`],
  ])("nekas när token %s (401)", async (_label, header) => {
    await expect(authenticate(deps(), header)).rejects.toMatchObject({ status: 401 });
  });

  it("för många ogiltiga försök från samma IP ger 429, men en giltig token släpps fram", async () => {
    const d = deps();
    for (let i = 0; i < 20; i++) {
      await authenticate(d, "Bearer x", "10.0.0.9").catch(() => undefined);
    }
    await expect(authenticate(d, "Bearer x", "10.0.0.9")).rejects.toMatchObject({
      status: 429,
    });
    // Spärren gäller bara misslyckade försök: en giltig token från samma IP (t.ex. ett
    // kontorsnät, eller nyckeln "okänd" utan proxyrubriker) fungerar ändå.
    await expect(authenticate(d, `Bearer ${A.token}`, "10.0.0.9")).resolves.toBeTruthy();
    // En annan IP påverkas inte.
    await expect(authenticate(d, "Bearer x", "10.0.0.10")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("läsare och påfyllare kan inte skapa, se eller återkalla tokens", async () => {
    for (const role of ["viewer", "refiller"] as const) {
      const member = await createMember(A.orgId, role);
      const v = await viewerFor(member, A.orgId);
      await expect(
        createSyncTokenFor(v, { dataSourceId: A.sourceId, name: "x" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(revokeSyncTokenFor(v, { id: A.tokenId })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      const visible = await asUser(member, (tx) =>
        rows(tx, sql`select id from public.sync_tokens where organization_id = ${A.orgId}`),
      );
      expect(visible).toEqual([]);
    }
  });

  it("admin kan skapa och återkalla; en återkallad token nekas (401)", async () => {
    const admin = await createMember(A.orgId, "admin");
    const v = await viewerFor(admin, A.orgId);
    const created = await createSyncTokenFor(v, { dataSourceId: A.sourceId, name: "Laptop" });
    await expect(authenticate(deps(), `Bearer ${created.token}`)).resolves.toMatchObject({
      actorUserId: admin.id,
    });
    await revokeSyncTokenFor(v, { id: created.id });
    await expect(authenticate(deps(), `Bearer ${created.token}`)).rejects.toMatchObject({
      status: 401,
    });
    const revoked = await one<{ revoked_by: string; revoked_at: Date | null }>(
      db(),
      sql`select revoked_by, revoked_at from public.sync_tokens where id = ${created.id}`,
    );
    expect(revoked.revoked_by).toBe(admin.id);
    expect(revoked.revoked_at).not.toBeNull();
    await expect(revokeSyncTokenFor(v, { id: created.id })).rejects.toBeInstanceOf(
      ExtensionSetupError,
    );
  });

  it("token slutar fungera när skaparen inte längre är ägare eller admin (403)", async () => {
    const admin = await createMember(A.orgId, "admin");
    const created = await createSyncTokenFor(await viewerFor(admin, A.orgId), {
      dataSourceId: A.sourceId,
      name: "Tillfällig",
    });
    await db().execute(
      sql`update public.memberships set role = 'viewer'
          where organization_id = ${A.orgId} and user_id = ${admin.id}`,
    );
    await expect(authenticate(deps(), `Bearer ${created.token}`)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("token kan bara skapas för en aktiv datakälla av typen Awish-tillägg", async () => {
    const csv = await one<{ id: string }>(
      db(),
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${A.orgId}, 'awish_csv', ${`CSV ${uniqueSuffix()}`}) returning id`,
    );
    await expect(
      createSyncTokenFor(A.ownerViewer, { dataSourceId: csv.id, name: "x" }),
    ).rejects.toBeInstanceOf(ExtensionSetupError);
    // Även direkt i databasen (triggern), med giltig hash.
    const outcome = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.sync_tokens (organization_id, data_source_id, name, token_hash, token_prefix)
                       values (${A.orgId}, ${csv.id}, 'x', ${"0".repeat(64)}, 'blsync_x')`),
      ),
    );
    expect(outcome.code).toBe("BL070");
  });

  it("triggern: hash kan inte ändras, återkallelse kan inte ångras, kontaktfälten är systemets", async () => {
    const created = await createSyncTokenFor(A.ownerViewer, {
      dataSourceId: A.sourceId,
      name: "Trigger",
    });
    const hash = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.sync_tokens set token_hash = ${"1".repeat(64)} where id = ${created.id}`,
        ),
      ),
    );
    expect(hash.code).toBe("BL070");
    await asUser(A.owner, (tx) =>
      tx.execute(
        sql`update public.sync_tokens set last_status = 'ok', last_seen_at = now(), name = 'Nytt namn'
            where id = ${created.id}`,
      ),
    );
    const after = await one<{
      name: string;
      last_status: string | null;
      last_seen_at: Date | null;
    }>(
      db(),
      sql`select name, last_status, last_seen_at from public.sync_tokens where id = ${created.id}`,
    );
    expect(after).toEqual({ name: "Nytt namn", last_status: null, last_seen_at: null });
    await revokeSyncTokenFor(A.ownerViewer, { id: created.id });
    const undo = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.sync_tokens set revoked_at = null where id = ${created.id}`),
      ),
    );
    expect(undo.code).toBe("BL070");
    const del = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`delete from public.sync_tokens where id = ${created.id}`)),
    );
    expect(del.ok).toBe(false);
  });
});

describe("annan organisation", () => {
  it("B:s ägare kan inte återkalla, se eller skapa tokens för A:s datakälla", async () => {
    await expect(revokeSyncTokenFor(B.ownerViewer, { id: A.tokenId })).rejects.toBeInstanceOf(
      ExtensionSetupError,
    );
    await expect(
      createSyncTokenFor(B.ownerViewer, { dataSourceId: A.sourceId, name: "x" }),
    ).rejects.toBeInstanceOf(ExtensionSetupError);
    const seen = await asUser(B.owner, (tx) =>
      rows(tx, sql`select id from public.sync_tokens where organization_id = ${A.orgId}`),
    );
    expect(seen).toEqual([]);
    const panel = await loadExtensionPanelFor(B.ownerViewer);
    expect(panel.sources.map((s) => s.id)).toEqual([B.sourceId]);
  });

  it("A:s token skriver bara i A:s datakälla, oavsett vad batchen innehåller", async () => {
    const d = deps();
    const ctx = await authenticate(d, `Bearer ${A.token}`);
    // Okända fält på toppnivå (t.ex. organizationId) ignoreras; mål kommer ur token.
    const sneaky = parseIngestBody(
      JSON.stringify({
        rows: [row(`X-${uniqueSuffix()}`)],
        organizationId: B.orgId,
        dataSourceId: B.sourceId,
      }),
    );
    const result = await ingestBatch(d, ctx, sneaky);
    const imp = await one<{ organization_id: string; data_source_id: string }>(
      db(),
      sql`select organization_id, data_source_id from public.imports where id = ${result.importId}`,
    );
    expect(imp).toEqual({ organization_id: A.orgId, data_source_id: A.sourceId });
    expect(await ordersOf(B)).toEqual([]);
    const status = await ingestStatus(d, await authenticate(d, `Bearer ${B.token}`));
    expect(status.orders.count).toBe(0);
    expect(status.dataSource.id).toBe(B.sourceId);
  });
});

describe("import", () => {
  let org: Org;
  beforeAll(async () => {
    org = await setupOrg();
  });

  it("en batch blir en import (trigger extension) med samma regler som CSV", async () => {
    const d = deps();
    const ctx = await authenticate(d, `Bearer ${org.token}`);
    const result = await ingestBatch(
      d,
      ctx,
      body([
        row("42780"),
        row("42781", { amount: "Order Amount: 79.00\nPaid Amount: 79.00", machine: "Coop Forum" }),
        row("42782", { isPaid: "Unpaid" }),
        row("42783", { amount: "Amount: 1,234" }),
      ]),
    );
    expect(result.importId).not.toBeNull();
    expect(result.summary).toMatchObject({ total: 4, new: 2, notPaid: 1, error: 1 });
    expect(result.unknownMachines).toBe(2);
    const imp = await one<{
      trigger: string;
      status: string;
      file_name: string;
      created_by: string;
      parser_version: string;
    }>(
      db(),
      sql`select trigger::text, status::text, file_name, created_by, parser_version
          from public.imports where id = ${result.importId}`,
    );
    expect(imp).toMatchObject({
      trigger: "extension",
      status: "succeeded",
      file_name: "Chrome-tillägg · sida 1 · 4 rader",
      created_by: org.owner.id,
    });
    expect(imp.parser_version).toContain("awish_extension/1");
    const orders = await ordersOf(org);
    expect(orders.map((o) => [o.external_id, Number(o.amount_ore)])).toEqual([
      ["42780", 17_000],
      ["42781", 7900],
    ]);
    // Källans tidszon (Asia/Shanghai): 2026-11-02 00:17 = 1 nov. 16:17 UTC.
    expect(new Date(orders[0]!.ordered_at).toISOString()).toBe("2026-11-01T16:17:00.000Z");
    expect(orders.every((o) => o.machine_id === null)).toBe(true);
    const queue = await rows<{ external_id: string }>(
      db(),
      sql`select external_id from public.source_machines
          where organization_id = ${org.orgId} and data_source_id = ${org.sourceId} and machine_id is null
          order by external_id`,
    );
    expect(queue.map((q) => q.external_id)).toEqual(["Coop Forum", "Ica Kvantum Malmborgs"]);
    const errors = await rows<{ row_number: number; status: string }>(
      db(),
      sql`select row_number, status::text from public.import_rows
          where organization_id = ${org.orgId} and import_id = ${result.importId} and status = 'error'`,
    );
    expect(errors).toEqual([{ row_number: 4, status: "error" }]);
  });

  it("är idempotent på ordernummer: samma batch igen ger bara dubbletter", async () => {
    const d = deps();
    const ctx = await authenticate(d, `Bearer ${org.token}`);
    const again = await ingestBatch(
      d,
      ctx,
      body([
        row("42780"),
        row("42781", { amount: "Order Amount: 79.00\nPaid Amount: 79.00", machine: "Coop Forum" }),
      ]),
    );
    expect(again.summary).toMatchObject({ total: 2, new: 0, duplicate: 2, conflict: 0 });
    expect((await ordersOf(org)).length).toBe(2);
    // Samma ordernummer med annat belopp ändrar aldrig ordern: konflikt.
    const changed = await ingestBatch(d, ctx, body([row("42780", { amount: "Amount: 99.00" })]));
    expect(changed.summary).toMatchObject({ new: 0, conflict: 1 });
    expect(Number((await ordersOf(org))[0]!.amount_ore)).toBe(17_000);
  });

  it("status visar senaste ordernummer, antal och de kända numren", async () => {
    const d = deps();
    const status = await ingestStatus(d, await authenticate(d, `Bearer ${org.token}`));
    expect(status.orders.count).toBe(2);
    expect(status.orders.knownExternalIds.sort()).toEqual(["42780", "42781"]);
    expect(status.orders.latestExternalId).not.toBeNull();
    expect(status.dataSource.sourceTimezone).toBe("Asia/Shanghai");
    expect(status.limits.maxRows).toBe(500);
  });

  it("hjärtslag: tom batch importerar inget; ok uppdaterar last_synced_at, utloggad gör det inte", async () => {
    const d = deps();
    const ctx = await authenticate(d, `Bearer ${org.token}`);
    await db().execute(
      sql`update public.data_sources set last_synced_at = now() - interval '5 hours' where id = ${org.sourceId}`,
    );
    const importsBefore = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.imports where data_source_id = ${org.sourceId}`,
    );
    const out = await ingestBatch(
      d,
      ctx,
      body([], { report: { state: "logged_out", message: "Inte inloggad på dash.awish.vip" } }),
    );
    expect(out.importId).toBeNull();
    const loggedOut = await one<{
      last_status: string;
      last_error: string;
      client_version: string;
      age: number;
    }>(
      db(),
      sql`select t.last_status, t.last_error, t.client_version,
                 extract(epoch from now() - ds.last_synced_at)::int as age
          from public.sync_tokens t join public.data_sources ds on ds.id = t.data_source_id
          where t.id = ${org.tokenId}`,
    );
    expect(loggedOut).toMatchObject({
      last_status: "logged_out",
      last_error: "Inte inloggad på dash.awish.vip",
      client_version: "1.0.0",
    });
    expect(loggedOut.age).toBeGreaterThan(4 * 3600);
    await ingestBatch(d, ctx, body([], { report: { state: "ok" } }));
    const ok = await one<{ last_status: string; last_error: string | null; age: number }>(
      db(),
      sql`select t.last_status, t.last_error, extract(epoch from now() - ds.last_synced_at)::int as age
          from public.sync_tokens t join public.data_sources ds on ds.id = t.data_source_id
          where t.id = ${org.tokenId}`,
    );
    expect(ok).toMatchObject({ last_status: "ok", last_error: null });
    expect(ok.age).toBeLessThan(60);
    const importsAfter = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.imports where data_source_id = ${org.sourceId}`,
    );
    expect(importsAfter.n).toBe(importsBefore.n);
  });

  it("panelen visar senast synkad, nya senaste dygnet och tokens", async () => {
    const panel = await loadExtensionPanelFor(org.ownerViewer);
    const source = panel.sources[0]!;
    expect(source.newLast24h).toBe(2);
    expect(source.errorRowsLast24h).toBe(1);
    expect(source.silent).toBe(false);
    expect(source.tokens[0]).toMatchObject({
      id: org.tokenId,
      prefix: org.token.slice(0, 11),
      lastStatus: "ok",
    });
    expect(JSON.stringify(panel)).not.toContain(org.token);
  });

  it("en pausad datakälla tar inte emot rader (409)", async () => {
    const p = await setupOrg();
    await db().execute(
      sql`update public.data_sources set status = 'paused' where id = ${p.sourceId}`,
    );
    const d = deps();
    await expect(
      ingestBatch(d, await authenticate(d, `Bearer ${p.token}`), body([row("1")])),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("gränser", () => {
  it("rate limit per token (429) utan att påverka andra tokens", async () => {
    const limiters = createIngestLimiters();
    const d = deps(limiters);
    const ctxA = await authenticate(d, `Bearer ${A.token}`);
    for (let i = 0; i < 120; i++) limiters.batches.hit(`batch:${ctxA.tokenId}`);
    await expect(ingestBatch(d, ctxA, body([]))).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    const ctxB = await authenticate(d, `Bearer ${B.token}`);
    await expect(ingestBatch(d, ctxB, body([]))).resolves.toMatchObject({ importId: null });
  });

  it("högst 500 rader per batch (413)", () => {
    const many = Array.from({ length: 501 }, (_, i) => row(String(i)));
    expect(() => parseIngestBody(JSON.stringify({ rows: many }))).toThrow(IngestError);
    try {
      parseIngestBody(JSON.stringify({ rows: many }));
    } catch (error) {
      expect((error as IngestError).status).toBe(413);
    }
    expect(() => parseIngestBody(JSON.stringify({ rows: many.slice(0, 500) }))).not.toThrow();
  });

  it("högst 2 MB per begäran (413) och ogiltig JSON (400)", async () => {
    const big = new Request("http://localhost/api/ingest/awish", {
      method: "POST",
      body: JSON.stringify({ rows: [], pad: "x".repeat(2 * 1024 * 1024 + 10) }),
    });
    await expect(readIngestBody(big)).rejects.toMatchObject({ status: 413 });
    const bad = new Request("http://localhost/api/ingest/awish", { method: "POST", body: "{" });
    await expect(readIngestBody(bad)).rejects.toMatchObject({ status: 400 });
  });
});

describe("larm vid tystnad", () => {
  it("importregeln larmar när tillägget inte rapporterat på mer än två timmar", async () => {
    const p = await setupOrg();
    const now = new Date();
    const candidatesAt = async (minutesAgo: number) => {
      await db().execute(
        sql`update public.data_sources set last_synced_at = ${new Date(now.getTime() - minutesAgo * 60_000).toISOString()}::timestamptz
            where id = ${p.sourceId}`,
      );
      const { candidates } = await db().transaction((tx) =>
        collectCandidates(tx, p.orgId, "Europe/Stockholm", now),
      );
      return candidates.filter((c) => c.key === `import:${p.sourceId}`);
    };
    expect(await candidatesAt(30)).toEqual([]);
    expect(await candidatesAt(119)).toEqual([]);
    const silent = await candidatesAt(121);
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ kind: "import_failed", severity: "warning" });
    expect(silent[0]!.title).toMatch(/Ingen hämtning från Awish via tillägg/);
    // En lyckad hjärtslag nollställer.
    const d = deps();
    await ingestBatch(
      d,
      await authenticate(d, `Bearer ${p.token}`),
      body([], { report: { state: "ok" } }),
    );
    const { candidates } = await db().transaction((tx) =>
      collectCandidates(tx, p.orgId, "Europe/Stockholm", new Date()),
    );
    expect(candidates.filter((c) => c.key === `import:${p.sourceId}`)).toEqual([]);
  });

  it("en ny datakälla larmar inte förrän två timmar efter att den skapades", async () => {
    const p = await setupOrg();
    const { candidates } = await db().transaction((tx) =>
      collectCandidates(tx, p.orgId, "Europe/Stockholm", new Date()),
    );
    expect(candidates.filter((c) => c.key === `import:${p.sourceId}`)).toEqual([]);
  });
});

describe("HTTP (route handlers)", () => {
  async function post(init: { origin?: string | null; auth?: string; body?: unknown }) {
    const { POST } = await import("../../src/app/api/ingest/awish/route");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.origin) headers.origin = init.origin;
    if (init.auth) headers.authorization = init.auth;
    return POST(
      new Request("http://localhost:3200/api/ingest/awish", {
        method: "POST",
        headers,
        body: JSON.stringify(init.body ?? { rows: [] }),
      }),
    );
  }

  it("CORS bara för chrome-extension://, inga cookies", async () => {
    const res = await post({
      origin: EXTENSION_ORIGIN,
      auth: `Bearer ${A.token}`,
      body: { rows: [], report: { state: "ok" } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");

    const evil = await post({ origin: "https://evil.example", auth: `Bearer ${A.token}` });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();

    const { OPTIONS } = await import("../../src/app/api/ingest/awish/route");
    const pre = OPTIONS(
      new Request("http://localhost:3200/api/ingest/awish", {
        method: "OPTIONS",
        headers: { origin: EXTENSION_ORIGIN, "access-control-request-method": "POST" },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const preEvil = OPTIONS(
      new Request("http://localhost:3200/api/ingest/awish", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(preEvil.status).toBe(403);
  });

  it("utan token 401, en cookie räcker inte", async () => {
    const { POST } = await import("../../src/app/api/ingest/awish/route");
    const res = await POST(
      new Request("http://localhost:3200/api/ingest/awish", {
        method: "POST",
        headers: { origin: EXTENSION_ORIGIN, cookie: `bl_session=${randomUUID()}` },
        body: JSON.stringify({ rows: [] }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("batch via POST och status via GET", async () => {
    const p = await setupOrg();
    const res = await post({
      origin: EXTENSION_ORIGIN,
      auth: `Bearer ${p.token}`,
      body: { rows: [row("777")] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, summary: { new: 1 } });
    const { GET } = await import("../../src/app/api/ingest/awish/status/route");
    const status = await GET(
      new Request("http://localhost:3200/api/ingest/awish/status", {
        headers: { origin: EXTENSION_ORIGIN, authorization: `Bearer ${p.token}` },
      }),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      ok: true,
      orders: { count: 1, latestExternalId: "777", knownExternalIds: ["777"] },
    });
    const tooMany = await post({
      origin: EXTENSION_ORIGIN,
      auth: `Bearer ${p.token}`,
      body: { rows: Array.from({ length: 501 }, (_, i) => row(String(i))) },
    });
    expect(tooMany.status).toBe(413);
  });
});
