/**
 * Seedar demoorganisationen "Nordljus Automater AB (demo)": 1 feb – 2 nov 2026 flyttat till
 * seedningsdagen (demoSeedClock: demon slutar i dag kl. 12, eller i går före kl. 12),
 * tio automater i sju påhittade butiker i Mälardalen, ungefär 15 000 order
 * (importerade som Awish-CSV, en fil per månad) med lager, inköp, avtal, mål,
 * utbetalningar, kundärenden och larm. Se docs/demo.md och src/seed/demo/.
 *
 *   npm run db:seed-demo                       # binderlab_dev (DATABASE_URL)
 *   npm run db:seed-demo -- test               # binderlab_test (DATABASE_URL_TEST)
 *   npm run db:seed-demo -- --url <url>        # annan lokal databas
 *   npm run db:seed-demo -- --allow-remote …   # krävs för icke-lokal värd
 *   npm run db:seed-demo -- --stor             # 100 000+ order (nordljus-demo-stor)
 *   npm run db:seed-demo -- --aterstall        # radera demon och seeda på nytt
 *   npm run db:seed-demo -- --radera           # bara radera demon
 *   npm run db:seed-demo -- --datum 2026-12-01 # demons "nu" ett visst datum
 *   npm run db:seed-demo -- --original         # originalets "nu" (2 nov 2026)
 *
 * En demo som redan finns (utan --aterstall) behåller sitt "nu": sista dagen med försäljning.
 *
 * Inloggning lokalt (lösenord DEV_SEED_PASSWORD, standard "binderlab-dev"):
 * demo@binderlab.local (ägare), demo-lasare@binderlab.local (läsare) och
 * demo-pafyllare@binderlab.local (påfyllare). Idempotent: en andra körning
 * skapar inget nytt.
 */

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
  return `${Math.round(ore / 100).toLocaleString("sv-SE")} kr`;
}

async function main(): Promise<void> {
  const { resolveDemoSeedTarget } = await import("../../src/seed/demo/target");
  const target = resolveDemoSeedTarget(process.argv.slice(2), process.env);

  // Klienten läser DATABASE_URL när den skapas.
  process.env.DATABASE_URL = target.url;
  const { getServiceDb, closeServiceDb } = await import("../../src/db/client");
  const { runDemoSeed, resetDemo, existingDemoLastDay } =
    await import("../../src/seed/demo/run-demo-seed");
  const { demoCatalog, demoSeedClock } = await import("../../src/seed/demo/calendar");
  const { DEMO_ORGANIZATION, DEMO_ORGANIZATION_LARGE } =
    await import("../../src/seed/demo/catalog");
  const slug = target.large ? DEMO_ORGANIZATION_LARGE.slug : DEMO_ORGANIZATION.slug;

  const started = Date.now();
  console.log(
    `Demo${target.large ? " (stor)" : ""} i ${target.host}/${target.database}${target.local ? "" : " (FJÄRR)"} …`,
  );
  try {
    const db = getServiceDb();
    if (target.reset || target.deleteOnly) {
      const removed = await resetDemo(db, slug);
      if (removed) {
        const n = Object.values(removed.deleted).reduce((a, b) => a + b, 0);
        console.log(`  Raderade ${slug} (${n} rader).`);
      } else {
        console.log(`  ${slug} fanns inte.`);
      }
      if (target.deleteOnly) {
        return;
      }
    }
    const clock = demoSeedClock({
      now: new Date(),
      original: target.original,
      date: target.date,
      existingLastDay: target.reset ? null : await existingDemoLastDay(db, slug),
    });
    console.log(`  Demons "nu": ${clock.date} kl. ${clock.hour}.`);
    const result = await runDemoSeed(db, {
      catalog: demoCatalog(clock),
      password: target.password,
      manageUsers: target.manageUsers,
      large: target.large,
      log: (m) => console.log(`  ${m}`),
    });
    const created = Object.entries(result.sections)
      .filter(([, s]) => s.created > 0)
      .map(([name, s]) => `${name} ${s.created}`);
    console.log(
      created.length > 0 ? `  Nytt: ${created.join(", ")}.` : "  Inget nytt (redan seedat).",
    );
    console.log(
      `Klart på ${Math.round((Date.now() - started) / 1000)} s: ${result.totals.orders} order, ` +
        `${formatKr(result.totals.revenueOre)}. Organisation ${result.slug} (${result.organizationId}).`,
    );
  } finally {
    await closeServiceDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
