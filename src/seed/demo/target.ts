/**
 * Argumenten till npm run db:seed-demo. Databasen och spärren mot fjärrvärdar
 * är desamma som för den riktiga seeden (src/seed/target.ts):
 *
 *   npm run db:seed-demo                       # DATABASE_URL (binderlab_dev)
 *   npm run db:seed-demo -- test               # DATABASE_URL_TEST
 *   npm run db:seed-demo -- --url <url>        # annan databas
 *   npm run db:seed-demo -- --allow-remote …   # krävs för annat än 127.0.0.1/localhost
 *
 * Demons egna flaggor:
 *
 *   --stor        100 000+ order i en egen organisation (nordljus-demo-stor)
 *   --aterstall   radera demoorganisationen först och seeda den på nytt
 *   --radera      bara radera demoorganisationen
 *   --datum D     demons "nu" (ÅÅÅÅ-MM-DD); standard är seedningsdagen (calendar.ts)
 *   --original    originalets "nu", 2 nov 2026 (testerna och skärmdumparna)
 */

import { resolveSeedTarget, SeedTargetError, type SeedTarget } from "../target";

export type DemoSeedTarget = Extract<SeedTarget, { mode: "database" }> & {
  large: boolean;
  reset: boolean;
  deleteOnly: boolean;
  /** --datum: demons "nu". null = seedningsdagen (eller den befintliga demons). */
  date: string | null;
  /** --original: originalets "nu" (2 nov 2026). */
  original: boolean;
};

const DEMO_FLAGS = new Set(["--stor", "--aterstall", "--radera", "--original"]);

export function resolveDemoSeedTarget(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DemoSeedTarget {
  if (argv.includes("--write-csv")) {
    throw new SeedTargetError("--write-csv finns bara för npm run db:seed.");
  }
  const dateAt = argv.indexOf("--datum");
  const date = dateAt >= 0 ? (argv[dateAt + 1] ?? "") : null;
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new SeedTargetError("--datum vill ha ett datum som ÅÅÅÅ-MM-DD.");
  }
  const original = argv.includes("--original");
  if (original && date !== null) {
    throw new SeedTargetError("Ange antingen --datum eller --original, inte båda.");
  }
  const rest = argv.filter(
    (a, i) => !DEMO_FLAGS.has(a) && !(dateAt >= 0 && (i === dateAt || i === dateAt + 1)),
  );
  const target = resolveSeedTarget(rest, env);
  if (target.mode !== "database") {
    throw new SeedTargetError("Demon seedas alltid till en databas.");
  }
  const reset = argv.includes("--aterstall");
  const deleteOnly = argv.includes("--radera");
  if (reset && deleteOnly) {
    throw new SeedTargetError("Ange antingen --aterstall eller --radera, inte båda.");
  }
  return { ...target, large: argv.includes("--stor"), reset, deleteOnly, date, original };
}
