/**
 * Återställer en säkerhetskopia (npm run db:backup) till en NY databas och kontrollerar att
 * antal rader och kontrollsumma per tabell stämmer med manifestet.
 *
 *   npm run db:restore -- --file <fil.dump> --target <namn>
 *       ny databas <namn> på samma server som DATABASE_URL (lokalt)
 *   npm run db:restore -- --file <fil.dump> --target-url <url> [--allow-remote] [--no-owner]
 *       valfri ny databas; --allow-remote krävs för annat än 127.0.0.1/localhost
 *   --no-verify   hoppa över kontrollen (inte rekommenderat)
 *
 * Skriver aldrig över en befintlig databas: återställ bredvid och byt sedan
 * DATABASE_URL (eller döp om databaserna), se docs/operations.md.
 */

import { config } from "dotenv";

import {
  describeUrl,
  readManifest,
  restoreDatabase,
  verifyRestore,
  withDatabase,
} from "./backup-lib";

config({ path: [".env.local", ".env"], quiet: true });

const VALUE_FLAGS = new Set(["--file", "--target", "--target-url", "--jobs"]);
const BOOL_FLAGS = new Set(["--allow-remote", "--no-owner", "--no-verify"]);

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} saknar värde.`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  argv.forEach((arg, i) => {
    const prev = argv[i - 1] ?? "";
    if (!VALUE_FLAGS.has(arg) && !BOOL_FLAGS.has(arg) && !VALUE_FLAGS.has(prev)) {
      throw new Error(`Okänt argument: ${arg}`);
    }
  });
  const file = valueAfter(argv, "--file");
  if (!file) throw new Error("Ange --file <fil.dump>.");
  const target = valueAfter(argv, "--target");
  const targetUrlArg = valueAfter(argv, "--target-url");
  if (!!target === !!targetUrlArg)
    throw new Error("Ange antingen --target <namn> eller --target-url <url>.");
  let targetUrl = targetUrlArg;
  if (target) {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL saknas (behövs för --target).");
    targetUrl = withDatabase(base, target);
  }
  const jobs = Number(valueAfter(argv, "--jobs") ?? "1");

  const manifest = await readManifest(file);
  const { host, database } = describeUrl(targetUrl!);
  console.log(
    `Återställer ${manifest.source.database} från ${manifest.createdAt} (migrering ${manifest.lastMigration ?? "–"}) till ${host}/${database} …`,
  );
  const started = Date.now();
  await restoreDatabase({
    file,
    targetUrl: targetUrl!,
    allowRemote: argv.includes("--allow-remote"),
    noOwner: argv.includes("--no-owner"),
    jobs: Number.isInteger(jobs) && jobs > 0 ? jobs : 1,
    log: (m) => console.log(`  ${m}`),
  });
  console.log(`  Återställd på ${Date.now() - started} ms.`);
  if (argv.includes("--no-verify")) {
    console.log("  Kontrollen hoppades över (--no-verify).");
    return;
  }
  const result = await verifyRestore(manifest, targetUrl!);
  if (result.diffs.length > 0) {
    console.error(`KONTROLLEN MISSLYCKADES: ${result.diffs.length} tabeller skiljer sig.`);
    for (const d of result.diffs.slice(0, 50)) {
      console.error(
        `  ${d.table}: väntat ${d.expected ? `${d.expected.rows} rader ${d.expected.md5}` : "saknas"}, ` +
          `fick ${d.actual ? `${d.actual.rows} rader ${d.actual.md5}` : "saknas"}`,
      );
    }
    process.exit(2);
  }
  console.log(
    `Kontroll OK: ${result.tables} tabeller och ${result.rows.toLocaleString("sv-SE")} rader har samma antal och kontrollsumma som när kopian togs.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
