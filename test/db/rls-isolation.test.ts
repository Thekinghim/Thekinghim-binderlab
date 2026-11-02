/**
 * Isolering mellan organisationer. Två organisationer (A och B) med data i
 * varje tabell. Testerna loopar över katalogen (alla tabeller och vyer i
 * public), inte över en handskriven lista, så en ny tabell testas automatiskt.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  asPostgres,
  db,
  asServiceRole,
  asUser,
  attempt,
  insertCopySql,
  one,
  orgScopedTables,
  publicTables,
  publicViews,
  rel,
  rows,
  sampleRow,
  seedTenantFixture,
  type TenantFixture,
} from "./helpers";

const tables = await publicTables();
const views = await publicViews();
const scoped = await orgScopedTables();
const relations = [...tables, ...views];

interface CompositeFk {
  name: string;
  table: string;
  column: string;
  refTable: string;
}

const compositeFks = (
  await rows<{ name: string; table: string; column: string; ref_table: string }>(
    db(),
    sql`select con.conname as name, cl.relname as table, att.attname as column, ref.relname as ref_table
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_namespace n on n.oid = cl.relnamespace
        join pg_class ref on ref.oid = con.confrelid
        join lateral unnest(con.conkey) as k(attnum) on true
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
        where n.nspname = 'public' and con.contype = 'f'
          and array_length(con.conkey, 1) = 2
          and att.attname <> 'organization_id'
        order by cl.relname, con.conname`,
  )
).map((r): CompositeFk => ({
  name: r.name,
  table: r.table,
  column: r.column,
  refTable: r.ref_table,
}));

let A: TenantFixture;
let B: TenantFixture;

beforeAll(async () => {
  A = await seedTenantFixture();
  B = await seedTenantFixture();
});

describe("fixturen", () => {
  it.each(tables)("%s har minst en rad för organisationen", async (table) => {
    const where =
      table === "organizations" ? sql`id = ${A.orgId}` : sql`organization_id = ${A.orgId}`;
    const { n } = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from ${rel(table)} where ${where}`,
    );
    expect(n).toBeGreaterThan(0);
  });
});

describe("läsning: en användare i A ser 0 rader från B", () => {
  it.each(relations)("%s", async (relation) => {
    const orgColumn = relation === "organizations" ? sql`id` : sql`organization_id`;
    const [own, foreign] = await asUser(A.owner, async (tx) => [
      await one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from ${rel(relation)} where ${orgColumn} = ${A.orgId}`,
      ),
      await one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from ${rel(relation)} where ${orgColumn} <> ${A.orgId}`,
      ),
    ]);
    expect(foreign!.n).toBe(0);
    // Kontroll åt andra hållet: ägaren ser sin egen data (utom vyer som kan vara tomma).
    if (tables.includes(relation)) {
      expect(own!.n).toBeGreaterThan(0);
    }
  });
});

describe("skrivning: insert med B:s organization_id nekas", () => {
  it.each(tables)("%s", async (table) => {
    const row = await sampleRow(table, B.orgId);
    expect(row, `fixturen saknar rad i ${table}`).toBeDefined();
    const overrides: Record<string, unknown> = { id: randomUUID() };
    if (table === "organizations") {
      overrides.slug = `x-${randomUUID().slice(0, 8)}`;
    }
    const query = await insertCopySql(table, row!, overrides);
    const outcome = await asUser(A.owner, (tx) => attempt(tx, (sp) => sp.execute(query)));
    expect(outcome.ok, `${table}: insert lyckades`).toBe(false);
    expect(outcome.code).toBe("42501");
  });
});

describe("skrivning: update som flyttar organization_id nekas", () => {
  it.each(scoped)("%s (som ägare i A)", async (table) => {
    const row = await sampleRow(table, A.orgId);
    const outcome = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update ${rel(table)} set organization_id = ${B.orgId} where id = ${row!.id as string}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(["BL001", "42501"]).toContain(outcome.code);
  });

  it.each(scoped)("%s (som service_role: triggern stoppar)", async (table) => {
    const row = await sampleRow(table, A.orgId);
    const outcome = await asServiceRole((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update ${rel(table)} set organization_id = ${B.orgId} where id = ${row!.id as string}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    // audit_log har inga update-rättigheter alls för service_role.
    expect(outcome.code).toBe(table === "audit_log" ? "42501" : "BL001");
  });

  it.each(scoped)("%s (som postgres: triggern stoppar även databasägaren)", async (table) => {
    const row = await sampleRow(table, A.orgId);
    const outcome = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update ${rel(table)} set organization_id = ${B.orgId} where id = ${row!.id as string}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("BL001");
  });
});

describe("sammansatta FK:er stoppar korsreferenser mellan organisationer (även service_role)", () => {
  it("det finns sammansatta FK:er att testa", () => {
    expect(compositeFks.length).toBeGreaterThan(30);
  });

  it.each(compositeFks)("$table ($column) → $refTable", async (fk) => {
    const row = await sampleRow(fk.table, A.orgId, sql`t.${sql.identifier(fk.column)} is not null`);
    expect(row, `fixturen saknar rad i ${fk.table} med ${fk.column} satt`).toBeDefined();
    const foreign = await sampleRow(fk.refTable, B.orgId);
    expect(foreign).toBeDefined();

    const outcome = await asPostgres(async (tx) => {
      // Stäng av egna triggers (inte FK-triggers) så att just FK:n prövas.
      await tx.execute(sql`alter table ${rel(fk.table)} disable trigger user`);
      await tx.execute(sql`set local role service_role`);
      const result = await attempt(tx, (sp) =>
        sp.execute(
          sql`update ${rel(fk.table)} set ${sql.identifier(fk.column)} = ${foreign!.id as string}
              where id = ${row!.id as string}`,
        ),
      );
      await tx.execute(sql`reset role`);
      await tx.execute(sql`alter table ${rel(fk.table)} enable trigger user`);
      return result;
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("23503");
  });
});
