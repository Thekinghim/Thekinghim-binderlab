/**
 * Säkerhetskopia av en databas med pg_dump (custom-format) och ett manifest med antal rader
 * och kontrollsumma per tabell, tagna i samma ögonblicksbild som dumpen.
 *
 *   npm run db:backup                          # DATABASE_URL (binderlab_dev)
 *   npm run db:backup -- test                  # DATABASE_URL_TEST
 *   npm run db:backup -- --url <url>           # valfri databas (även Supabase, bara läsning)
 *   npm run db:backup -- --out <fil.dump>      # annan fil än .data/backups/<db>-<tid>.dump
 *   npm run db:backup -- --schemas public,private,supabase_migrations
 *
 * Återställ med npm run db:restore (se docs/operations.md).
 */

import { config } from "dotenv";

import { backupDatabase, defaultDumpFile, describeUrl, manifestPathOf } from "./backup-lib";

config({ path: [".env.local", ".env"], quiet: true });

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} saknar värde.`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const known = new Set(["dev", "test", "--url", "--out", "--schemas"]);
  argv.forEach((arg, i) => {
    const prev = argv[i - 1];
    if (!known.has(arg) && prev !== "--url" && prev !== "--out" && prev !== "--schemas") {
      throw new Error(`Okänt argument: ${arg}`);
    }
  });
  const explicit = valueAfter(argv, "--url");
  const variable = argv.includes("test") ? "DATABASE_URL_TEST" : "DATABASE_URL";
  const url = explicit ?? process.env[variable];
  if (!url) throw new Error(`${explicit ? "--url" : variable} saknas.`);
  const file = valueAfter(argv, "--out") ?? defaultDumpFile(url);
  const schemas = (valueAfter(argv, "--schemas") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const started = Date.now();
  const { host, database } = describeUrl(url);
  console.log(`Säkerhetskopierar ${host}/${database} …`);
  const manifest = await backupDatabase({ url, file, schemas, log: (m) => console.log(`  ${m}`) });
  const rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
  console.log(
    `Klart på ${Date.now() - started} ms: ${manifest.tables.length} tabeller, ${rows.toLocaleString("sv-SE")} rader, ` +
      `${(manifest.dumpBytes / 1024).toFixed(0)} kB. Senaste migrering ${manifest.lastMigration ?? "–"}.`,
  );
  console.log(`  Dump:     ${file}`);
  console.log(`  Manifest: ${manifestPathOf(file)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
