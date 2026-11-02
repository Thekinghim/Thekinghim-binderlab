/**
 * Gemensam start för skripten i scripts/deploy: tolkar argument, kopplar
 * riktiga beroenden (fetch, väntan, generatorer, migreringsfilerna) och
 * skriver en svensk sammanfattning. Avslutar med kod 1 vid fel.
 */

import { readMigrations } from "../../../src/db/migrator";
import { buildOptions, parseArgs, USAGE, UsageError, type Phase } from "./config";
import { realSleep } from "./http";
import { createLogger, defaultSink, type Logger } from "./log";
import { runDeploy, type Deps, type Outcome } from "./pipeline";
import { generateCronSecret, generatePassword, generateVapidKeys } from "./secrets";

export function realDeps(log: Logger, env: Record<string, string | undefined>): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    sleep: realSleep,
    log,
    readMigrations: () => readMigrations(),
    generatePassword,
    generateCronSecret,
    generateVapidKeys,
    devDbPassword: env.SUPABASE_DEV_DB_PASSWORD?.trim() || undefined,
  };
}

export function printSummary(log: Logger, outcome: Outcome, dryRun: boolean): void {
  log.step(dryRun ? "Sammanfattning (dry-run, inget ändrades)" : "Sammanfattning");
  log.info(`Utveckling (Preview): Supabase ${outcome.devRef}`);
  log.info(
    `Produktion: Supabase ${outcome.prodRef ?? "(skapas)"}${outcome.appUrl ? `, ${outcome.appUrl}` : ""}`,
  );
  if (outcome.deployed) log.info("En ny produktionsversion driftsattes.");
  if (log.warnings.length > 0) log.info(`${log.warnings.length} varning(ar) ovan.`);
  if (outcome.manual.length > 0) {
    log.info("Kvar att göra för hand:");
    for (const line of new Set(outcome.manual)) log.info(`  - ${line}`);
  } else {
    log.ok("Inget kvar att göra för hand.");
  }
  if (!outcome.ok) log.error("Kontrollen av /logga-in gick inte igenom; se ovan.");
}

export async function main(phases: readonly Phase[], argv = process.argv.slice(2)): Promise<void> {
  const log = createLogger(defaultSink);
  try {
    const args = parseArgs(argv);
    if (args.flags.has("--help")) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const options = buildOptions(args, process.env, phases);
    if (phases.length === 1 && phases[0] === "invite" && !options.ownerEmail) {
      throw new UsageError(
        "Ange ägarens e-post, t.ex. npx tsx scripts/deploy/invite-owner.ts ägare@exempel.se",
      );
    }
    const outcome = await runDeploy(options, realDeps(log, process.env));
    printSummary(log, outcome, options.dryRun);
    if (!outcome.ok) process.exitCode = 1;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${log.redact(error.message)}\n`);
    } else {
      log.error(error instanceof Error ? error.message : String(error));
      log.info(
        "Allt som redan gjorts ligger kvar; skripten är idempotenta, så kör samma kommando igen när felet är åtgärdat.",
      );
    }
    process.exitCode = 1;
  }
}
