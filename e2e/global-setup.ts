/**
 * Förberedelser före e2e-testerna (körs en gång av vitest):
 *
 * 1. E2E_DATABASE_URL (krävs): databasen som servern under test använder. Lokal.
 * 2. E2E_RESET=1: återställ och seeda den först (som npm run db:reset + db:seed). I CI görs
 *    det i egna steg före next start, så där är E2E_RESET=0.
 * 3. Påfyllaren och en egen datakälla för importflödet (e2e/support/fixture.ts).
 * 4. Väntar tills servern (BASE_URL, standard http://localhost:3200) svarar.
 *
 * Fixturen lämnas till testerna med provide/inject.
 */

import path from "node:path";

import type { TestProject } from "vitest/node";

import { assertLocal, prepareFixture, resetAndSeed } from "./support/fixture";

const SEED_CSV = path.resolve(
  "test",
  "fixtures",
  "seed",
  "awish-orderlista-2026-10-13--2026-11-01.csv",
);

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(new URL("/logga-in", baseUrl), { redirect: "manual" });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Servern ${baseUrl} svarar inte (${last}). Starta den först (se docs/operations.md).`);
}

export default async function setup(project: TestProject): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL saknas: databasen som servern under test använder (t.ex. postgres://postgres@127.0.0.1:54322/binderlab_e2e).",
    );
  }
  assertLocal(url);
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3200";
  const password = process.env.E2E_PASSWORD ?? process.env.DEV_SEED_PASSWORD ?? "binderlab-dev";
  if (process.env.E2E_RESET === "1") {
    console.log(`[e2e] Återställer och seedar ${new URL(url).pathname.slice(1)} …`);
    await resetAndSeed(url, password);
  }
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const fixture = await prepareFixture(url, { password, runId });
  await waitForServer(baseUrl, Number(process.env.E2E_SERVER_TIMEOUT_MS ?? 120_000));
  project.provide("e2e", {
    ...fixture,
    baseUrl,
    seedCsv: SEED_CSV,
    outboxDir: path.resolve(process.env.E2E_OUTBOX_DIR ?? path.join(".data", "outbox")),
  });
}
