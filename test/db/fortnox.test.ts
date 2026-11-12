/**
 * Fortnox mot testdatabasen och en falsk Fortnox-server (src/server/fortnox/testing): aldrig
 * mot riktiga Fortnox. Visar att
 *
 * - bara ägare och admin (utan Enkel vy) når något, och att läsare, påfyllare, butiksanvändare,
 *   andra organisationer och demoorganisationer inte gör det, i tjänsten och i databasen (RLS),
 * - token ligger i Vault och inte i någon tabell som en klientroll kan läsa,
 * - torrkörning inte skickar något,
 * - exempelmånaden (oktober 2026) bokförs med exakt de belopp som räknats för hand,
 * - varje verifikat bokförs exakt en gång: vid en andra körning, vid två körningar samtidigt,
 *   när svaret från Fortnox tappas och när token byts mitt i,
 * - en låst period, ett konto som saknas och en koppling som inte gäller stoppar utan att
 *   något går förlorat, och säger det i klartext,
 * - ett skickat verifikat aldrig ändras eller raderas, och att en rättelse är ett nytt
 *   verifikat som vänder det gamla.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import type { FileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import { archivePayoutFor, importNayaxStatementFor } from "@/server/accounting/service";
import { octoberPdf } from "@/server/accounting/testing/nayax-pdf";
import type { Viewer } from "@/server/data/core/loaders";
import { refreshTokens } from "@/server/fortnox/client";
import { fortnoxConfig } from "@/server/fortnox/config";
import { DEFAULT_MAPPING } from "@/server/fortnox/mapping";
import {
  disconnectFortnoxFor,
  finishFortnoxConnectFor,
  FortnoxError,
  loadFortnoxFor,
  requestFortnoxReversalFor,
  runFortnoxNowFor,
  saveFortnoxSettingsFor,
  setFortnoxLiveFor,
  startFortnoxConnectFor,
} from "@/server/fortnox/service";
import { runFortnoxFor, runFortnoxForAll } from "@/server/fortnox/sync";
import { FakeFortnox } from "@/server/fortnox/testing/fake-fortnox";
import { readTokens, tokenSource } from "@/server/fortnox/tokens";
import { voucherMarker } from "@/server/fortnox/vouchers";

import {
  asAnon,
  asPostgres,
  asServiceRole,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

/** "Nu" i testerna: efter Nayax utbetalningsdag för oktober (16 november 2026). */
const NOW = new Date("2026-11-20T10:00:00Z");

let fake: FakeFortnox;
let orgId: string;
let ownerUser: TestUser;
let owner: Viewer;
let admin: Viewer;
let reader: Viewer;
let refiller: Viewer;
let simpleAdmin: Viewer;
let outsider: Viewer;
let otherOrgId: string;
let storeId: string;
let settlementId: string;

const files: FileStore = {
  kind: "local",
  async put(path) {
    return { path, created: true };
  },
  async get() {
    return new Uint8Array();
  },
};

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

interface Out {
  id: string;
  idem_key: string;
  kind: string;
  state: string;
  block_code: string | null;
  block_detail: string | null;
  fortnox_series: string | null;
  fortnox_number: number | null;
  attempts: number;
  reverses_id: string | null;
  [key: string]: unknown;
}

const outbox = (org = orgId) =>
  rows<Out>(
    db(),
    sql`select id::text as id, idem_key, kind, state, block_code, block_detail, fortnox_series,
               fortnox_number, attempts, reverses_id::text as reverses_id
        from public.fortnox_vouchers where organization_id = ${org}::uuid
        order by voucher_date, created_at, id`,
  );

const connection = async (org = orgId) =>
  (
    await rows<{
      status: string;
      live: boolean;
      start_month: string | null;
      company_name: string | null;
    }>(
      db(),
      sql`select status, live, start_month::text as start_month, company_name
          from public.fortnox_connections where organization_id = ${org}::uuid`,
    )
  )[0] ?? null;

const openAlerts = async (org = orgId) =>
  (
    await rows<{ incident_key: string }>(
      db(),
      sql`select incident_key from public.alerts
          where organization_id = ${org}::uuid and status = 'open' and incident_key like 'fortnox:%'
          order by incident_key`,
    )
  ).map((r) => r.incident_key);

/** Kopplar som om ägaren godkänt hos Fortnox (koden kommer från den falska servern). */
async function connect(viewer: Viewer) {
  const start = await startFortnoxConnectFor(viewer);
  const url = new URL(start.url);
  const code = fake.issueCode(
    url.searchParams.get("redirect_uri")!,
    url.searchParams.get("code_challenge"),
  );
  return finishFortnoxConnectFor(viewer, {
    code,
    state: url.searchParams.get("state"),
    error: null,
    cookie: start.cookie,
  });
}

const run = (options: { staleClaimMs?: number } = {}) =>
  runFortnoxFor(db(), orgId, { now: NOW, ...options });

const settings = (startMonth: string, mapping = DEFAULT_MAPPING, series = "A") =>
  saveFortnoxSettingsFor(owner, { startMonth, series, mapping });

/** Verifikaten i den falska Fortnox som [konto, debet öre, kredit öre]. */
const posted = () =>
  fake.vouchers.map((v) => ({
    ref: `${v.series}${v.number}`,
    date: v.date,
    description: v.description,
    rows: v.rows.map((r) => [r.account, r.debit, r.credit] as const),
  }));

