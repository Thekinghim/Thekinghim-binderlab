/**
 * Säkerhetskopiering och återställning (scripts/db/backup-lib.ts) mot lokal Postgres:
 *
 * - pg_dump av testdatabasen (med seedens verksamhet i en egen organisation) och pg_restore
 *   till en NY databas ger samma antal rader och samma kontrollsumma i varje tabell.
 * - Behörigheter, RLS-policyer och triggrar följer med (appen fungerar mot kopian).
 * - Kontrollen upptäcker en ändrad rad, och återställningen vägrar skriva över en
 *   befintlig databas eller en databas som inte är lokal.
 *
 * Kräver pg_dump/pg_restore i PATH (eller PG_BIN_DIR), samma eller nyare version än servern.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "@/import/file-store";
import { runSeed } from "@/seed/run-seed";

import {
  backupDatabase,
  compareChecksums,
  databaseOf,
  manifestPathOf,
  readManifest,
  restoreDatabase,
  tableChecksums,
  verifyRestore,
  withDatabase,
  type BackupManifest,
} from "../../scripts/db/backup-lib";

import { db, uniqueSuffix } from "./helpers";

const SOURCE = process.env.DATABASE_URL!;
const TARGET_NAME = `${databaseOf(SOURCE)}_restore_${uniqueSuffix()
  .replace(/[^a-z0-9]/gi, "")
  .toLowerCase()}`.slice(0, 63);
const TARGET = withDatabase(SOURCE, TARGET_NAME);

let dir: string;
let file: string;
let manifest: BackupManifest;

async function dropTarget(): Promise<void> {
  const admin = postgres(withDatabase(SOURCE, "postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${TARGET_NAME}" with (force)`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bl-backup-"));
  file = path.join(dir, "binderlab.dump");
  // Verksamhetens data (460 order genom importen) i en egen organisation, så att kopian
  // innehåller order, importer, lager, avtal och ändringslogg.
  const suffix = uniqueSuffix()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  await runSeed(db(), {
    password: "backup-test-losenord",
    manageUsers: true,
    organization: { name: `Backup ${suffix}`, slug: `backup-${suffix}` },
    users: {
      owner: {
        email: `backup-agare-${suffix}@test.binderlab.se`,
        fullName: "Backup Ägare",
        role: "owner",
      },
      partner: {
        email: `backup-delagare-${suffix}@test.binderlab.se`,
        fullName: "Backup Delägare",
        role: "viewer",
      },
    },
    fileStore: new LocalFileStore(path.join(dir, "imports")),
  });
  await dropTarget();
}, 120_000);

afterAll(async () => {
  await dropTarget();
  await rm(dir, { recursive: true, force: true });
});

describe("säkerhetskopia och återställning", () => {
  it("pg_dump ger en fil och ett manifest med rader och kontrollsumma per tabell", async () => {
    manifest = await backupDatabase({ url: SOURCE, file });
    expect(manifest.dumpBytes).toBeGreaterThan(10_000);
    expect(manifest.lastMigration).toMatch(/^\d{14}$/);
    expect(manifest.snapshot).toBeTruthy();
    const orders = manifest.tables.find((t) => t.table === "public.orders");
    expect(orders?.rows).toBeGreaterThanOrEqual(460);
    expect(manifest.tables.map((t) => t.table)).toEqual(
      expect.arrayContaining(["auth.users", "public.organizations", "public.audit_log"]),
    );
    // Manifestet går att läsa tillbaka och innehåller inga hemligheter.
    expect(await readManifest(file)).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain("postgres://");
  }, 120_000);

  it("återställning till en ny databas: samma antal rader och kontrollsumma i varje tabell", async () => {
    await restoreDatabase({ file, targetUrl: TARGET });
    const result = await verifyRestore(manifest, TARGET);
    expect(result.diffs).toEqual([]);
    expect(result.tables).toBe(manifest.tables.length);
    expect(result.rows).toBe(manifest.tables.reduce((n, t) => n + t.rows, 0));
  }, 120_000);

  it("behörigheter, policyer och triggrar följer med", async () => {
    const q = `select
      (select count(*) from pg_policies)::int as policies,
      (select count(*) from pg_trigger where not tgisinternal)::int as triggers,
      has_table_privilege('authenticated', 'public.orders', 'select') as orders_select,
      has_table_privilege('authenticated', 'public.alerts', 'insert') as alerts_insert`;
    const read = async (url: string) => {
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      try {
        return (await sql.unsafe(q))[0];
      } finally {
        await sql.end();
      }
    };
    const [source, restored] = [await read(SOURCE), await read(TARGET)];
    expect(restored).toEqual(source);
    expect(restored).toMatchObject({ orders_select: true, alerts_insert: false });
  });

  it("kontrollen upptäcker en ändrad rad", async () => {
    const sql = postgres(TARGET, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(
        `update public.organizations set name = name || ' (ändrad)'
         where id = (select id from public.organizations order by id limit 1)`,
      );
    } finally {
      await sql.end();
    }
    const diffs = compareChecksums(manifest.tables, await tableChecksums(TARGET));
    expect(diffs.map((d) => d.table)).toEqual(["public.organizations"]);
    expect(diffs[0]!.expected!.rows).toBe(diffs[0]!.actual!.rows);
    expect(diffs[0]!.expected!.md5).not.toBe(diffs[0]!.actual!.md5);
  });

  it("vägrar skriva över en befintlig databas och återställa till en fjärrdatabas", async () => {
    await expect(restoreDatabase({ file, targetUrl: TARGET })).rejects.toThrow(/finns redan/);
    await expect(restoreDatabase({ file, targetUrl: SOURCE })).rejects.toThrow(/finns redan/);
    await expect(
      restoreDatabase({ file, targetUrl: "postgres://u:p@db.example.com:5432/ny" }),
    ).rejects.toThrow(/inte en lokal databas/);
  });

  it("en misslyckad återställning lämnar ingen halvfärdig databas efter sig", async () => {
    const broken = path.join(dir, "trasig.dump");
    const bytes = await readFile(file);
    await writeFile(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const name = `${TARGET_NAME.slice(0, 50)}_trasig`;
    const url = withDatabase(SOURCE, name);
    await expect(restoreDatabase({ file: broken, targetUrl: url })).rejects.toThrow();
    const admin = postgres(withDatabase(SOURCE, "postgres"), { max: 1, onnotice: () => {} });
    try {
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_database where datname = ${name}`;
      expect(row!.n).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it("kontrollsumman beror på innehållet, inte på radernas ordning", async () => {
    const sql = postgres(TARGET, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`create schema kontroll`);
      await sql.unsafe(`create table kontroll.a (id int, v text)`);
      await sql.unsafe(`create table kontroll.b (id int, v text)`);
      await sql.unsafe(`insert into kontroll.a values (1, 'x'), (2, 'y'), (3, null)`);
      await sql.unsafe(`insert into kontroll.b values (3, null), (2, 'y'), (1, 'x')`);
      const [a, b] = await tableChecksums(TARGET, ["kontroll"]);
      expect(a!.rows).toBe(3);
      expect(a!.md5).toBe(b!.md5);
      // Byter två värden mellan raderna: samma antal, annan summa.
      await sql.unsafe(
        `update kontroll.b set v = case id when 1 then 'y' when 2 then 'x' end where id in (1, 2)`,
      );
      const [a2, b2] = await tableChecksums(TARGET, ["kontroll"]);
      expect(a2!.md5).not.toBe(b2!.md5);
    } finally {
      await sql.unsafe(`drop schema if exists kontroll cascade`);
      await sql.end();
    }
  });

  it("manifest från den äldre versionen läses inte (kontrollsumman räknades annorlunda)", async () => {
    const oldDump = path.join(dir, "gammal.dump");
    await writeFile(
      manifestPathOf(oldDump),
      JSON.stringify({ ...manifest, format: "binderlab-backup/1" }),
    );
    await expect(readManifest(oldDump)).rejects.toThrow(/äldre version/);
  });
});
