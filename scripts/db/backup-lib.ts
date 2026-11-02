/**
 * Säkerhetskopiering och återställning med pg_dump/pg_restore, och kontroll av att en
 * återställd databas är identisk: antal rader och en kontrollsumma per tabell.
 *
 *   backupDatabase   pg_dump (custom-format) i en ögonblicksbild + manifest med radantal och
 *                    kontrollsummor tagna i SAMMA ögonblicksbild
 *   restoreDatabase  skapar en NY databas och kör pg_restore (vägrar skriva över en befintlig)
 *   tableChecksums   antal rader och kontrollsumma per tabell (md5 per rad, summerad)
 *   compareChecksums skillnaderna mellan två uppsättningar
 *
 * Används av scripts/db/backup.ts, scripts/db/restore.ts och test/db/backup-restore.test.ts.
 * Se docs/operations.md.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

/** Schemana som aldrig tas med i kontrollsummorna. */
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface TableChecksum {
  /** schema.tabell */
  readonly table: string;
  readonly rows: number;
  /**
   * Kontrollsumma: md5 av "antal:summa1:summa2", där summorna är de två halvorna av varje
   * rads md5 (raden som text) summerade. Samma innehåll ger samma summa i vilken ordning
   * raderna än ligger.
   */
  readonly md5: string;
}

export interface BackupManifest {
  /** /2: kontrollsumman per rad (summerad). /1 (hela tabellen som en sträng) läses inte. */
  readonly format: "binderlab-backup/2";
  readonly createdAt: string;
  /** Värd och databas (utan användare och lösenord). */
  readonly source: { host: string; database: string };
  readonly serverVersion: string;
  readonly pgDumpVersion: string;
  /** Schemana i dumpen (tom lista = alla). */
  readonly schemas: readonly string[];
  /** Senaste migreringen i supabase_migrations.schema_migrations (null om tabellen saknas). */
  readonly lastMigration: string | null;
  /** Ögonblicksbilden som både dumpen och kontrollsummorna togs i (null = ingen). */
  readonly snapshot: string | null;
  readonly dumpFile: string;
  readonly dumpBytes: number;
  readonly tables: readonly TableChecksum[];
}

export interface ChecksumDiff {
  readonly table: string;
  readonly expected: { rows: number; md5: string } | null;
  readonly actual: { rows: number; md5: string } | null;
}

export class BackupError extends Error {
  override name = "BackupError";
}

/** Var pg_dump/pg_restore finns: PG_BIN_DIR, annars PATH. */
export function pgBinary(name: "pg_dump" | "pg_restore", env = process.env): string {
  const dir = env.PG_BIN_DIR?.trim();
  return dir ? path.join(dir, name) : name;
}

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Värd och databas ur en adress, utan hemligheter (för loggar och manifest). */
export function describeUrl(url: string): { host: string; database: string } {
  const u = new URL(url);
  return { host: u.port ? `${u.hostname}:${u.port}` : u.hostname, database: databaseOf(url) };
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Samma server, annan databas. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

function connect(url: string, max = 1) {
  return postgres(url, {
    max,
    onnotice: () => {},
    prepare: false,
    connection: { application_name: "binderlab-backup", TimeZone: "UTC" },
  });
}

type Sql = ReturnType<typeof connect>;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Kör ett program; avvisar med programmets stderr om det avslutas med fel. */
export function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) =>
      reject(
        new BackupError(
          `${command} kunde inte startas (${error.message}). Installera PostgreSQL-klienten (samma eller nyare version än servern) eller sätt PG_BIN_DIR.`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new BackupError(`${command} avslutades med kod ${code}: ${stderr.trim()}`));
    });
  });
}

/** Lösenordet lämnas till pg_dump/pg_restore via miljön, aldrig på kommandoraden. */
function connectionArgs(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  const args = [
    `--host=${u.hostname}`,
    `--port=${u.port || "5432"}`,
    `--username=${decodeURIComponent(u.username || "postgres")}`,
    `--dbname=${databaseOf(url)}`,
  ];
  return { args, env };
}

/** Tabellerna i databasen (vanliga och partitionerade), sorterade. */
async function listTables(sql: Sql, schemas: readonly string[]): Promise<string[]> {
  const rows = await sql<{ schema: string; name: string }[]>`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname <> all(${SYSTEM_SCHEMAS})
      and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast%'
      and (${schemas.length === 0} or n.nspname = any(${[...schemas]}))
    order by 1, 2`;
  return rows.map((r) => `${r.schema}.${r.name}`);
}