beforeAll(async () => {
  fake = new FakeFortnox();
  const url = await fake.start();
  process.env.FORTNOX_CLIENT_ID = fake.clientId;
  process.env.FORTNOX_CLIENT_SECRET = fake.clientSecret;
  process.env.FORTNOX_API_BASE_URL = url;
  process.env.FORTNOX_AUTH_BASE_URL = url;
  process.env.APP_URL = "http://127.0.0.1:3210";
  expect(fortnoxConfig()?.apiBaseUrl).toBe(url);

  ownerUser = await createUser(`fortnox-agare-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, `Fortnox ${uniqueSuffix()}`);
  owner = await viewerFor(ownerUser, orgId);
  admin = await viewerFor(await createMember(orgId, "admin"), orgId);
  reader = await viewerFor(await createMember(orgId, "viewer"), orgId);
  refiller = await viewerFor(await createMember(orgId, "refiller"), orgId);
  const simpleUser = await createMember(orgId, "admin");
  await asPostgres((tx) =>
    tx.execute(sql`update public.memberships set view_mode = 'simple'
                   where organization_id = ${orgId}::uuid and user_id = ${simpleUser.id}::uuid`),
  );
  simpleAdmin = await viewerFor(simpleUser, orgId);
  expect(simpleAdmin.organization.viewMode).toBe("simple");
  const outsiderUser = await createUser(`fortnox-annan-${uniqueSuffix()}@test.binderlab.se`);
  otherOrgId = await createOrg(outsiderUser, `Annan ${uniqueSuffix()}`);
  outsider = await viewerFor(outsiderUser, otherOrgId);

  await asUser(ownerUser, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Butik Ett", address: "Storgatan 1" })
      .returning();
    storeId = store!.id;
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat Ett", activeFrom: "2026-01-01" })
      .returning();
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151" })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 2000, validFrom: "2026-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Order Machine 1",
        machineId: machine!.id,
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "e".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        status: "succeeded",
      })
      .returning();
    // Oktober: tre order som summerar till Nayax-rapportens försäljning, 76 245,00 kr.
    // September: en order (ligger före startmånaden och ska aldrig bokföras).
    const orders: [string, number][] = [
      ["2026-09-15", 100_000],
      ["2026-10-05", 7_251_100],
      ["2026-10-06", 370_000],
      ["2026-10-07", 3_400],
    ];
    await tx.insert(s.orders).values(
      orders.map(([day, amountOre], i) => ({
        ...org,
        dataSourceId: source!.id,
        rawTitle: "Pokemon 151",
        titleId: title!.id,
        amountOre,
        sourceMachineId: sourceMachine!.id,
        machineId: machine!.id,
        importId: imp!.id,
        externalId: String(80001 + i),
        orderedAt: new Date(`${day}T10:00:00Z`),
        sourceHash: `fortnox-${i}`,
      })),
    );
  });
  // Nayax månadsrapport för oktober: 72 330,48 kr in, kortavgift 3 049,80, bankavgift 40,00,
  // engångsavgift 824,72.
  await importNayaxStatementFor(
    owner,
    { name: "Reimbursement Statement.pdf", bytes: octoberPdf() },
    { fileStore: files },
  );
});

afterAll(async () => {
  await fake.stop();
});

describe("vem som når Fortnox", () => {
  it("läsare, påfyllare, Enkel vy och en annan organisation får ingenting i tjänsten", async () => {
    const forged: Viewer = { user: outsider.user, organization: owner.organization };
    for (const v of [reader, refiller, simpleAdmin, forged]) {
      expect(await loadFortnoxFor(v, NOW)).toBeNull();
      await expect(startFortnoxConnectFor(v)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        finishFortnoxConnectFor(v, { code: "x", state: "y", error: null, cookie: "z" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        saveFortnoxSettingsFor(v, { startMonth: "2026-10", series: "A", mapping: DEFAULT_MAPPING }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(setFortnoxLiveFor(v, true)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runFortnoxNowFor(v, { now: NOW })).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        requestFortnoxReversalFor(v, "00000000-0000-4000-8000-000000000000"),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(disconnectFortnoxFor(v)).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(await connection()).toBeNull();
    expect(fake.tokenRequests).toEqual([]);
  });

  it("ägaren kopplar: token hamnar i Vault, kopplingen börjar i torrkörning", async () => {
    const result = await connect(owner);
    expect(result).toEqual({ companyName: "Testbolaget AB", reconnected: false });
    expect(await connection()).toEqual({
      status: "connected",
      live: false,
      start_month: null,
      company_name: "Testbolaget AB",
    });
    const tokens = await readTokens(db(), orgId);
    expect(tokens?.accessToken).toMatch(/^at_/);
    expect(tokens?.refreshToken).toMatch(/^rt_/);
    // Inte i någon kolumn i kopplingen eller läget.
    const dump = JSON.stringify(
      await rows(
        db(),
        sql`select to_jsonb(c) as c, (select to_jsonb(st) from public.fortnox_sync_state st
              where st.organization_id = c.organization_id) as st
            from public.fortnox_connections c where c.organization_id = ${orgId}::uuid`,
      ),
    );
    expect(dump).not.toContain(tokens!.accessToken);
    expect(dump).not.toContain(tokens!.refreshToken);
    // Granskningsloggen har kopplingen men inte token.
    const audit = JSON.stringify(
      await rows(
        db(),
        sql`select to_jsonb(a) as a from public.audit_log a
                           where a.organization_id = ${orgId}::uuid`,
      ),
    );
    expect(audit).not.toContain(tokens!.accessToken);
    expect(audit).not.toContain(tokens!.refreshToken);
  });

  it("fel state, en annans kaka eller en avbruten koppling ändrar ingenting", async () => {
    const before = await readTokens(db(), orgId);
    const start = await startFortnoxConnectFor(owner);
    const url = new URL(start.url);
    const code = () =>
      fake.issueCode(url.searchParams.get("redirect_uri")!, url.searchParams.get("code_challenge"));
    const state = url.searchParams.get("state");
    await expect(
      finishFortnoxConnectFor(owner, {
        code: code(),
        state: "fel",
        error: null,
        cookie: start.cookie,
      }),
    ).rejects.toBeInstanceOf(FortnoxError);
    // Adminens webbläsare med ägarens kaka: nekas (kakan är bunden till användaren).
    await expect(
      finishFortnoxConnectFor(admin, { code: code(), state, error: null, cookie: start.cookie }),
    ).rejects.toBeInstanceOf(FortnoxError);
    await expect(
      finishFortnoxConnectFor(owner, {
        code: code(),
        state,
        error: null,
        cookie: `${start.cookie}x`,
      }),
    ).rejects.toBeInstanceOf(FortnoxError);
    await expect(
      finishFortnoxConnectFor(owner, {
        code: null,
        state,
        error: "access_denied",
        cookie: start.cookie,
      }),
    ).rejects.toThrow(/avbröts/);
    await expect(
      finishFortnoxConnectFor(
        owner,
        { code: code(), state, error: null, cookie: start.cookie },
        { now: new Date(Date.now() + 11 * 60_000) },
      ),
    ).rejects.toBeInstanceOf(FortnoxError);
    expect(await readTokens(db(), orgId)).toEqual(before);
  });

  it("databasen: bara ägare och admin utan Enkel vy ser kopplingen, utkorgen och läget", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`
        insert into public.fortnox_vouchers
          (organization_id, idem_key, kind, source_ref, voucher_date, description, rows, fingerprint)
        values (${otherOrgId}::uuid, 'sales:2026-01:v1', 'sales', '2026-01', '2026-01-31', 'Annan org',
                '[{"account":"1580","amountOre":100,"text":"a"},{"account":"3000","amountOre":-100,"text":"a"}]'::jsonb,
                ${"a".repeat(64)})`),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.fortnox_sync_state (organization_id, last_run_at)
                     values (${orgId}::uuid, now()) on conflict do nothing`),
    );
    const count = (u: TestUser, table: string) =>
      asUser(u, async (tx) =>
        Number(
          (
            await rows<{ n: number }>(
              tx,
              sql`select count(*)::int as n from ${sql.raw(`public.${table}`)}
                  where organization_id = ${orgId}::uuid`,
            )
          )[0]!.n,
        ),
      );
    for (const u of [ownerUser, { id: admin.user.userId, email: admin.user.email }]) {
      expect(await count(u, "fortnox_connections")).toBe(1);
      expect(await count(u, "fortnox_sync_state")).toBe(1);
    }
    for (const v of [reader, refiller, simpleAdmin, outsider]) {
      const u = { id: v.user.userId, email: v.user.email };
      for (const table of ["fortnox_connections", "fortnox_sync_state", "fortnox_vouchers"]) {
        expect(await count(u, table), `${v.organization.role} ${table}`).toBe(0);
      }
      // Ändra läget eller mappningen: ingen rad träffas.
      const changed = await asUser(u, async (tx) =>
        Array.from(
          await tx.execute(sql`update public.fortnox_connections set live = true, start_month = '2026-10-01'
                               where organization_id = ${orgId}::uuid returning id`),
        ),
      );
      expect(changed).toEqual([]);
    }
    // Ägaren i den andra organisationen ser sin egen rad men inte vår.
    const own = await asUser({ id: outsider.user.userId, email: outsider.user.email }, (tx) =>
      rows(tx, sql`select organization_id::text as o from public.fortnox_vouchers`),
    );
    expect(own).toEqual([{ o: otherOrgId }]);
    expect((await connection())?.live).toBe(false);
  });

  it("databasen: ingen klientroll skapar en koppling, skriver i utkorgen eller läser token", async () => {
    const insertConnection = sql`insert into public.fortnox_connections (organization_id)
                                 values (${otherOrgId}::uuid)`;
    const insertVoucher = sql`
      insert into public.fortnox_vouchers
        (organization_id, idem_key, kind, source_ref, voucher_date, description, rows, fingerprint)
      values (${orgId}::uuid, 'sales:2026-02:v1', 'sales', '2026-02', '2026-02-28', 'x',
              '[{"account":"1580","amountOre":1,"text":"a"},{"account":"3000","amountOre":-1,"text":"a"}]'::jsonb,
              ${"b".repeat(64)})`;
    for (const q of [
      insertConnection,
      insertVoucher,
      sql`delete from public.fortnox_connections where organization_id = ${orgId}::uuid`,
      sql`update public.fortnox_connections set status = 'connected' where organization_id = ${orgId}::uuid`,
      sql`update public.fortnox_vouchers set state = 'sent' where organization_id = ${otherOrgId}::uuid`,
      sql`insert into public.fortnox_sync_state (organization_id) values (${otherOrgId}::uuid)`,
      sql`select private.fortnox_read_tokens(${orgId}::uuid)`,
      sql`select private.fortnox_save_tokens(${orgId}::uuid, 'a', 'b', now())`,
      sql`select private.fortnox_clear_tokens(${orgId}::uuid)`,
      sql`select * from vault.decrypted_secrets`,
      sql`select private.fortnox_cron_tick()`,
    ]) {
      const asOwner = await asUser(ownerUser, (tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(asOwner.ok, "ägaren").toBe(false);
      expect(asOwner.code).toBe("42501");
      const anon = await asAnon((tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(anon.ok, "anon").toBe(false);
    }
    // Servicerollen (Supabase secret key) når inte heller token.
    for (const q of [
      sql`select private.fortnox_read_tokens(${orgId}::uuid)`,
      sql`select private.fortnox_clear_tokens(${orgId}::uuid)`,
    ]) {
      const service = await asServiceRole((tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(service.ok).toBe(false);
    }
    expect(await readTokens(db(), orgId)).not.toBeNull();
  });

  it("en demoorganisation kan inte kopplas", async () => {
    const demoUser = await createUser(`fortnox-demo-${uniqueSuffix()}@test.binderlab.se`);
    const demoOrg = await createOrg(demoUser, `Demo ${uniqueSuffix()}`);
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set is_demo = true where id = ${demoOrg}::uuid`),
    );
    const demo = await viewerFor(demoUser, demoOrg);
    await expect(startFortnoxConnectFor(demo)).rejects.toThrow(/demo/i);
    const direct = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.fortnox_connections (organization_id) values (${demoOrg}::uuid)`,
        ),
      ),
    );
    expect(direct.ok).toBe(false);
    expect(direct.message).toMatch(/demoorganisation/);
    expect(await connection(demoOrg)).toBeNull();
  });
});

describe("torrkörning", () => {
  it("utan startmånad finns inget att skicka, och skarpt läge går inte att slå på", async () => {
    const view = await loadFortnoxFor(owner, NOW);
    expect(view?.line.text).toBe("Fortnox är kopplat. Välj från vilken månad det ska bokföras.");
    expect(view?.suggestedStartMonth).toBe("2026-11");
    await expect(setFortnoxLiveFor(owner, true)).rejects.toThrow(/från vilken månad/);
    // Inte heller direkt i databasen.
    const direct = await asUser(ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.fortnox_connections set live = true
                       where organization_id = ${orgId}::uuid`),
      ),
    );
    expect(direct.ok).toBe(false);
    expect((await connection())?.live).toBe(false);
  });

  it("startar ägaren i november bokförs inget för oktober, inte heller oktobers utbetalning", async () => {
    // Oktober är då bokförd för hand (försäljning och uppskattad kortavgift). Utbetalningen
    // för oktober kom in i november, men hör till oktober: den bokförs inte härifrån.
    await settings("2026-11");
    expect(await run()).toMatchObject({ status: "dry_run", wouldSend: 0 });
    expect((await loadFortnoxFor(owner, NOW))?.next).toEqual([]);
  });

  it("en månad räknas som avslutad först den 3:e i nästa månad", async () => {
    await settings("2026-10");
    const at = (iso: string) => runFortnoxFor(db(), orgId, { now: new Date(iso) });
    // 1 och 2 november: oktober väntar på sena order. 3 november: oktober tas fram.
    expect(await at("2026-11-01T10:00:00Z")).toMatchObject({ status: "dry_run", wouldSend: 0 });
    expect(await at("2026-11-02T10:00:00Z")).toMatchObject({ status: "dry_run", wouldSend: 0 });
    expect(await at("2026-11-03T10:00:00Z")).toMatchObject({ status: "dry_run", wouldSend: 1 });
  });

  it("visar exakt vad som skulle skickas, och skickar ingenting", async () => {
    await settings("2026-10");
    const before = fake.requests.length;
    const result = await run();
    expect(result).toMatchObject({ status: "dry_run", wouldSend: 2, sent: 0 });
    expect(await outbox()).toEqual([]);
    expect(fake.vouchers).toEqual([]);
    expect(fake.requests.length).toBe(before);
    const view = await loadFortnoxFor(owner, NOW);
    expect(view?.line.text).toBe(
      "Fortnox: torrkörning. 2 verifikat skulle skickas. Inget skickas förrän du slår på.",
    );
    expect(view?.next.map((v) => [v.kind, v.date, v.description])).toEqual([
      ["sales", "2026-10-31", "Försäljning automater oktober 2026"],
      ["payout", "2026-11-16", "Utbetalning Nayax 2026-10"],
    ]);
    // Adminen ser samma sak.
    expect((await loadFortnoxFor(admin, NOW))?.next).toHaveLength(2);
  });

  it("jobbet för alla organisationer skickar inte heller något i torrkörning", async () => {
    const all = await runFortnoxForAll(db(), { now: NOW });
    expect(all.organizations.find((o) => o.organizationId === orgId)?.status).toBe("dry_run");
    expect(fake.vouchers).toEqual([]);
  });
});

describe("skarpt läge: exempelmånaden bokförs exakt en gång", () => {
  it("två körningar samtidigt och en tredje efteråt ger två verifikat, inte fler", async () => {
    await setFortnoxLiveFor(owner, true);
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.sent + b.sent).toBe(2);
    // En körning i taget per organisation: den som kom tvåa gjorde ingenting.
    expect([a.status, b.status].sort()).toEqual(["busy", "ran"]);
    const again = await run();
    expect(again).toMatchObject({ status: "ran", sent: 0, waiting: 0, blocked: 0, error: null });
    expect(fake.vouchers).toHaveLength(2);
    const rowsNow = await outbox();
    expect(rowsNow.map((r) => [r.idem_key, r.state, r.attempts])).toEqual([
      ["sales:2026-10:v1", "sent", 1],
      [expect.stringMatching(/^payout:[0-9a-f-]{36}:v1$/), "sent", 1],
    ]);
    expect(rowsNow.map((r) => `${r.fortnox_series}${r.fortnox_number}`).sort()).toEqual([
      "A1",
      "A2",
    ]);
  });

  it("beloppen i Fortnox är de som räknats för hand", async () => {
    const [sales, payout] = [...posted()].sort((x, y) => (x.date < y.date ? -1 : 1));
    // Försäljning 76 245,00 kr: debet 1580, kredit 3000 (en rad per automat).
    expect(sales!.date).toBe("2026-10-31");
    expect(sales!.rows).toEqual([
      [1580, 7_624_500, 0],
      [3000, 0, 7_624_500],
    ]);
    // Utbetalningen: 72 330,48 + 3 049,80 + 40,00 + 824,72 = 76 245,00.
    expect(payout!.date).toBe("2026-11-16");
    expect(payout!.rows).toEqual([
      [1930, 7_233_048, 0],
      [6040, 304_980, 0],
      [6570, 4_000, 0],
      [6590, 82_472, 0],
      [1580, 0, 7_624_500],
    ]);
    const texts = fake.vouchers.find((v) => v.date === "2026-11-16")!.rows.map((r) => r.text);
    expect(texts[3]).toBe("Justering Nayax: Onboarding fee");
    for (const v of posted()) {
      const debit = v.rows.reduce((n, r) => n + r[1], 0);
      const credit = v.rows.reduce((n, r) => n + r[2], 0);
      expect(debit).toBe(credit);
      expect(debit).toBe(7_624_500);
    }
    // September ligger före startmånaden och är inte bokförd.
    expect(fake.vouchers.some((v) => v.date < "2026-10-01")).toBe(false);
    // Varje verifikat bär sitt märke, så att det kan hittas igen.
    expect(sales!.description).toContain(voucherMarker(orgId, "sales:2026-10:v1"));
  });

  it("ägaren ser raden och listan med Fortnox nummer", async () => {
    const view = await loadFortnoxFor(owner, NOW);
    expect(view?.line).toEqual({ tone: "ok", text: "Fortnox: allt bokfört t.o.m. i går." });
    expect(view?.next).toEqual([]);
    expect(view?.outbox.map((r) => [r.kind, r.state, r.series, r.number])).toEqual([
      ["payout", "sent", "A", expect.any(Number)],
      ["sales", "sent", "A", expect.any(Number)],
    ]);
    expect(await openAlerts()).toEqual([]);
  });

  it("startmånaden går inte att ändra när verifikat har skickats", async () => {
    await expect(settings("2026-09")).rejects.toThrow(/Startmånaden kan inte ändras/);
    expect((await connection())?.start_month).toBe("2026-10-01");
    expect(fake.vouchers).toHaveLength(2);
  });
});

describe("butikens andel och betalning", () => {
  it("en betald avräkning bokförs en gång", async () => {
    await asPostgres(async (tx) => {
      const [row] = await rows<{ id: string }>(
        tx,
        sql`insert into public.store_settlements
              (organization_id, store_id, month, amount_ore, statement, calc_version)
            values (${orgId}::uuid, ${storeId}::uuid, '2026-10-01', 1500000, '{}'::jsonb, 'test')
            returning id::text as id`,
      );
      settlementId = row!.id;
    });
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-10'
                     where organization_id = ${orgId}::uuid and id = ${settlementId}::uuid`),
    );
    const first = await run();
    expect(first).toMatchObject({ sent: 1, waiting: 0, blocked: 0 });
    expect((await run()).sent).toBe(0);
    const v = posted().find((x) => x.date === "2026-11-10")!;
    expect(v.rows).toEqual([
      [2990, 1_500_000, 0],
      [1930, 0, 1_500_000],
    ]);
    expect(v.description).toContain("Betalt till Butik Ett för oktober 2026");
    expect(fake.vouchers).toHaveLength(3);
  });
});

