/**
 * Katalogtester: regler som ska gälla för VARJE tabell, vy och funktion.
 * Allt läses ur Postgres-katalogen, så en ny tabell som bryter mot reglerna
 * får testerna att fallera utan att någon behöver komma ihåg att lägga till den.
 */

import { is, sql } from "drizzle-orm";
import { getTableConfig, getViewConfig, PgEnumColumn, PgTable, PgView } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import {
  asAnon,
  attempt,
  db,
  orgScopedTables,
  publicColumns,
  publicTables,
  publicViews,
  rel,
  rows,
} from "./helpers";

const tables = await publicTables();
const views = await publicViews();
const scoped = await orgScopedTables();
const columns = await publicColumns();

const APPEND_ONLY = [
  "assistant_logs",
  "audit_log",
  "deviation_reviews",
  "import_rows",
  "payout_imports",
  "payout_lines",
  "report_approvals",
  "report_deliveries",
  "report_files",
  "stock_events",
  "voucher_deliveries",
];
const RPCS = [
  "accept_invitation",
  "attach_contract_file",
  "close_period",
  // Kom igång: första organisationen, med lås och medlemskapskontroll i databasen.
  "create_first_organization",
  "create_invitation",
  "create_organization",
  "create_store_invitation",
  // Lager (fas 5): visningsnamn för dem som registrerat lagerhändelser, alla roller.
  "lager_performers",
  // Lager (fas 7): sortimentets perioder per automat och titel, alla roller.
  "lager_slot_periods",
  "list_members",
  "merge_titles",
  "portal_agreements",
  "portal_faults",
  "portal_machines",
  "portal_report",
  "portal_report_fault",
  "portal_reports",
  "portal_sales",
  "portal_stores",
  // Att göra (fas 3): påfyllning med uttag från centrallagret (ägare, admin, påfyllare).
  "register_refill",
  "register_refill_once",
  "reopen_period",
  "sales_data_until",
];
/**
 * RPC:er som kör med anroparens rättigheter (security invoker) i stället för definer.
 * De kontrollerar rollen själva och läser via en definer-funktion i private som har
 * samma kontroll (20261102150500_drift_sales_last_order.sql).
 */
const INVOKER_RPCS = ["sales_data_until"];

function columnsOf(table: string) {
  return columns.filter((c) => c.table === table);
}

