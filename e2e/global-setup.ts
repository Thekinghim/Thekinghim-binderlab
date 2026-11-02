/**
 * Förberedelser före e2e-testerna (körs en gång av vitest):
 *
 * 1. E2E_DATABASE_URL (krävs): databasen som servern under test använder. Lokal, med "e2e"
 *    eller "test" i namnet och inte samma som .env.local (e2e/support/fixture.ts).
 * 2. E2E_RESET=1: återställ och seeda den först (som npm run db:reset + db:seed). I CI görs
 *    det i egna steg innan servern startar, så där är E2E_RESET=0.
 * 3. Påfyllaren, datakällorna och körningens orderlistor (e2e/support/fixture.ts).
 * 4. Väntar tills servern (E2E_BASE_URL eller BASE_URL, standard http://localhost:3210, den
 *    egna e2e-servern; port 3200, den vanliga dev-servern, vägras)
 *    svarar, och kontrollerar att den använder E2E_DATABASE_URL: påfyllaren loggar in med
 *    körningens nya lösenord, vilket bara går om servern läser samma databas.
 *
 * Fixturen lämnas till testerna med provide/inject.
 */

import path from "node:path";

import type { TestProject } from "vitest/node";

import { launchBrowser, openPage } from "./support/browser";
import { assertE2eDatabase, prepareFixture, resetAndSeed } from "./support/fixture";

/** Standard: den egna e2e-servern (scripts/e2e/local-server.sh), aldrig den delade på 3200. */
export const DEFAULT_BASE_URL = "http://localhost:3210";

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
  throw new Error(
    `Servern ${baseUrl} svarar inte (${last}). Starta den först (se docs/operations.md).`,
  );
}

/** Påfyllaren loggar in med körningens lösenord: servern läser alltså E2E_DATABASE_URL. */
async function assertServerUsesDatabase(
  baseUrl: string,
  email: string,
  password: string,
  database: string,
): Promise<void> {
  const browser = await launchBrowser();
  try {
    const { page } = await openPage(browser, baseUrl, { viewport: "mobile" });
    await page.goto("/logga-in");
    await page.getByLabel("E-postadress").fill(email);
    await page.getByLabel("Lösenord").fill(password);
    await page.getByRole("button", { name: "Logga in", exact: true }).click();
    // Den som förlorar kapplöpningen avbryts när webbläsaren stängs: fångas här.
    const outcome = await Promise.race([
      page
        .waitForURL((url) => !url.pathname.startsWith("/logga-in"))
        .then(() => "in" as const)
        .catch(() => "tid" as const),
      page
        .getByRole("alert")
        .filter({ hasText: /lösenord|e-post/i })
        .waitFor()
        .then(() => "fel" as const)
        .catch(() => "tid" as const),
    ]);
    if (outcome !== "in") {
      throw new Error(
        `Servern ${baseUrl} använder inte databasen ${database} (påfyllaren kom inte in med körningens lösenord). Starta servern mot E2E_DATABASE_URL.`,
      );
    }
  } finally {
    await browser.close();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL saknas: databasen som servern under test använder (t.ex. postgres://postgres@127.0.0.1:54322/binderlab_e2e).",
    );
  }
  assertE2eDatabase(url);
  // E2E_BASE_URL eller BASE_URL. Vite sätter själv BASE_URL till "/" i testprocessen, så
  // bara en absolut adress räknas.
  const given = [process.env.E2E_BASE_URL, process.env.BASE_URL].find((u) =>
    /^https?:\/\//.test(u ?? ""),
  );
  const baseUrl = given ?? DEFAULT_BASE_URL;
  if (new URL(baseUrl).port === "3200" && process.env.E2E_ALLOW_PORT_3200 !== "1") {
    throw new Error(
      "BASE_URL pekar på port 3200, den vanliga dev-servern. Kör mot en egen e2e-server (scripts/e2e/local-server.sh, port 3210).",
    );
  }
  const password = process.env.E2E_PASSWORD ?? process.env.DEV_SEED_PASSWORD ?? "binderlab-dev";
  if (process.env.E2E_RESET === "1") {
    console.log(`[e2e] Återställer och seedar ${new URL(url).pathname.slice(1)} …`);
    await resetAndSeed(url, password);
  }
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const fixture = await prepareFixture(url, {
    password,
    runId,
    filesDir: path.resolve(".data", "e2e-filer"),
  });
  const { databaseName, ...rest } = fixture;
  await waitForServer(baseUrl, Number(process.env.E2E_SERVER_TIMEOUT_MS ?? 120_000));
  await assertServerUsesDatabase(
    baseUrl,
    fixture.users.refiller,
    fixture.refillerPassword,
    databaseName,
  );
  project.provide("e2e", {
    ...rest,
    baseUrl,
    outboxDir: path.resolve(process.env.E2E_OUTBOX_DIR ?? path.join(".data", "outbox")),
    cronSecret: process.env.E2E_CRON_SECRET ?? process.env.CRON_SECRET ?? null,
  });
}