describe("tappat svar: verifikatet finns i Fortnox men svaret kom aldrig", () => {
  let secondSettlement: string;

  it("raden står som oviss och skickas inte igen", async () => {
    const [store2] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Två", address: "Storgatan 2" })
        .returning(),
    );
    await asPostgres(async (tx) => {
      const [row] = await rows<{ id: string }>(
        tx,
        sql`insert into public.store_settlements
              (organization_id, store_id, month, amount_ore, statement, calc_version)
            values (${orgId}::uuid, ${store2!.id}::uuid, '2026-10-01', 250000, '{}'::jsonb, 'test')
            returning id::text as id`,
      );
      secondSettlement = row!.id;
    });
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-11'
                     where organization_id = ${orgId}::uuid and id = ${secondSettlement}::uuid`),
    );
    fake.dropNextVoucherReply = true;
    const lost = await run();
    expect(lost).toMatchObject({ sent: 0, waiting: 1 });
    expect(lost.error).toMatch(/Försöker igen i natt/);
    expect(fake.vouchers).toHaveLength(4);
    const row = (await outbox()).find(
      (r) => r.idem_key === `settlement_paid:${secondSettlement}:v1`,
    )!;
    expect(row).toMatchObject({ state: "sending", fortnox_number: null, attempts: 1 });
    // En ny körning direkt (anspråket är färskt): rör inte raden, skickar inget.
    const soon = await run();
    expect(soon).toMatchObject({ sent: 0, recovered: 0, waiting: 1 });
    expect(fake.vouchers).toHaveLength(4);
    expect((await loadFortnoxFor(owner, NOW))?.line.text).toBe(
      "Fortnox: 1 verifikat väntar. Försöker igen i natt.",
    );
  });

  it("nästa körning hittar det i Fortnox och sparar numret, utan dubblett", async () => {
    const [a, b] = await Promise.all([run({ staleClaimMs: 0 }), run({ staleClaimMs: 0 })]);
    expect(a.recovered + b.recovered).toBeGreaterThanOrEqual(1);
    expect(a.sent + b.sent).toBe(0);
    expect(fake.vouchers).toHaveLength(4);
    const row = (await outbox()).find(
      (r) => r.idem_key === `settlement_paid:${secondSettlement}:v1`,
    )!;
    const inFortnox = fake.vouchers.find((v) => v.date === "2026-11-11")!;
    expect(row).toMatchObject({
      state: "sent",
      fortnox_series: "A",
      fortnox_number: inFortnox.number,
      attempts: 1,
    });
    expect((await run({ staleClaimMs: 0 })).sent).toBe(0);
    expect(fake.vouchers).toHaveLength(4);
  });

  it("ett ovisst svar där inget kom fram till Fortnox (502) skickas vid nästa körning, en gång", async () => {
    const [store] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Åtta", address: "Storgatan 8" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store!.id}::uuid, '2026-10-01', 5000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-12'
                     where organization_id = ${orgId}::uuid and store_id = ${store!.id}::uuid`),
    );
    fake.failNext.push({ status: 502, path: /^\/3\/vouchers$/ });
    expect(await run()).toMatchObject({ sent: 0, waiting: 1 });
    expect((await outbox()).filter((r) => r.state === "sending")).toHaveLength(1);
    expect(fake.vouchers).toHaveLength(4);
    // Färskt anspråk: lämnas. Gammalt anspråk: letas upp, finns inte, skickas.
    expect(await run()).toMatchObject({ sent: 0, waiting: 1 });
    const result = await run({ staleClaimMs: 0 });
    expect(result).toMatchObject({ recovered: 0, sent: 1, waiting: 0 });
    expect((await run({ staleClaimMs: 0 })).sent).toBe(0);
    expect(fake.vouchers).toHaveLength(5);
    expect((await outbox()).filter((r) => r.state === "sent" && r.attempts === 2)).toHaveLength(1);
  });
});

