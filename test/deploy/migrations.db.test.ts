/**
 * Frågorna som scripts/deploy skickar till Supabase (POST /database/query)
 * provas här mot en riktig Postgres 16 med auth-shimmen: alla riktiga
 * migreringar, bokföringen (samma rader som scripts/db/migrate.ts skriver),
 * idempotens, att ett fel rullar tillbaka hela filen, läsfrågorna i
 * dry-run och SCRAM-verifieraren för lösenordsbytet.
 *
 * Egen databas: DEPLOY_TEST_DATABASE_URL, standard
 * postgres://postgres@127.0.0.1:54322/binderlab_test_driftsattning (raderas och
 * skapas om; bara lokala adresser godtas).
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BOOKKEEPING_SQL, md5, migrationQuery } from "../../scripts/deploy/lib/supabase";
import { scramSha256Verifier } from "../../scripts/deploy/lib/secrets";
import {
  applyAuthShim,
  assertLocalUrl,
  readMigrations,
  type MigrationFile,
} from "../../src/db/migrator";

const URL_ =
  process.env.DEPLOY_TEST_DATABASE_URL ??
  "postgres://postgres@127.0.0.1:54322/binderlab_test_driftsattning";

let sql: postgres.Sql;

/**
 * Raderna från sista satsen, som Management API:t svarar (postgres.js ger en
 * lista per sats när frågan har flera).
 */
async function query(text: string): Promise<Record<string, unknown>[]> {
  const result = (await sql.unsafe(text)) as unknown as unknown[];
  const multi = result.length > 0 && result.every((r) => Array.isArray(r));
  return [...((multi ? result[result.length - 1] : result) as Record<string, unknown>[])];
}
let migrations: MigrationFile[];

beforeAll(async () => {
  const parsed = assertLocalUrl(URL_);
  const db = parsed.pathname.slice(1);
  expect(db).toMatch(/^binderlab_test_[a-z_]+$/);
  const admin = new URL(URL_);
  admin.pathname = "/postgres";
  const a = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists "${db}" with (force)`);
  await a.unsafe(`create database "${db}"`);
  await a.end();
  await applyAuthShim(URL_);
  sql = postgres(URL_, { max: 1, onnotice: () => {} });
  migrations = await readMigrations();
}, 120_000);

afterAll(async () => {
  await sql?.end();
});

describe("migreringsfrågorna mot Postgres", () => {
  it("bokföringsfrågan skapar tabellen och returnerar en tom lista", async () => {
    expect(await query(BOOKKEEPING_SQL)).toEqual([]);
  });

  it("dry-run-frågorna är läsfrågor", async () => {
    const t = await query(
      "set transaction read only; select to_regclass('supabase_migrations.schema_migrations')::text as t;",
    );
    expect(t[0]).toEqual({ t: "supabase_migrations.schema_migrations" });
    await expect(
      sql.unsafe("set transaction read only; create table should_fail (id int);"),
    ).rejects.toThrow(/read-only transaction/);
  });

  it("kör alla riktiga migreringar och bokför dem som scripts/db/migrate.ts", async () => {
    expect(migrations.length).toBeGreaterThan(40);
    for (const m of migrations) {
      await sql.unsafe(migrationQuery(m));
    }
    const rows = await sql<{ version: string; name: string; statements: string[] }[]>`
      select version, name, statements from supabase_migrations.schema_migrations order by version`;
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    for (const [i, m] of migrations.entries()) {
      expect(rows[i]!.name).toBe(m.name);
      expect(rows[i]!.statements).toEqual([m.sql]);
    }
    // Bokföringsfrågan ger samma fingeravtryck som skriptet räknar lokalt.
    const listed = await query(BOOKKEEPING_SQL);
    expect(listed.map((r) => r.hash)).toEqual(migrations.map((m) => md5(m.sql)));
    // Buckets skapas av migreringarna.
    const buckets = await sql`select id from storage.buckets order by id`;
    expect(buckets.map((b) => b.id)).toEqual(["contracts", "imports", "reports"]);
  }, 120_000);

  it("en redan körd migrering körs inte igen", async () => {
    await expect(sql.unsafe(migrationQuery(migrations[0]!))).rejects.toThrow(
      /binderlab: migreringen är redan körd/,
    );
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from supabase_migrations.schema_migrations`;
    expect(row!.n).toBe(migrations.length);
  });

  it("ett fel mitt i filen rullar tillbaka allt, även bokföringen", async () => {
    const bad: MigrationFile = {
      version: "29991231235959",
      name: "trasig",
      file: "29991231235959_trasig.sql",
      sql: "create table public.deploy_halvvags (id int);\nselect 1/0;",
    };
    await expect(sql.unsafe(migrationQuery(bad))).rejects.toThrow(/division by zero/);
    const [t] = await sql`select to_regclass('public.deploy_halvvags')::text as t`;
    expect(t!.t).toBeNull();
    const rows =
      await sql`select 1 from supabase_migrations.schema_migrations where version = ${bad.version}`;
    expect(rows).toHaveLength(0);
  });

  it("dollar-taggen krockar inte med innehållet", async () => {
    const tricky: MigrationFile = {
      version: "29991231235958",
      name: "tagg",
      file: "29991231235958_tagg.sql",
      sql: "-- $bl_mig$ och $bl_mig1$ i en kommentar\nselect 'x';",
    };
    await sql.unsafe(migrationQuery(tricky));
    const [row] = await sql<{ statements: string[] }[]>`
      select statements from supabase_migrations.schema_migrations where version = ${tricky.version}`;
    expect(row!.statements).toEqual([tricky.sql]);
    await sql`delete from supabase_migrations.schema_migrations where version = ${tricky.version}`;
  });
});

describe("SCRAM-verifieraren", () => {
  it("är identisk med Postgres egen och tas emot oförändrad", async () => {
    const password = "Abc-def_123xyzLONGpassword0987";
    await sql.unsafe("drop role if exists bl_deploy_scram");
    await sql.unsafe(
      `set password_encryption = 'scram-sha-256'; create role bl_deploy_scram login password '${password}'`,
    );
    const [row] = await sql<{ rolpassword: string }[]>`
      select rolpassword from pg_authid where rolname = 'bl_deploy_scram'`;
    const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(row!.rolpassword)!;
    expect(scramSha256Verifier(password, Buffer.from(match[2]!, "base64"), Number(match[1]))).toBe(
      row!.rolpassword,
    );
    const verifier = scramSha256Verifier(password);
    await sql.unsafe(`alter role bl_deploy_scram with password '${verifier}'`);
    const [after] = await sql<{ rolpassword: string }[]>`
      select rolpassword from pg_authid where rolname = 'bl_deploy_scram'`;
    expect(after!.rolpassword).toBe(verifier);
    await sql.unsafe("drop role bl_deploy_scram");
  });
});
