/**
 * Kör SQL-migreringarna i supabase/migrations och (lokalt) auth-shimmen.
 * Används av scripts/db/migrate.ts, scripts/db/reset.ts och testernas
 * globalSetup. Ingen "server-only" här: modulen körs bara från skript och
 * tester, aldrig från appen.
 *
 * Bokföringen sker i supabase_migrations.schema_migrations(version, name,
 * statements), samma tabell som Supabase CLI använder, så att
 * "supabase db push" senare ser vilka migreringar som redan körts.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;
/** Godtycklig men fast nyckel för pg_advisory_lock under migrering. */
const MIGRATION_LOCK_KEY = 7_342_001;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
}

export interface MigrateOptions {
  /** Katalog med migreringar. Standard: <cwd>/supabase/migrations. */
  dir?: string;
  log?: (message: string) => void;
}

export function defaultMigrationsDir(): string {
  return path.resolve(process.cwd(), "supabase", "migrations");
}

export function authShimPath(): string {
  return path.resolve(process.cwd(), "supabase", "local", "auth-shim.sql");
}

export async function readMigrations(dir = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  for (const file of entries) {
    const match = MIGRATION_FILE.exec(file);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Ogiltigt migreringsnamn: ${file} (förväntat YYYYMMDDHHMMSS_namn.sql)`);
    }
    files.push({
      version: match[1],
      name: match[2],
      file,
      sql: await readFile(path.join(dir, file), "utf8"),
    });
  }
  const versions = new Set(files.map((f) => f.version));
  if (versions.size !== files.length) {
    throw new Error("Två migreringar har samma version.");
  }
  return files;
}

function connect(url: string) {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "binderlab-migrate", TimeZone: "UTC" },
  });
}

/**
 * Kör migreringar som inte redan körts, i versionsordning, en transaktion per
 * fil. Returnerar versionerna som kördes.
 */
export async function applyMigrations(url: string, options: MigrateOptions = {}): Promise<string[]> {
  const log = options.log ?? (() => {});
  const migrations = await readMigrations(options.dir);
  const sql = connect(url);
  const applied: string[] = [];
  try {
    await sql.unsafe(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text not null primary key,
        statements text[],
        name text
      );
    `);
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      const rows = await sql<{ version: string; statements: string[] | null }[]>`
        select version, statements from supabase_migrations.schema_migrations
      `;
      const done = new Map(rows.map((r) => [r.version, r.statements]));
      for (const m of migrations) {
        if (done.has(m.version)) {
          const statements = done.get(m.version);
          if (statements && statements.length === 1 && statements[0] !== m.sql) {
            log(`VARNING: ${m.file} har ändrats sedan den kördes. Skriv en ny migrering i stället.`);
          }
          continue;
        }
        await sql.begin(async (tx) => {
          await tx.unsafe(m.sql);
          await tx`
            insert into supabase_migrations.schema_migrations (version, name, statements)
            values (${m.version}, ${m.name}, ${[m.sql]})
          `;
        });
        applied.push(m.version);
        log(`Körde ${m.file}`);
      }
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    }
  } finally {
    await sql.end();
  }
  return applied;
}

/** Kör supabase/local/auth-shim.sql. ENDAST lokalt och i CI. */
export async function applyAuthShim(url: string, file = authShimPath()): Promise<void> {
  assertLocalUrl(url);
  const sql = connect(url);
  try {
    await sql.unsafe(await readFile(file, "utf8"));
  } finally {
    await sql.end();
  }
}

/** Kastar om URL:en inte pekar på en lokal databas (127.0.0.1/localhost). */
export function assertLocalUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Ogiltig databas-URL.");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Vägrar: ${parsed.hostname} är inte en lokal databas (bara 127.0.0.1/localhost).`,
    );
  }
  return parsed;
}

/**
 * Tar bort och skapar om databasen, kör auth-shimmen och alla migreringar.
 * Vägrar om databasen inte är lokal.
 */
export async function resetDatabase(url: string, options: MigrateOptions = {}): Promise<void> {
  const parsed = assertLocalUrl(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database) || database === "postgres") {
    throw new Error(`Vägrar: ogiltigt databasnamn "${database}".`);
  }
  const adminUrl = new URL(parsed.toString());
  adminUrl.pathname = "/postgres";
  const admin = connect(adminUrl.toString());
  try {
    await admin.unsafe(`drop database if exists "${database}" with (force)`);
    await admin.unsafe(`create database "${database}"`);
  } finally {
    await admin.end();
  }
  await applyAuthShim(url);
  await applyMigrations(url, options);
}