describe("databasen felar precis efter att Fortnox har bokfört", () => {
  it("numret går inte att spara: raden står kvar som oviss och hittas igen, utan dubblett", async () => {
    const [store] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Nio", address: "Storgatan 9" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store!.id}::uuid, '2026-10-01', 9000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-12'
                     where organization_id = ${orgId}::uuid and store_id = ${store!.id}::uuid`),
    );
    // En trigger som bara finns i testet: att skriva "sent" misslyckas, som när databasen
    // tappar anslutningen mellan Fortnox svar och vår UPDATE.
    await asPostgres(async (tx) => {
      await tx.execute(sql`
        create function public.test_fortnox_fail_sent() returns trigger language plpgsql as $f$
        begin
          if new.state = 'sent' then raise exception 'testfel: databasen svarar inte'; end if;
          return new;
        end $f$`);
      await tx.execute(sql`
        create trigger t99_test_fail before update on public.fortnox_vouchers
        for each row execute function public.test_fortnox_fail_sent()`);
    });
    const before = fake.vouchers.length;
    let failed;
    try {
      failed = await run();
    } finally {
      await asPostgres(async (tx) => {
        await tx.execute(sql`drop trigger t99_test_fail on public.fortnox_vouchers`);
        await tx.execute(sql`drop function public.test_fortnox_fail_sent()`);
      });
    }
    // Verifikatet finns i Fortnox, men raden säger inte "skickat" och inte "stoppat".
    expect(fake.vouchers).toHaveLength(before + 1);
    expect(failed).toMatchObject({ sent: 0, blocked: 0, waiting: 1 });
    const row = (await outbox()).find((r) => r.state === "sending")!;
    expect(row).toMatchObject({ kind: "settlement_paid", block_code: null, fortnox_number: null });
    // Nästa körning (färskt anspråk) rör den inte. När anspråket är gammalt hittas
    // verifikatet på sitt märke och numret sparas. Aldrig ett andra verifikat.
    expect(await run()).toMatchObject({ sent: 0, recovered: 0, waiting: 1 });
    expect(await run({ staleClaimMs: 0 })).toMatchObject({ sent: 0, recovered: 1, waiting: 0 });
    expect(fake.vouchers).toHaveLength(before + 1);
    expect((await outbox()).find((r) => r.id === row.id)).toMatchObject({
      state: "sent",
      fortnox_number: fake.vouchers.at(-1)!.number,
    });
  });
});

describe("token", () => {
  it("en utgången åtkomsttoken förnyas mitt i körningen: refresh-token byts och inget dubbleras", async () => {
    const before = await readTokens(db(), orgId);
    fake.expireAccessTokens();
    const refreshesBefore = fake.tokenRequests.filter((t) => t.grant === "refresh_token").length;
    // Något att skicka: en tredje betald avräkning.
    const [store3] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Tre", address: "Storgatan 3" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store3!.id}::uuid, '2026-10-01', 100000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-12'
                     where organization_id = ${orgId}::uuid and store_id = ${store3!.id}::uuid`),
    );
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.sent + b.sent).toBe(1);
    expect(a.error ?? b.error).toBeNull();
    expect(fake.vouchers).toHaveLength(7);
    const after = await readTokens(db(), orgId);
    expect(after!.refreshToken).not.toBe(before!.refreshToken);
    expect(after!.accessToken).not.toBe(before!.accessToken);
    // Två körningar samtidigt förnyade en gång, inte två (annars hade den ena slagit ut den andra).
    const refreshes = fake.tokenRequests
      .filter((t) => t.grant === "refresh_token")
      .slice(refreshesBefore);
    expect(refreshes).toEqual([{ grant: "refresh_token", status: 200 }]);
    // Den gamla refresh-token gäller inte längre hos Fortnox.
    await expect(refreshTokens(fortnoxConfig()!, before!.refreshToken)).rejects.toMatchObject({
      kind: "invalid_grant",
    });
    expect((await connection())?.status).toBe("connected");
  });

  it("två som förnyar samtidigt med tvång får samma nya token", async () => {
    const config = fortnoxConfig()!;
    const before = fake.tokenRequests.length;
    const one = tokenSource(db(), orgId, config);
    const two = tokenSource(db(), orgId, config);
    // Båda har läst samma token och fått nej på den.
    const [t1, t2] = await Promise.all([one(false), two(false)]);
    expect(t1).toBe(t2);
    fake.expireAccessTokens();
    const [n1, n2] = await Promise.all([one(true), two(true)]);
    expect(n1).toBe(n2);
    expect(n1).not.toBe(t1);
    expect(fake.tokenRequests.slice(before)).toEqual([{ grant: "refresh_token", status: 200 }]);
  });

  it("ett tillfälligt fel hos token-tjänsten förbrukar ingenting", async () => {
    fake.expireAccessTokens();
    fake.tokenOutages = 1;
    const before = await readTokens(db(), orgId);
    const source = tokenSource(db(), orgId, fortnoxConfig()!);
    await expect(source(false)).resolves.toBe(before!.accessToken);
    await expect(source(true)).rejects.toMatchObject({ kind: "temporary" });
    expect(await readTokens(db(), orgId)).toEqual(before);
    expect((await connection())?.status).toBe("connected");
    await expect(source(true)).resolves.toMatch(/^at_/);
  });
});