/** Antal rader och md5 per tabell, i den transaktion/anslutning som ges. */
async function checksumsWith(sql: Sql, schemas: readonly string[]): Promise<TableChecksum[]> {
  const out: TableChecksum[] = [];
  for (const table of await listTables(sql, schemas)) {
    const [schema, name] = table.split(".") as [string, string];
    const rel = `${quoteIdent(schema)}.${quoteIdent(name)}`;
    // En md5 per rad, summerad (de två 64-bitarshalvorna var för sig) och sedan hashad med
    // antalet: konstant minne oavsett tabellens storlek (ingen sträng av hela tabellen, som
    // Postgres begränsar till 1 GB) och oberoende av radernas ordning.
    const [row] = await sql.unsafe<{ rows: string; md5: string }[]>(
      `select count(*)::text as rows,
              md5(count(*)::text || ':' ||
                  coalesce(sum(('x' || substr(h, 1, 16))::bit(64)::bigint::numeric), 0)::text || ':' ||
                  coalesce(sum(('x' || substr(h, 17, 16))::bit(64)::bigint::numeric), 0)::text) as md5
       from (select md5(t::text) as h from ${rel} t) r`,
    );
    out.push({ table, rows: Number(row?.rows ?? 0), md5: row?.md5 ?? "" });
  }
  return out;
}

/** Antal rader och kontrollsumma per tabell i databasen (allt utom systemschemana). */
export async function tableChecksums(
  url: string,
  schemas: readonly string[] = [],
): Promise<TableChecksum[]> {
  const sql = connect(url);
  try {
    return await sql.begin("isolation level repeatable read read only", (tx) =>
      checksumsWith(tx as unknown as Sql, schemas),
    );
  } finally {
    await sql.end();
  }
}

/** Skillnaderna mellan förväntat och faktiskt (tom lista = identiska). */
export function compareChecksums(
  expected: readonly TableChecksum[],
  actual: readonly TableChecksum[],
): ChecksumDiff[] {
  const a = new Map(actual.map((t) => [t.table, t]));
  const e = new Map(expected.map((t) => [t.table, t]));
  const diffs: ChecksumDiff[] = [];
  for (const t of expected) {
    const got = a.get(t.table);
    if (!got || got.rows !== t.rows || got.md5 !== t.md5) {
      diffs.push({
        table: t.table,
        expected: { rows: t.rows, md5: t.md5 },
        actual: got ? { rows: got.rows, md5: got.md5 } : null,
      });
    }
  }
  for (const t of actual) {
    if (!e.has(t.table)) {
      diffs.push({ table: t.table, expected: null, actual: { rows: t.rows, md5: t.md5 } });
    }
  }
  return diffs;
}

export interface BackupOptions {
  /** Databasen som kopieras. */
  readonly url: string;
  /** Filen som skrivs (custom-format, .dump). Manifestet hamnar bredvid (.manifest.json). */
  readonly file: string;
  /** Bara dessa scheman (tom = alla). */
  readonly schemas?: readonly string[];
  readonly log?: (message: string) => void;
}

/**
 * pg_dump i custom-format. Dumpen och kontrollsummorna tas i samma ögonblicksbild
 * (pg_export_snapshot), så att manifestet beskriver exakt det som finns i filen även om
 * databasen skrivs till under tiden.
 */
export async function backupDatabase(options: BackupOptions): Promise<BackupManifest> {
  const log = options.log ?? (() => {});
  const schemas = options.schemas ?? [];
  for (const s of schemas) {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new BackupError(`Ogiltigt schema: ${s}`);
  }
  await mkdir(path.dirname(path.resolve(options.file)), { recursive: true });
  const { stdout: pgDumpVersion } = await run(pgBinary("pg_dump"), ["--version"]);
  const sql = connect(options.url);
  try {
    return await sql.begin("isolation level repeatable read read only", async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const [info] = await tx<{ version: string; snapshot: string }[]>`
        select current_setting('server_version') as version, pg_export_snapshot() as snapshot`;
      const snapshot = info!.snapshot;
      const { args, env } = connectionArgs(options.url);
      log(`pg_dump ${describeUrl(options.url).database} (ögonblicksbild ${snapshot}) …`);
      await run(
        pgBinary("pg_dump"),
        [
          ...args,
          "--format=custom",
          "--compress=6",
          `--snapshot=${snapshot}`,
          `--file=${options.file}`,
          ...schemas.map((s) => `--schema=${s}`),
        ],
        env,
      );
      log("Räknar rader och kontrollsummor …");
      const tables = await checksumsWith(tx, schemas);
      const migrations = await tx<{ version: string | null }[]>`
        select (select max(version) from supabase_migrations.schema_migrations) as version
        where to_regclass('supabase_migrations.schema_migrations') is not null`;
      const manifest: BackupManifest = {
        format: "binderlab-backup/2",
        createdAt: new Date().toISOString(),
        source: describeUrl(options.url),
        serverVersion: info!.version,
        pgDumpVersion: pgDumpVersion.trim(),
        schemas,
        lastMigration: migrations[0]?.version ?? null,
        snapshot,
        dumpFile: path.basename(options.file),
        dumpBytes: (await stat(options.file)).size,
        tables,
      };
      await writeFile(manifestPathOf(options.file), `${JSON.stringify(manifest, null, 2)}\n`);
      return manifest;
    });
  } finally {
    await sql.end();
  }
}

