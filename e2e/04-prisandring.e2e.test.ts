/**
 * Prisändring: ägaren lägger in ett inköpspris för en titel. Vinsten på Lönsamhet och Hem
 * ändras, och ändringen syns i titelns ändringslogg med det nya priset.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  launchBrowser,
  openPage,
  screenshot,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const TITLE = "Perfect Order";

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  ({ page, context } = await openPage(browser, e2e().baseUrl, { theme: "light" }));
  await login(page, e2e().users.owner);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

/** Hems rubrik (intäkt och vinst) och Lönsamhets nyckeltal. */
async function figures(): Promise<{ home: string; profitability: string }> {
  await page.goto("/");
  const home = await page.getByRole("heading", { level: 1 }).innerText();
  await page.goto("/lonsamhet");
  const kpis = page.getByRole("region", { name: /^Nyckeltal/ });
  await kpis.waitFor();
  return { home, profitability: await kpis.innerText() };
}

/** Ett pris som skiljer sig från titelns nuvarande (testet kan köras flera gånger). */
function newPrice(): string {
  const ore = 3_000 + (Date.now() % 4_000);
  return `${Math.floor(ore / 100)},${String(ore % 100).padStart(2, "0")}`;
}

describe("prisändring", () => {
  it("nytt inköpspris ändrar Lönsamhet och Hem och loggas", async () => {
    const before = await figures();
    expect(before.home).toMatch(/Vinst/);

    await page.goto("/inkopspriser");
    await page.getByRole("link", { name: TITLE, exact: true }).first().click();
    const form = page.getByRole("form", { name: `Nytt inköpspris för ${TITLE}` });
    await form.waitFor();
    const log = page.getByRole("heading", { name: /Ändringslogg/ });
    await log.waitFor();

    const price = newPrice();
    await form.getByLabel("Inköpspris per pack").fill(price);
    // Från titelns första order i seeden (15 okt.), så att priset gäller alla dess order.
    // Körs testet igen ersätts samma dags pris ("ändrat") med ett annat belopp.
    await form.getByLabel("Giltig från").fill("2026-10-15");
    await form.getByLabel("Anteckning").fill("E2E: nytt pris från leverantören");
    await form.getByRole("button", { name: "Spara pris" }).click();
    await page
      .getByText(/^Inköpspriset (sparat|ändrat)$/)
      .first()
      .waitFor();

    // Ändringsloggen (och prishistoriken) visar det nya priset med anteckningen.
    await page
      .getByRole("row")
      .filter({ hasText: price })
      .filter({ hasText: "E2E: nytt pris från leverantören" })
      .first()
      .waitFor();
    await log.scrollIntoViewIfNeeded();
    await screenshot(page, "04-prisandring-andringslogg");

    const after = await figures();
    expect(after.profitability).not.toBe(before.profitability);
    expect(after.home).not.toBe(before.home);
    await screenshot(page, "04-prisandring-lonsamhet");
  });
});