describe("låst period och konto som saknas", () => {
  let lockedId: string;

  it("en låst period stoppar verifikatet, säger varför och larmar", async () => {
    const [store4] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Fyra", address: "Storgatan 4" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store4!.id}::uuid, '2026-10-01', 70000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-05'
                     where organization_id = ${orgId}::uuid and store_id = ${store4!.id}::uuid`),
    );
    fake.lockedUntil = "2026-11-08";
    const posts = () => fake.requests.filter((r) => r.method === "POST").length;
    const before = posts();
    const result = await run();
    expect(result).toMatchObject({ sent: 0, blocked: 1, waiting: 0 });
    // Stoppat före anropet: inget försök att bokföra i den låsta perioden.
    expect(posts()).toBe(before);
    const row = (await outbox()).find((r) => r.state === "blocked")!;
    lockedId = row.id;
    expect(row.block_code).toBe("locked_period");
    expect(row.block_detail).toBe(
      "Perioden är låst i Fortnox till och med 2026-11-08. Verifikatet är daterat 2026-11-05. Lås upp perioden i Fortnox, eller bokför det för hand.",
    );
    expect(await openAlerts()).toEqual(["fortnox:atgard"]);
    // Larmet syns för ägare och admin, inte för läsare, påfyllare eller Enkel vy.
    const sees = (v: Viewer) =>
      asUser({ id: v.user.userId, email: v.user.email }, async (tx) =>
        (
          await rows<{ incident_key: string }>(
            tx,
            sql`select incident_key from public.alerts
                where organization_id = ${orgId}::uuid and incident_key like 'fortnox:%'`,
          )
        ).map((r) => r.incident_key),
      );
    expect(await sees(owner)).toEqual(["fortnox:atgard"]);
    expect(await sees(admin)).toEqual(["fortnox:atgard"]);
    for (const v of [reader, refiller, simpleAdmin, outsider]) expect(await sees(v)).toEqual([]);
    const view = await loadFortnoxFor(owner, NOW);
    expect(view?.line.tone).toBe("warn");
    expect(view?.line.text).toMatch(/^Fortnox: 1 verifikat är stoppat\. Perioden är låst/);
    expect(fake.vouchers).toHaveLength(7);
  });

  it("Fortnox eget nej till en låst period (om låset sätts mellan kontrollen och anropet) stoppar också", async () => {
    // Kontrollen ser ingen låst period, men Fortnox nekar verifikatet.
    fake.lockedUntil = null;
    fake.failNext.push({
      status: 400,
      path: /^\/3\/vouchers$/,
      body: { ErrorInformation: { error: 1, message: "Perioden är låst.", code: 2000401 } },
    });
    const result = await run();
    expect(result).toMatchObject({ sent: 0, blocked: 1 });
    const row = (await outbox()).find((r) => r.id === lockedId)!;
    expect(row).toMatchObject({ state: "blocked", block_code: "locked_period" });
    expect(fake.vouchers).toHaveLength(7);
  });

  it("när perioden låses upp bokförs verifikatet nästa natt och larmet stängs", async () => {
    const result = await run();
    expect(result).toMatchObject({ sent: 1, blocked: 0, waiting: 0, error: null });
    expect((await outbox()).find((r) => r.id === lockedId)).toMatchObject({
      state: "sent",
      block_code: null,
    });
    expect(await openAlerts()).toEqual([]);
    expect(fake.vouchers).toHaveLength(8);
  });

  it("ett konto som saknas i Fortnox stoppar med kontots nummer", async () => {
    const [store5] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Fem", address: "Storgatan 5" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store5!.id}::uuid, '2026-10-01', 60000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-09'
                     where organization_id = ${orgId}::uuid and store_id = ${store5!.id}::uuid`),
    );
    fake.accounts.delete(2990);
    const result = await run();
    expect(result).toMatchObject({ sent: 0, blocked: 1 });
    const row = (await outbox()).find((r) => r.state === "blocked")!;
    expect(row.block_code).toBe("unknown_account");
    expect(row.block_detail).toMatch(/^Konto 2990 finns inte/);
    expect(await openAlerts()).toEqual(["fortnox:atgard"]);
    // Ett inaktivt konto stoppar på samma sätt.
    fake.accounts.set(2990, false);
    expect(await run()).toMatchObject({ sent: 0, blocked: 1 });
    fake.accounts.set(2990, true);
    expect(await run()).toMatchObject({ sent: 1, blocked: 0 });
    expect(await openAlerts()).toEqual([]);
    expect(fake.vouchers).toHaveLength(9);
  });

  it("en serie som saknas i Fortnox stoppar, och rätt serie släpper", async () => {
    const [store6] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Sex", address: "Storgatan 6" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store6!.id}::uuid, '2026-10-01', 50000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-09'
                     where organization_id = ${orgId}::uuid and store_id = ${store6!.id}::uuid`),
    );
    await settings("2026-10", DEFAULT_MAPPING, "BL");
    expect(await run()).toMatchObject({ sent: 0, blocked: 1 });
    expect((await outbox()).find((r) => r.state === "blocked")!.block_detail).toMatch(
      /^Verifikationsserien BL finns inte i Fortnox/,
    );
    await settings("2026-10", DEFAULT_MAPPING, "A");
    expect(await run()).toMatchObject({ sent: 1, blocked: 0 });
    expect(fake.vouchers).toHaveLength(10);
  });
});

describe("ett skickat verifikat ändras aldrig; rättelser är nya verifikat", () => {
  it("databasen vägrar ändra eller radera ett skickat verifikat, även för servern", async () => {
    const sent = (await outbox()).find((r) => r.idem_key === "sales:2026-10:v1")!;
    for (const q of [
      sql`update public.fortnox_vouchers set rows = '[{"account":"1580","amountOre":1,"text":"a"},{"account":"3000","amountOre":-1,"text":"a"}]'::jsonb
          where id = ${sent.id}::uuid`,
      sql`update public.fortnox_vouchers set fortnox_number = 999 where id = ${sent.id}::uuid`,
      sql`update public.fortnox_vouchers set state = 'pending', fortnox_number = null,
            fortnox_series = null, fortnox_year = null, sent_at = null where id = ${sent.id}::uuid`,
      sql`update public.fortnox_vouchers set idem_key = 'sales:2026-10:v9' where id = ${sent.id}::uuid`,
      sql`delete from public.fortnox_vouchers where id = ${sent.id}::uuid`,
    ]) {
      const outcome = await asPostgres((tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("42501");
    }
    // Samma Fortnox-nummer kan inte stå på två rader.
    const dup = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`
          insert into public.fortnox_vouchers
            (organization_id, idem_key, kind, source_ref, voucher_date, description, rows, fingerprint,
             state, sent_at, fortnox_series, fortnox_number, fortnox_year)
          select organization_id, 'sales:2026-12:v1', 'sales', '2026-12', voucher_date, description, rows,
                 fingerprint, 'sent', now(), fortnox_series, fortnox_number, fortnox_year
          from public.fortnox_vouchers where id = ${sent.id}::uuid`),
      ),
    );
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("23505");
  });

  it("underlaget ändras efter att det skickats: ägaren får veta, inget ändras i Fortnox", async () => {
    // Utbetalningen arkiveras (t.ex. fel rapport). Verifikatet ligger kvar i Fortnox.
    const payout = (
      await rows<{ id: string }>(
        db(),
        sql`select id::text as id from public.payouts where organization_id = ${orgId}::uuid`,
      )
    )[0]!;
    await archivePayoutFor(owner, { id: payout.id, note: "Fel rapport, test" });
    const result = await run();
    expect(result).toMatchObject({ sent: 0, blocked: 0 });
    expect(fake.vouchers).toHaveLength(10);
    const view = await loadFortnoxFor(owner, NOW);
    expect(view?.changed.map((c) => [c.row.kind, c.reason])).toEqual([["payout", "gone"]]);
    expect(view?.line.text).toBe(
      "Fortnox: 1 verifikat har ändrats här efter att det bokfördes. Se listan och välj Rätta.",
    );
  });

  it("Rätta: ett nytt verifikat vänder det gamla, en gång", async () => {
    const view = await loadFortnoxFor(owner, NOW);
    const target = view!.changed[0]!.row;
    // Läsaren och en annan organisation får inte, inte heller direkt i databasen.
    for (const v of [reader, simpleAdmin, outsider]) {
      const direct = await asUser({ id: v.user.userId, email: v.user.email }, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.fortnox_request_reversal(${orgId}::uuid, ${target.id}::uuid)`,
          ),
        ),
      );
      expect(direct.ok).toBe(false);
      expect(direct.code).toBe("42501");
    }
    await requestFortnoxReversalFor(admin, target.id);
    await requestFortnoxReversalFor(owner, target.id);
    const reversals = (await outbox()).filter((r) => r.reverses_id === target.id);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.idem_key).toBe(`${target.idemKey}:rev`);
    expect(await run()).toMatchObject({ sent: 1, blocked: 0 });
    expect((await run()).sent).toBe(0);
    expect(fake.vouchers).toHaveLength(11);
    const reversed = posted().at(-1)!;
    expect(reversed.date).toBe("2026-11-16");
    expect(reversed.description).toMatch(/^Rättelse av A \d+: Utbetalning Nayax 2026-10/);
    expect(reversed.rows).toEqual([
      [1930, 0, 7_233_048],
      [6040, 0, 304_980],
      [6570, 0, 4_000],
      [6590, 0, 82_472],
      [1580, 7_624_500, 0],
    ]);
    // Originalet står orört i Fortnox och i utkorgen.
    expect(
      posted().filter((v) => v.description.startsWith("Utbetalning Nayax 2026-10")),
    ).toHaveLength(1);
    const after = await loadFortnoxFor(owner, NOW);
    expect(after?.changed).toEqual([]);
    expect(after?.line.tone).toBe("ok");
    // En vändning vänds inte, och ett verifikat som inte är skickat kan inte vändas.
    await expect(requestFortnoxReversalFor(owner, reversals[0]!.id)).rejects.toThrow();
  });

  it("samma rapport laddas upp igen: en ny utbetalning bokförs en gång", async () => {
    await importNayaxStatementFor(
      owner,
      { name: "Reimbursement Statement.pdf", bytes: octoberPdf() },
      { fileStore: files },
    );
    expect(await run()).toMatchObject({ sent: 1, blocked: 0 });
    expect((await run()).sent).toBe(0);
    expect(fake.vouchers).toHaveLength(12);
    // Netto på 1580 i Fortnox efter allt: försäljningen debet, första utbetalningen kredit,
    // vändningen debet, den nya utbetalningen kredit = 0.
    const on1580 = fake.vouchers
      .flatMap((v) => v.rows)
      .filter((r) => r.account === 1580)
      .reduce((n, r) => n + r.debit - r.credit, 0);
    expect(on1580).toBe(0);
  });

  it("ett vänt verifikat vars underlag finns kvar får en ny version (v2) när vändningen är bokförd", async () => {
    const sales = (await outbox()).find((r) => r.idem_key === "sales:2026-10:v1")!;
    await requestFortnoxReversalFor(owner, sales.id);
    // Körning 1: vändningen bokförs. Den nya versionen läggs inte upp förrän den är inne.
    expect(await run()).toMatchObject({ sent: 1 });
    expect((await outbox()).some((r) => r.idem_key === "sales:2026-10:v2")).toBe(false);
    // Körning 2: v2 läggs upp och bokförs. Körning 3: inget mer.
    expect(await run()).toMatchObject({ sent: 1 });
    expect((await run()).sent).toBe(0);
    expect(
      (await outbox()).filter((r) => r.kind === "sales").map((r) => [r.idem_key, r.state]),
    ).toEqual([
      ["sales:2026-10:v1", "sent"],
      ["sales:2026-10:v1:rev", "sent"],
      ["sales:2026-10:v2", "sent"],
    ]);
    expect(fake.vouchers).toHaveLength(14);
    // Försäljningen står kvar en gång på 3000: kredit, debet (vändning), kredit.
    const on3000 = fake.vouchers
      .flatMap((v) => v.rows)
      .filter((r) => r.account === 3000)
      .reduce((n, r) => n + r.credit - r.debit, 0);
    expect(on3000).toBe(7_624_500);
  });
});