export function manifestPathOf(dumpFile: string): string {
  return dumpFile.replace(/\.dump$/, "") + ".manifest.json";
}

export async function readManifest(dumpFile: string): Promise<BackupManifest> {
  const raw = JSON.parse(await readFile(manifestPathOf(dumpFile), "utf8")) as BackupManifest;
  if ((raw.format as string) === "binderlab-backup/1") {
    throw new BackupError(
      "Manifestet är från en äldre version av skriptet (kontrollsummorna räknades annorlunda). Ta en ny säkerhetskopia med npm run db:backup.",
    );
  }
  if (raw.format !== "binderlab-backup/2") {
    throw new BackupError(`Okänt manifestformat: ${String(raw.format)}`);
  }
  return raw;
}

export interface RestoreOptions {
  readonly file: string;
  /** Adress till databasen som ska SKAPAS (namnet får inte finnas). */
  readonly targetUrl: string;
  /** Tillåt en server som inte är lokal (t.ex. ett nytt Supabase-projekt). */
  readonly allowRemote?: boolean;
  /** Ta inte med ägare (när rollerna heter annorlunda på målservern). */
  readonly noOwner?: boolean;
  /** Parallella jobb för pg_restore. */
  readonly jobs?: number;
  readonly log?: (message: string) => void;
}

/** Skapar en ny databas och återställer dumpen i den. Skriver aldrig över en befintlig. */
export async function restoreDatabase(options: RestoreOptions): Promise<void> {
  const log = options.log ?? (() => {});
  if (!options.allowRemote && !isLocalUrl(options.targetUrl)) {
    throw new BackupError(
      "Vägrar: målet är inte en lokal databas. Ange --allow-remote för ett nytt, tomt projekt.",
    );
  }
  const database = databaseOf(options.targetUrl);
  if (!DB_NAME.test(database) || database === "postgres") {
    throw new BackupError(`Ogiltigt namn på måldatabasen: "${database}".`);
  }
  await stat(options.file).catch(() => {
    throw new BackupError(`Filen finns inte: ${options.file}`);
  });
  const admin = connect(withDatabase(options.targetUrl, "postgres"));
  try {
    const exists = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_database where datname = ${database}`;
    if ((exists[0]?.n ?? 0) > 0) {
      throw new BackupError(
        `Databasen ${database} finns redan. Återställ alltid till en ny databas och byt sedan.`,
      );
    }
    log(`Skapar ${database} …`);
    await admin.unsafe(`create database ${quoteIdent(database)}`);
  } finally {
    await admin.end();
  }
  const { args, env } = connectionArgs(options.targetUrl);
  log(`pg_restore ${path.basename(options.file)} → ${database} …`);
  try {
    await restoreInto(options, args, env);
  } catch (error) {
    // Ingen halvfärdig databas kvar: nästa försök ska inte stoppas av "finns redan".
    log(`Återställningen misslyckades; tar bort ${database} …`);
    const cleanup = connect(withDatabase(options.targetUrl, "postgres"));
    try {
      await cleanup.unsafe(`drop database if exists ${quoteIdent(database)} with (force)`);
    } catch (dropError) {
      const why = dropError instanceof Error ? dropError.message : String(dropError);
      throw new BackupError(
        `${error instanceof Error ? error.message : String(error)} (Databasen ${database} kunde inte tas bort: ${why}. Ta bort den för hand innan nästa försök.)`,
      );
    } finally {
      await cleanup.end();
    }
    throw error;
  }
}

async function restoreInto(
  options: RestoreOptions,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await run(
    pgBinary("pg_restore"),
    [
      ...args,
      "--exit-on-error",
      "--single-transaction",
      ...(options.noOwner ? ["--no-owner"] : []),
      ...(options.jobs && options.jobs > 1 ? [`--jobs=${options.jobs}`] : []),
      options.file,
    ].filter((a) => !(options.jobs && options.jobs > 1 && a === "--single-transaction")),
    env,
  );
}

export interface VerifyResult {
  readonly tables: number;
  readonly rows: number;
  readonly diffs: ChecksumDiff[];
}

/** Jämför den återställda databasen med manifestet. */
export async function verifyRestore(
  manifest: BackupManifest,
  targetUrl: string,
): Promise<VerifyResult> {
  const actual = await tableChecksums(targetUrl, manifest.schemas);
  return {
    tables: actual.length,
    rows: actual.reduce((n, t) => n + t.rows, 0),
    diffs: compareChecksums(manifest.tables, actual),
  };
}

/** Standardnamn på dumpen: .data/backups/<databas>-<tid>.dump */
export function defaultDumpFile(url: string, now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return path.resolve(".data", "backups", `${databaseOf(url)}-${stamp}.dump`);
}
