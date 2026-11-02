/**
 * Röd granskning fas 7: databasen bortom det som catalog.test.ts, rls-*.test.ts och
 * redteam-beh-righet.test.ts redan täcker.
 *
 *   1. Ändringsloggen och append-only-tabellerna kan inte kringgås: inte med
 *      session_replication_role, inte genom att stänga av triggers, och
 *      gallringsflaggan binderlab.allow_purge gäller bara systemet.
 *      (Rollbyte med SET ROLE prövas inte här: testanslutningen är databasägaren, och
 *      i appen kan en klient bara nå SQL via parametriserade frågor; se
 *      src/server/redteam-fas7.test.ts om sql.raw.)
 *   2. Bucketen contracts (avtalsfiler) har samma skydd som imports och reports, och
 *      ingen bucket har policyer för att skriva över eller radera filer.
 *   3. Klientroller når inga serverfunktioner för filer eller andras frågor
 *      (pg_read_file, lo_import, pg_stat_activity).
 *
 * Konvention: `it.fails("HÅL …")` beskriver det säkra beteendet för ett hål som
 * granskningen hittade och som inte är åtgärdat. När hålet täpps börjar testet
 * fallera; byt då till `it`.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "../../src/db/client";
import {
  asServiceRole,
  asUser,
  attempt,
  createMember,
  db,
  one,
  rollback,
  rows,
  seedTenantFixture,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let A: TenantFixture;
let B: TenantFixture;
let admin: TestUser;
let viewer: TestUser;
let refiller: TestUser;
let storeUser: TestUser;

beforeAll(async () => {
  A = await seedTenantFixture();
  B = await seedTenantFixture();
  admin = await createMember(A.orgId, "admin");
  viewer = await createMember(A.orgId, "viewer");
  refiller = await createMember(A.orgId, "refiller");
  storeUser = await one<{ id: string; email: string }>(
    db(),
    sql`select u.id, u.email::text as email from public.memberships m
        join auth.users u on u.id = m.user_id
        where m.organization_id = ${A.orgId} and m.role = 'store' limit 1`,
  );
}, 120_000);

async function codeOf(user: TestUser, query: ReturnType<typeof sql>): Promise<string> {
  const outcome = await asUser(user, (tx) => attempt(tx, (sp) => sp.execute(query)));
  return outcome.ok ? "ok" : outcome.code;
}

async function serviceCode(fn: (tx: Tx) => Promise<unknown>): Promise<string> {
  const outcome = await asServiceRole((tx) => attempt(tx, (sp) => fn(sp)));
  return outcome.ok ? "ok" : outcome.code;
}

// ---------------------------------------------------------------------------
// 1. Ändringsloggen och append-only
// ---------------------------------------------------------------------------

describe("ändringsloggen och append-only kan inte kringgås", () => {
  it("ingen klientroll kan sätta session_replication_role (som stänger av alla triggers)", async () => {
    expect(await codeOf(A.owner, sql`set local session_replication_role = replica`)).toBe("42501");
    expect(
      await serviceCode((tx) => tx.execute(sql`set local session_replication_role = replica`)),
    ).toBe("42501");
  });

  it("ingen klientroll kan stänga av triggers på audit_log eller ekonomiska tabeller", async () => {
    for (const table of ["audit_log", "orders", "purchase_prices", "stock_events"]) {
      const stmt = sql.raw(`alter table public.${table} disable trigger all`);
      expect(await codeOf(A.owner, stmt), table).toBe("42501");
      expect(await serviceCode((tx) => tx.execute(stmt)), table).toBe("42501");
    }
  });

  it("gallringsflaggan hjälper inte en inloggad användare (append-only och forbid_delete gäller)", async () => {
    const out = await asUser(A.owner, async (tx) => {
      await tx.execute(sql`select set_config('binderlab.allow_purge', 'on', true)`);
      return {
        audit: await attempt(tx, (sp) =>
          sp.execute(sql`delete from public.audit_log where organization_id = ${A.orgId}`),
        ),
        orders: await attempt(tx, (sp) =>
          sp.execute(sql`delete from public.orders where organization_id = ${A.orgId}`),
        ),
        events: await attempt(tx, (sp) =>
          sp.execute(sql`delete from public.stock_events where organization_id = ${A.orgId}`),
        ),
      };
    });
    expect(out.audit.ok).toBe(false);
    expect(out.orders.ok).toBe(false);
    expect(out.events.ok).toBe(false);
    const left = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders where organization_id = ${A.orgId}`,
    );
    expect(left.n).toBeGreaterThan(0);
  });

  /**
   * TÄPPT (var låg; 20261102193000_hardening_purge_owner_only.sql): private.purge_allowed() godtar varje roll utom anon och authenticated,
   * alltså även service_role (Supabase hemliga nyckel). Med flaggan satt kan
   * service_role radera bokföringsdata (order, lagerhändelser, godkännanden, assistentens
   * logg) trots att tabellerna är append-only/forbid_delete. Gallringen ska bara
   * kunna köras av systemet (databasägaren eller en egen gallringsroll).
   * Åtgärd: ny migrering där purge_allowed kräver current_user = 'postgres' (eller en
   * dedikerad roll) och flaggan, och revoke delete från service_role på append-only-tabeller.
   */
  it("TÄPPT: service_role med binderlab.allow_purge kan inte radera append-only- eller bokföringsdata", async () => {
    const results = await rollback(async (tx) => {
      await tx.execute(
        sql`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`,
      );
      await tx.execute(sql`set local role service_role`);
      await tx.execute(sql`select set_config('binderlab.allow_purge', 'on', true)`);
      const out: Record<string, string> = {};
      for (const table of [
        "orders",
        "stock_events",
        "report_approvals",
        "assistant_logs",
        "deviation_reviews",
      ]) {
        const o = await attempt(tx, (sp) =>
          sp.execute(
            sql`delete from ${sql.identifier("public")}.${sql.identifier(table)} where organization_id = ${A.orgId}`,
          ),
        );
        out[table] = o.ok ? "raderade" : o.code;
      }
      return out;
    });
    for (const [table, result] of Object.entries(results)) {
      expect(result, table).not.toBe("raderade");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Lagring: bucketen contracts och skrivskydd
// ---------------------------------------------------------------------------

function upload(user: TestUser, bucket: string, name: string) {
  return asUser(user, (tx) =>
    attempt(tx, (sp) =>
      sp.execute(
        sql`insert into storage.objects (bucket_id, name, owner) values (${bucket}, ${name}, ${user.id})`,
      ),
    ),
  );
}

describe("lagring", () => {
  it("contracts: läsaren, påfyllaren, butiken och en utomstående kan inte ladda upp i A", async () => {
    const name = `${A.orgId}/${A.contractId}/${"e".repeat(64)}.pdf`;
    for (const user of [viewer, refiller, storeUser, B.owner]) {
      const outcome = await upload(user, "contracts", name);
      expect(outcome.ok, user.email).toBe(false);
    }
  });

  it("contracts: påfyllaren, butiken och en utomstående ser inte A:s avtalsfiler", async () => {
    // Fixturens avtalsfil som ett objekt i bucketen (lagt av systemet).
    await db().execute(
      sql`insert into storage.objects (bucket_id, name) values ('contracts', ${`${A.orgId}/${A.contractId}/${"d".repeat(64)}.pdf`})
          on conflict do nothing`,
    );
    for (const user of [refiller, storeUser, B.owner]) {
      const seen = await asUser(user, (tx) =>
        rows(
          tx,
          sql`select name from storage.objects where bucket_id = 'contracts' and name like ${`${A.orgId}/%`}`,
        ),
      );
      expect(seen, user.email).toEqual([]);
    }
    const ownerSees = await asUser(A.owner, (tx) =>
      rows(
        tx,
        sql`select name from storage.objects where bucket_id = 'contracts' and name like ${`${A.orgId}/%`}`,
      ),
    );
    expect(ownerSees.length).toBeGreaterThan(0);
  });

  it("contracts: admin kan inte lägga en fil i B:s mapp eller med '..' i sökvägen", async () => {
    for (const name of [
      `${B.orgId}/${B.contractId}/${"f".repeat(64)}.pdf`,
      `${A.orgId}/../${B.orgId}/x.pdf`,
      `${A.orgId}/./x.pdf`,
      `${A.orgId}//x.pdf`,
    ]) {
      const outcome = await upload(admin, "contracts", name);
      expect(outcome.ok, name).toBe(false);
    }
  });

  it("ingen bucket har policyer för update eller delete (filer kan inte skrivas över eller raderas)", async () => {
    const policies = await rows<{ policyname: string; cmd: string }>(
      db(),
      sql`select policyname, cmd from pg_policies
          where schemaname = 'storage' and tablename = 'objects' and cmd in ('UPDATE', 'DELETE', 'ALL')`,
    );
    expect(policies).toEqual([]);
  });

  it("butiksrollen kan bara läsa sina egna butiksrapporter i reports, inget i imports eller contracts", async () => {
    const seen = await asUser(storeUser, (tx) =>
      rows<{ bucket_id: string; name: string }>(
        tx,
        sql`select bucket_id, name from storage.objects where bucket_id in ('imports', 'contracts')`,
      ),
    );
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Serverfunktioner och andras frågor
// ---------------------------------------------------------------------------

describe("serverfunktioner", () => {
  it.each([
    ["pg_read_file", sql`select pg_read_file('/etc/passwd')`],
    ["pg_ls_dir", sql`select pg_ls_dir('.')`],
    ["lo_import", sql`select lo_import('/etc/passwd')`],
    ["pg_reload_conf", sql`select pg_reload_conf()`],
    ["copy to program", sql`copy (select 1) to program 'id'`],
    ["create extension", sql`create extension if not exists dblink`],
  ])("authenticated kan inte köra %s", async (_name, stmt) => {
    expect(await codeOf(A.owner, stmt)).not.toBe("ok");
  });

  it("authenticated ser inte andra anslutningars frågor i pg_stat_activity", async () => {
    const visible = await asUser(A.owner, (tx) =>
      rows<{ query: string | null }>(
        tx,
        sql`select query from pg_stat_activity
            where pid <> pg_backend_pid() and backend_type = 'client backend'`,
      ),
    );
    for (const r of visible) {
      expect(r.query === null || r.query === "<insufficient privilege>").toBe(true);
    }
  });
});
