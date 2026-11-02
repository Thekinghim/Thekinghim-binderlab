/**
 * Seedar en databas med verksamhetens riktiga försäljning 13 okt – 1 nov 2026
 * (460 order, 79 987 kr) och tre exempelbutiker. Orderna går genom importen
 * (en genererad Awish-CSV importeras med runImport). Se src/seed/.
 *
 *   npm run db:seed                       # binderlab_dev (DATABASE_URL)
 *   npm run db:seed -- test               # binderlab_test (DATABASE_URL_TEST)
 *   npm run db:seed -- --url <url>        # annan lokal databas
 *   npm run db:seed -- --allow-remote …   # krävs för icke-lokal värd
 *   npm run db:seed -- --write-csv <fil>  # skriv bara Awish-CSV:n
 *
 * Från början: npm run db:reset dev && npm run db:seed
 *
 * Inloggning lokalt: agare@binderlab.local (ägare) och delagare@binderlab.local
 * (läsare) med lösenordet i DEV_SEED_PASSWORD (standard "binderlab-dev", bara lokalt).
 * Seeden är idempotent: en andra körning skapar inget nytt.
 */

import { writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";

import { config } from "dotenv";

// Importen och databasklienten är märkta "server-only" (för Next). Utanför
// Next löser vi paketet med villkoret react-server, som ger den tomma modulen.
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

function formatKr(ore: number): string {
  const kr = Math.floor(ore / 100);
  const rest = String(ore % 100).padStart(2, "0");
  return `${kr.toLocaleString("sv-SE")},${rest} kr`;
}

async function main(): Promise<void> {
  const { resolveSeedTarget } = await import("../../src/seed/target");
  const target = resolveSeedTarget(process.argv.slice(2), process.env);

  if (target.mode === "csv") {
    const { generateSeedOrders } = await import("../../src/seed/orders");
    const { toAwishCsvBytes } = await import("../../src/seed/awish-csv");
    await writeFile(target.path, toAwishCsvBytes(generateSeedOrders()));
    console.log(`Skrev ${target.path}.`);
    return;
  }

  // Klienten läser DATABASE_URL när den skapas.
  process.env.DATABASE_URL = target.url;
  const { getServiceDb, closeServiceDb } = await import("../../src/db/client");
  const { runSeed } = await import("../../src/seed/run-seed");

  const started = Date.now();
  console.log(`Seedar ${target.host}/${target.database}${target.local ? "" : " (FJÄRR)"} …`);
  try {
    const result = await runSeed(getServiceDb(), {
      password: target.password,
      manageUsers: target.manageUsers,
      log: (m) => console.log(`  ${m}`),
    });
    const created = Object.entries(result.sections)
      .filter(([, s]) => s.created > 0)
      .map(([name, s]) => `${name} ${s.created}`);
    console.log(
      created.length > 0 ? `  Nytt: ${created.join(", ")}.` : "  Inget nytt (redan seedat).",
    );
    if (result.import?.firstRow) {
      const f = result.import.firstRow;
      console.log(
        `  Kontroll av tidszon: order ${f.externalId} ${f.sourceLocal} (${f.sourceTimezone}) = ${f.organizationLocal} svensk tid.`,
      );
    }
    console.log(
      `Klart på ${Date.now() - started} ms: ${result.totals.orders} order, ${formatKr(result.totals.revenueOre)}. ` +
        `Organisation ${result.organizationId}.`,
    );
  } finally {
    await closeServiceDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