describe("tabeller", () => {
  it("katalogen innehåller alla tabeller i datamodell v2", () => {
    expect(tables).toEqual(
      [
        "alert_deliveries",
        "alert_runs",
        "alert_subscriptions",
        "alerts",
        "assistant_logs",
        "assortment_changes",
        "audit_log",
        "baselines",
        "contracts",
        "data_sources",
        "deviation_reviews",
        "effect_measurements",
        "effect_settings",
        "expansion_leads",
        "field_submissions",
        "fixed_costs",
        "goals",
        "import_rows",
        // Datakällor: mellanlagring av uppladdningar (tillfälliga rader).
        "import_upload_chunks",
        "import_uploads",
        "imports",
        "incidents",
        "invitations",
        "ledger_accounts",
        "machine_investments",
        "machine_placements",
        "machine_slots",
        "machines",
        "memberships",
        "orders",
        "organization_settings",
        "organizations",
        "owner_shares",
        "payout_imports",
        "payout_lines",
        "payouts",
        "period_closes",
        "profiles",
        "purchase_order_lines",
        "purchase_orders",
        "purchase_prices",
        "price_experiment_machines",
        "price_experiments",
        "push_subscriptions",
        "release_allocations",
        "releases",
        "report_approvals",
        "report_deliveries",
        "report_files",
        "report_recipients",
        "reports",
        "source_machines",
        "stock_events",
        "stock_locations",
        "store_agreements",
        "stores",
        "supplier_items",
        "supplier_price_quotes",
        "suppliers",
        "title_aliases",
        "titles",
        // Att göra: avbockade punkter (20261102113602_att_gora_todo_dismissals.sql).
        "todo_dismissals",
        "voucher_deliveries",
      ].sort(),
    );
    expect(scoped).toEqual(tables.filter((t) => t !== "organizations"));
  });

  it.each(tables)(
    "%s har RLS påslaget och minst en select-policy för authenticated",
    async (table) => {
      const [info] = await rows<{ rls: boolean; policies: number }>(
        db(),
        sql`select c.relrowsecurity as rls,
                 (select count(*)::int from pg_policies p
                   where p.schemaname = 'public' and p.tablename = c.relname
                     and p.cmd in ('SELECT', 'ALL')) as policies
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = ${table}`,
      );
      expect(info?.rls).toBe(true);
      expect(info?.policies).toBeGreaterThan(0);
    },
  );

  it.each(scoped)(
    "%s har forbid_org_change-trigger, unique (organization_id, id) och FK till organizations",
    async (table) => {
      const triggers = await rows<{ name: string }>(
        db(),
        sql`select t.tgname as name from pg_trigger t
          join pg_proc p on p.oid = t.tgfoid
          join pg_namespace pn on pn.oid = p.pronamespace
          where t.tgrelid = ${`public.${table}`}::regclass
            and not t.tgisinternal
            and pn.nspname = 'private' and p.proname = 'forbid_org_change'
            and (t.tgtype & 2) = 2   -- before
            and (t.tgtype & 16) = 16 -- update
            and (t.tgtype & 1) = 1   -- for each row`,
      );
      expect(triggers.length).toBe(1);

      const uniques = await rows<{ cols: string[] }>(
        db(),
        sql`select array(select a.attname::text from unnest(con.conkey) k(n)
                       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n
                       order by a.attname) as cols
          from pg_constraint con
          where con.conrelid = ${`public.${table}`}::regclass and con.contype in ('u', 'p')`,
      );
      expect(uniques.map((u) => u.cols.join(","))).toContain("id,organization_id");

      const orgFk = await rows<{ deltype: string }>(
        db(),
        sql`select con.confdeltype::text as deltype from pg_constraint con
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
          where con.conrelid = ${`public.${table}`}::regclass and con.contype = 'f'
            and con.confrelid = 'public.organizations'::regclass
            and array_length(con.conkey, 1) = 1 and a.attname = 'organization_id'`,
      );
      expect(orgFk.length).toBe(1);
      expect(orgFk[0]!.deltype).toBe("r"); // on delete restrict
    },
  );

  it("FK:er mellan organisationsdata är sammansatta och nollar aldrig organization_id", async () => {
    const fks = await rows<{
      name: string;
      table: string;
      ref: string;
      cols: string[];
      refcols: string[];
      deltype: string;
      setcols: string[];
    }>(
      db(),
      sql`select con.conname as name, cl.relname as table, rf.relname as ref,
                 array(select a.attname::text from unnest(con.conkey) with ordinality k(n, i)
                       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i) as cols,
                 array(select a.attname::text from unnest(con.confkey) with ordinality k(n, i)
                       join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i) as refcols,
                 con.confdeltype::text as deltype,
                 array(select a.attname::text from unnest(coalesce(con.confdelsetcols, '{}')) k(n)
                       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as setcols
          from pg_constraint con
          join pg_class cl on cl.oid = con.conrelid
          join pg_namespace n on n.oid = cl.relnamespace
          join pg_class rf on rf.oid = con.confrelid
          join pg_namespace rn on rn.oid = rf.relnamespace
          where n.nspname = 'public' and rn.nspname = 'public' and con.contype = 'f'
            and rf.relname <> 'organizations'`,
    );
    const problems: string[] = [];
    for (const fk of fks) {
      if (!scoped.includes(fk.table) || !scoped.includes(fk.ref)) {
        continue;
      }
      if (
        fk.cols.length !== 2 ||
        fk.cols[0] !== "organization_id" ||
        fk.refcols[0] !== "organization_id" ||
        fk.refcols[1] !== "id"
      ) {
        problems.push(`${fk.name}: inte (organization_id, x) → (organization_id, id)`);
      }
      if (
        ["n", "d"].includes(fk.deltype) &&
        (fk.setcols.length === 0 || fk.setcols.includes("organization_id"))
      ) {
        problems.push(`${fk.name}: on delete set null/default utan kolumnlista`);
      }
      if (fk.deltype === "c") {
        problems.push(`${fk.name}: on delete cascade mellan organisationsdata`);
      }
    }
    expect(fks.length).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  it.each(tables.filter((t) => t !== "audit_log"))(
    "%s har created_at/created_by och stämplas av triggers",
    async (table) => {
      const names = columnsOf(table).map((c) => c.column);
      expect(names).toContain("created_at");
      expect(names).toContain("created_by");
      const triggerFns = await rows<{ fn: string }>(
        db(),
        sql`select p.proname as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = ${`public.${table}`}::regclass and not t.tgisinternal`,
      );
      const fns = triggerFns.map((t) => t.fn);
      expect(fns).toContain("stamp_insert");
      if (APPEND_ONLY.includes(table)) {
        expect(names).not.toContain("updated_at");
        expect(fns).not.toContain("stamp_update");
      } else {
        expect(names).toContain("updated_at");
        expect(fns).toContain("stamp_update");
      }
    },
  );

  it.each(APPEND_ONLY)(
    "%s är append-only (trigger, ingen truncate, inga update/delete-rättigheter)",
    async (table) => {
      const triggerFns = await rows<{ fn: string }>(
        db(),
        sql`select p.proname as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = ${`public.${table}`}::regclass and not t.tgisinternal`,
      );
      const fns = triggerFns.map((t) => t.fn);
      expect(fns).toContain("forbid_mutation");
      expect(fns).toContain("forbid_truncate");
      const [privs] = await rows<{ upd: boolean; del: boolean }>(
        db(),
        sql`select has_table_privilege('authenticated', ${`public.${table}`}, 'UPDATE') as upd,
                 has_table_privilege('authenticated', ${`public.${table}`}, 'DELETE') as del`,
      );
      expect(privs).toEqual({ upd: false, del: false });
    },
  );

  it("audit_log kan inte skrivas av någon klientroll, inte ens service_role", async () => {
    const [privs] = await rows<Record<string, boolean>>(
      db(),
      sql`select
            has_table_privilege('authenticated', 'public.audit_log', 'INSERT') as a_ins,
            has_table_privilege('authenticated', 'public.audit_log', 'UPDATE') as a_upd,
            has_table_privilege('authenticated', 'public.audit_log', 'DELETE') as a_del,
            has_table_privilege('service_role', 'public.audit_log', 'INSERT') as s_ins,
            has_table_privilege('service_role', 'public.audit_log', 'UPDATE') as s_upd,
            has_table_privilege('service_role', 'public.audit_log', 'DELETE') as s_del`,
    );
    expect(Object.values(privs!).every((v) => v === false)).toBe(true);
  });

  it("ingen klientroll har TRUNCATE, REFERENCES eller TRIGGER på någon tabell", async () => {
    const bad = await rows<{ grantee: string; table: string; privilege: string }>(
      db(),
      sql`select grantee, table_name as table, privilege_type as privilege
          from information_schema.role_table_grants
          where table_schema = 'public'
            and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
            and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')`,
    );
    expect(bad).toEqual([]);
  });
});

describe("vyer", () => {
  it("vyerna finns", () => {
    expect(views).toEqual(["purchase_price_periods", "stock_levels", "warehouse_stock"]);
  });

  it.each(views)("%s har security_invoker = true och organization_id", async (view) => {
    const [info] = await rows<{ options: string[] | null }>(
      db(),
      sql`select c.reloptions as options from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = ${view}`,
    );
    expect(info?.options ?? []).toContain("security_invoker=true");
    expect(columnsOf(view).map((c) => c.column)).toContain("organization_id");
  });
});

describe("funktioner", () => {
  it("varje security definer-funktion har search_path = '' och kan inte köras av anon/public", async () => {
    const fns = await rows<{
      name: string;
      config: string[] | null;
      anon: boolean;
      public_exec: boolean;
    }>(
      db(),
      sql`select n.nspname || '.' || p.proname as name, p.proconfig as config,
                 has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                 coalesce(aclcontains(p.proacl, makeaclitem(0, p.proowner, 'EXECUTE', false)), true) as public_exec
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private') and p.prosecdef`,
    );
    expect(fns.length).toBeGreaterThan(15);
    const problems = fns.flatMap((f) => [
      ...(f.config?.includes('search_path=""') ? [] : [`${f.name}: search_path saknas`]),
      ...(f.anon ? [`${f.name}: anon kan köra`] : []),
      ...(f.public_exec ? [`${f.name}: PUBLIC kan köra`] : []),
    ]);
    expect(problems).toEqual([]);
  });

  it("alla funktioner i private har search_path satt", async () => {
    const missing = await rows<{ name: string }>(
      db(),
      sql`select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and not coalesce(p.proconfig @> array['search_path=""'], false)`,
    );
    expect(missing).toEqual([]);
  });

  it("public innehåller bara RPC:erna, körbara av authenticated men inte anon", async () => {
    const fns = await rows<{ name: string; auth: boolean; anon: boolean; definer: boolean }>(
      db(),
      sql`select p.proname as name,
                 has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
                 has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                 p.prosecdef as definer
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
          order by p.proname`,
    );
    expect(fns.map((f) => f.name)).toEqual(RPCS);
    const problems = fns.flatMap((f) => [
      ...(f.auth ? [] : [`${f.name}: authenticated kan inte köra`]),
      ...(f.anon ? [`${f.name}: anon kan köra`] : []),
      ...(f.definer === !INVOKER_RPCS.includes(f.name)
        ? []
        : [`${f.name}: ${f.definer ? "security definer" : "security invoker"} oväntat`]),
    ]);
    expect(problems).toEqual([]);
  });
});

describe("policyer", () => {
  it("alla policyer i public gäller authenticated och läser auth.uid() via (select ...)", async () => {
    const policies = await rows<{
      table: string;
      name: string;
      roles: string[];
      qual: string | null;
      check: string | null;
    }>(
      db(),
      sql`select tablename as table, policyname as name, roles::text[] as roles, qual, with_check as check
          from pg_policies where schemaname = 'public'`,
    );
    expect(policies.length).toBeGreaterThan(80);
    const problems: string[] = [];
    for (const p of policies) {
      if (p.roles.join(",") !== "authenticated") {
        problems.push(`${p.table}.${p.name}: roller ${p.roles.join(",")}`);
      }
      for (const expr of [p.qual, p.check]) {
        const bare = (expr ?? "").replace(/SELECT auth\.uid\(\)/g, "").includes("auth.uid()");
        if (bare) {
          problems.push(`${p.table}.${p.name}: auth.uid() utan (select ...)`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("påfyllaren nämns bara i tillåtlistade tabellers policyer", async () => {
    const policies = await rows<{ table: string; expr: string }>(
      db(),
      sql`select tablename as table, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
          from pg_policies where schemaname = 'public' and cmd = 'SELECT'`,
    );
    const withRefiller = [
      ...new Set(policies.filter((p) => p.expr.includes("'refiller'")).map((p) => p.table)),
    ].sort();
    // memberships saknas med flit: påfyllaren ser sitt eget medlemskap via user_id, inte via rollen.
    expect(withRefiller).toEqual([
      // Fas 8: egna rader (prenumerationer, push, utskick, inskick) och larm om automater/lager.
      "alert_deliveries",
      "alert_subscriptions",
      "alerts",
      // Fas 6b: påfyllarens egna frågor till assistenten (bara lagerdata).
      "assistant_logs",
      "field_submissions",
      "machine_placements",
      "machines",
      "organizations",
      "profiles",
      "push_subscriptions",
      "stock_events",
      "stock_locations",
      "stores",
      "title_aliases",
      "titles",
      // Fas 3 Att göra: bara avbockningar av lagerpunkter (refill:, stale-machine:), utan belopp.
      "todo_dismissals",
    ]);
  });
});

describe("anon", () => {
  it("har inga rättigheter på någon tabell eller vy", async () => {
    const granted = await rows<{ name: string }>(
      db(),
      sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
            and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
              or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))`,
    );
    expect(granted).toEqual([]);
  });

  it.each([...tables, ...views])("select på %s ger permission denied", async (relation) => {
    const outcome = await asAnon((tx) =>
      attempt(tx, (sp) => sp.execute(sql`select count(*) from ${rel(relation)}`)),
    );
    expect(outcome.code).toBe("42501");
  });

  it.each(RPCS)("kan inte köra %s", async (fn) => {
    const args: Record<string, ReturnType<typeof sql>> = {
      accept_invitation: sql`'x'`,
      attach_contract_file: sql`gen_random_uuid(), gen_random_uuid(), 'x', 'x', 'application/pdf', 1::bigint, 'x'`,
      close_period: sql`gen_random_uuid(), '2025-01-01'::date`,
      create_first_organization: sql`'x', 'x'`,
      create_invitation: sql`gen_random_uuid(), 'a@b.se', 'viewer'`,
      create_organization: sql`'x', 'x'`,
      create_store_invitation: sql`gen_random_uuid(), gen_random_uuid(), 'a@b.se'`,
      lager_performers: sql`gen_random_uuid()`,
      lager_slot_periods: sql`gen_random_uuid()`,
      list_members: sql`gen_random_uuid()`,
      merge_titles: sql`gen_random_uuid(), gen_random_uuid(), gen_random_uuid()`,
      portal_agreements: sql`gen_random_uuid()`,
      portal_faults: sql`gen_random_uuid()`,
      portal_machines: sql`gen_random_uuid()`,
      portal_report: sql`gen_random_uuid(), gen_random_uuid()`,
      portal_report_fault: sql`gen_random_uuid(), gen_random_uuid(), 'store_other', 'x'`,
      portal_reports: sql`gen_random_uuid()`,
      portal_sales: sql`gen_random_uuid(), '2025-01-01'::date, '2025-01-31'::date`,
      portal_stores: sql``,
      register_refill: sql`gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1`,
      register_refill_once: sql`gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1`,
      reopen_period: sql`gen_random_uuid(), '2025-01-01'::date`,
      sales_data_until: sql`gen_random_uuid()`,
    };
    const outcome = await asAnon((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select ${sql.identifier("public")}.${sql.identifier(fn)}(${args[fn]!})`),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});

describe("Drizzle-schemat stämmer med databasen", () => {
  const exported: unknown[] = Object.values(schema);
  const drizzleTables = exported.filter((v): v is PgTable => is(v, PgTable));
  const drizzleViews = exported.filter((v): v is PgView => is(v, PgView));

  function dbType(c: { dataType: string; udtName: string }): string {
    if (c.dataType === "ARRAY") return `${c.udtName.replace(/^_/, "")}[]`;
    return c.dataType === "USER-DEFINED" ? c.udtName : c.dataType;
  }

  it("samma tabeller och vyer", () => {
    expect(drizzleTables.map((t) => getTableConfig(t).name).sort()).toEqual(tables);
    expect(drizzleViews.map((v) => getViewConfig(v).name).sort()).toEqual(views);
  });

  it.each(drizzleTables.map((t) => [getTableConfig(t).name, t] as const))(
    "%s: kolumner, typer och null-barhet",
    (name, table) => {
      const expected = columnsOf(name).map(
        (c) => `${c.column}: ${dbType(c)}${c.nullable ? "" : " not null"}`,
      );
      const actual = getTableConfig(table).columns.map(
        (c) => `${c.name}: ${c.getSQLType()}${c.notNull ? " not null" : ""}`,
      );
      expect(actual.sort()).toEqual(expected.sort());
    },
  );

  it.each(drizzleViews.map((v) => [getViewConfig(v).name, v] as const))(
    "vyn %s: kolumner och typer",
    (name, view) => {
      const expected = columnsOf(name).map((c) => `${c.column}: ${dbType(c)}`);
      const fields = Object.values(getViewConfig(view).selectedFields) as {
        name: string;
        getSQLType(): string;
      }[];
      expect(fields.map((c) => `${c.name}: ${c.getSQLType()}`).sort()).toEqual(expected.sort());
    },
  );

  it("uppräkningstyperna har samma värden i samma ordning", async () => {
    const enums = await rows<{ name: string; values: string[] }>(
      db(),
      sql`select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
          from pg_type t join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' group by t.typname`,
    );
    const drizzleEnums = exported
      .filter((v): v is typeof schema.memberRole => typeof v === "function" && "enumName" in v)
      .map((e) => ({ name: e.enumName, values: [...e.enumValues] }));
    expect(drizzleEnums.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      enums.sort((a, b) => a.name.localeCompare(b.name)),
    );
    // Alla enum-kolumner i Drizzle pekar på en befintlig typ.
    const enumNames = new Set(enums.map((e) => e.name));
    for (const table of drizzleTables) {
      for (const column of getTableConfig(table).columns) {
        if (is(column, PgEnumColumn)) {
          expect(enumNames.has(column.enum.enumName)).toBe(true);
        }
      }
    }
  });
});
