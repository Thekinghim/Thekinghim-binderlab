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
 */

import { resolveSeedTarget, SeedTargetError, type SeedTarget } from "../target";

export type DemoSeedTarget = Extract<SeedTarget, { mode: "database" }> & {
  large: boolean;
  reset: boolean;
  deleteOnly: boolean;
};

const DEMO_FLAGS = new Set(["--stor", "--aterstall", "--radera"]);

export function resolveDemoSeedTarget(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DemoSeedTarget {
  if (argv.includes("--write-csv")) {
    throw new SeedTargetError("--write-csv finns bara för npm run db:seed.");
  }
  const rest = argv.filter((a) => !DEMO_FLAGS.has(a));
  const target = resolveSeedTarget(rest, env);
  if (target.mode !== "database") {
    throw new SeedTargetError("Demon seedas alltid till en databas.");
  }
  const reset = argv.includes("--aterstall");
  const deleteOnly = argv.includes("--radera");
  if (reset && deleteOnly) {
    throw new SeedTargetError("Ange antingen --aterstall eller --radera, inte båda.");
  }
  return { ...target, large: argv.includes("--stor"), reset, deleteOnly };
}