describe("kopplingen gäller inte längre", () => {
  it("Fortnox nekar refresh-token: inget går förlorat, ägaren får ett larm", async () => {
    const [store7] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Sju", address: "Storgatan 7" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store7!.id}::uuid, '2026-10-01', 40000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-12'
                     where organization_id = ${orgId}::uuid and store_id = ${store7!.id}::uuid`),
    );
    fake.revokeAll();
    const result = await run();
    expect(result).toMatchObject({ status: "needs_reconnect", sent: 0, waiting: 1 });
    expect((await connection())?.status).toBe("needs_reconnect");
    expect(await openAlerts()).toEqual(["fortnox:koppling"]);
    expect(fake.vouchers).toHaveLength(14);
    const view = await loadFortnoxFor(owner, NOW);
    expect(view?.line.text).toBe("Fortnox: kopplingen gäller inte längre. Koppla Fortnox igen.");
    // Nästa natt: ingen ny kontakt med Fortnox förrän ägaren kopplat igen.
    const calls = fake.tokenRequests.length;
    expect((await run()).status).toBe("needs_reconnect");
    expect(fake.tokenRequests.length).toBe(calls);
  });

  it("ett annat bolag i Fortnox nekas när verifikat redan har skickats", async () => {
    fake.databaseNumber = 999_999;
    await expect(connect(owner)).rejects.toThrow(/ett annat bolag/);
    expect((await connection())?.status).toBe("needs_reconnect");
    fake.databaseNumber = 123_456;
  });

  it("ägaren kopplar igen: det som väntade bokförs, inget dubbelt, larmet stängs", async () => {
    expect(await connect(owner)).toEqual({ companyName: "Testbolaget AB", reconnected: true });
    expect(await connection()).toMatchObject({ status: "connected", live: true });
    const result = await run();
    expect(result).toMatchObject({ status: "ran", sent: 1, waiting: 0, blocked: 0 });
    expect(fake.vouchers).toHaveLength(15);
    expect(await openAlerts()).toEqual([]);
    expect((await run()).sent).toBe(0);
  });
});

describe("koppla från", () => {
  it("token raderas ur Vault; utkorgen står kvar som historik", async () => {
    const sentBefore = (await outbox()).filter((r) => r.state === "sent").length;
    await disconnectFortnoxFor(owner);
    expect(await connection()).toBeNull();
    expect(await readTokens(db(), orgId)).toBeNull();
    const left = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from vault.secrets where name = ${`${orgId}/fortnox`}`,
    );
    expect(left[0]!.n).toBe(0);
    expect((await outbox()).filter((r) => r.state === "sent")).toHaveLength(sentBefore);
    expect((await run()).status).toBe("not_connected");
    // Kopplar ägaren igen börjar det i torrkörning, och inget redan skickat skickas om.
    await connect(owner);
    expect(await connection()).toMatchObject({ live: false, start_month: null });
    await settings("2026-10");
    expect(await run()).toMatchObject({ status: "dry_run", wouldSend: 0 });
    await setFortnoxLiveFor(owner, true);
    expect(await run()).toMatchObject({ status: "ran", sent: 0 });
    expect(fake.vouchers).toHaveLength(15);
  });
});

