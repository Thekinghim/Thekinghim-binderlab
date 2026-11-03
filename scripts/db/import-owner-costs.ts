/**
 * Lägger in ägarens inköpskostnader (exkl. moms) från en datafil.
 *
 *   npm run db:import-costs -- --url <url>                      # torrkörning
 *   npm run db:import-costs -- --url <url> --apply              # skriv
 *   npm run db:import-costs -- --url <url> --apply --confirm-flagged
 *   … --org <slug>              # krävs om databasen har flera organisationer
 *   … --file <fil.json>         # annan fil än data/owner-costs-2026-10-15.json
 *   … --allow-remote            # krävs för annat än 127.0.0.1/localhost
 *
 * Skapar inga titlar. Samma pris en gång till hoppas över, ett annat pris samma datum
 * stoppar hela körningen. Varje nytt pris loggas i audit_log av triggern.
 */

import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

import { config } from "dotenv";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "react-server"],
      });
    }
    return nextResolve(specifier, context);
  },
});

config({ path: [".env.local", ".env"], quiet: true });

const DEFAULT_FILE = new URL("./data/owner-costs-2026-10-15.json", import.meta.url);
const FLAGS = new Set(["--apply", "--confirm-flagged", "--allow-remote"]);
const VALUED = new Set(["--url", "--org", "--file"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

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
    if (!FLAGS.has(arg) && !VALUED.has(arg) && !VALUED.has(prev)) {
      throw new Error(`Okänt argument: ${arg}`);
    }
  });
  const url = valueAfter(argv, "--url");
  if (!url) throw new Error("Ange --url <databas-url>.");
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && !argv.includes("--allow-remote")) {
    throw new Error(`Vägrar: ${host} är inte lokal. Lägg till --allow-remote.`);
  }
  const apply = argv.includes("--apply");
  const confirmFlagged = argv.includes("--confirm-flagged");
  const filePath = valueAfter(argv, "--file");

  const { parseOwnerCostFile, formatOwnerCostReport } =
    await import("../../src/app/(app)/inkopspriser/_lib/owner-costs");
  const file = parseOwnerCostFile(
    JSON.parse(await readFile(filePath ?? DEFAULT_FILE, "utf8")) as unknown,
  );

  process.env.DATABASE_URL = url;
  const { getServiceDb, closeServiceDb } = await import("../../src/db/client");
  const { importOwnerCosts, resolveOrganization } = await import("./import-owner-costs-lib");
  const db = getServiceDb();
  try {
    const organizationId = await resolveOrganization(db, valueAfter(argv, "--org"));
    console.log(`${host}${apply ? "" : " (torrkörning)"}`);
    const result = await importOwnerCosts(db, file, { organizationId, apply, confirmFlagged });
    for (const line of formatOwnerCostReport(result.plan, file, { applied: result.applied })) {
      console.log(line);
    }
    if (result.applied) console.log(`Skrev ${result.written} priser.`);
    if (result.plan.blocked) process.exitCode = 2;
  } finally {
    await closeServiceDb();
  }
}

main().catch((error: unknown) => {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  console.error(error instanceof Error ? error.message : error, cause);
  process.exit(1);
});