describe("sorter som stängs av, underlag som inte är klart och saknad rättighet", () => {
  const withKinds = (kinds: Partial<typeof DEFAULT_MAPPING.kinds>) =>
    settings("2026-10", { ...DEFAULT_MAPPING, kinds: { ...DEFAULT_MAPPING.kinds, ...kinds } });

  it("inköpsvärdet skickas först när ägaren slagit på det: D 4960 / K 1460", async () => {
    const before = fake.vouchers.length;
    expect((await run()).sent).toBe(0);
    await withKinds({ cogs: true });
    expect(await run()).toMatchObject({ sent: 1, blocked: 0 });
    const v = posted().at(-1)!;
    expect(v.description).toMatch(/^Inköpsvärde sålda pack oktober 2026/);
    // Tre order i oktober med inköpspris 20,00 kr: 60,00 kr.
    expect(v.rows).toEqual([
      [4960, 6_000, 0],
      [1460, 0, 6_000],
    ]);
    expect(fake.vouchers).toHaveLength(before + 1);
  });

  it("en sort som stängs av innan verifikatet hunnit skickas dras tillbaka och larmet stängs", async () => {
    const before = fake.vouchers.length;
    await asUser(ownerUser, (tx) =>
      tx.insert(s.fixedCosts).values({
        organizationId: orgId,
        name: "Försäkring",
        category: "insurance",
        amountOre: 30_000,
        interval: "month",
        startsOn: "2026-10-01",
      }),
    );
    fake.lockedUntil = "2026-12-31";
    await withKinds({ cogs: true, fixed_costs: true });
    expect(await run()).toMatchObject({ sent: 0, blocked: 1 });
    expect(await openAlerts()).toEqual(["fortnox:atgard"]);
    // Ägaren ångrar sig och stänger av fasta kostnader.
    await withKinds({ cogs: true, fixed_costs: false });
    expect(await run()).toMatchObject({ sent: 0, blocked: 0, waiting: 0 });
    const row = (await outbox()).find((r) => r.idem_key === "fixed_costs:2026-10:v1")!;
    expect(row).toMatchObject({ state: "blocked", block_code: "withdrawn" });
    expect(await openAlerts()).toEqual([]);
    fake.lockedUntil = null;
    // Avstängd sort skickas inte, även när perioden är öppen igen.
    expect((await run()).sent).toBe(0);
    expect(fake.vouchers).toHaveLength(before);
  });

  it("saknas rättigheten hos Fortnox stoppas verifikatet med ett larm, och bokförs när den finns", async () => {
    const before = fake.vouchers.length;
    await withKinds({ cogs: true, fixed_costs: true });
    fake.failNext.push({
      status: 403,
      path: /^\/3\/financialyears$/,
      body: { ErrorInformation: { error: 1, message: "Api-licens saknas.", code: 2001103 } },
    });
    const denied = await run();
    expect(denied).toMatchObject({ sent: 0, blocked: 1 });
    const row = (await outbox()).find((r) => r.idem_key === "fixed_costs:2026-10:v1")!;
    expect(row).toMatchObject({ state: "blocked", block_code: "forbidden" });
    expect(row.block_detail).toMatch(/rättigheten eller licensen för bokföring saknas/);
    expect(await openAlerts()).toEqual(["fortnox:atgard"]);
    expect(fake.vouchers).toHaveLength(before);
    expect(await run()).toMatchObject({ sent: 1, blocked: 0 });
    expect(posted().at(-1)!.rows).toEqual([
      [6990, 30_000, 0],
      [2990, 0, 30_000],
    ]);
    expect(await openAlerts()).toEqual([]);
    expect((await run()).sent).toBe(0);
    expect(fake.vouchers).toHaveLength(before + 1);
  });

  it("når jobbet inte Fortnox tre gånger i rad får ägaren ett larm, som stängs när det går igen", async () => {
    const [store] = await asUser(ownerUser, (tx) =>
      tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Tio", address: "Storgatan 10" })
        .returning(),
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.store_settlements
                       (organization_id, store_id, month, amount_ore, statement, calc_version)
                     values (${orgId}::uuid, ${store!.id}::uuid, '2026-10-01', 7000, '{}'::jsonb, 'test')`),
    );
    await asUser(ownerUser, (tx) =>
      tx.execute(sql`update public.store_settlements set paid_on = '2026-11-12'
                     where organization_id = ${orgId}::uuid and store_id = ${store!.id}::uuid`),
    );
    const before = fake.vouchers.length;
    for (const expected of [[], [], ["fortnox:fel"]]) {
      fake.failNext.push({ status: 503, path: /^\/3\/financialyears$/ });
      const r = await run();
      expect(r).toMatchObject({ status: "ran", sent: 0, waiting: 1 });
      expect(r.error).toMatch(/Fortnox nåddes inte/);
      expect(await openAlerts()).toEqual(expected);
    }
    expect(fake.vouchers).toHaveLength(before);
    expect(await run()).toMatchObject({ sent: 1, waiting: 0, error: null });
    expect(await openAlerts()).toEqual([]);
    expect(fake.vouchers).toHaveLength(before + 1);
  });

  it("går bolaget inte att läsa vid en ny koppling nekas den när verifikat redan har skickats", async () => {
    const before = await readTokens(db(), orgId);
    fake.failNext.push({ status: 500, path: /^\/3\/companyinformation$/ });
    await expect(connect(owner)).rejects.toMatchObject({ code: "okant_bolag" });
    expect(await readTokens(db(), orgId)).toEqual(before);
    expect((await connection())?.status).toBe("connected");
  });
});
