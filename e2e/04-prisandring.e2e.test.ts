/**
 * Prisändring: ägaren lägger in ett inköpspris för en titel. Vinsten på Lönsamhet och Hem
 * ändras, och ändringen syns i titelns ändringslogg med det nya priset.
 *
 * Hem och Lönsamhet läses för seedens fasta period (13 okt – 1 nov 2026) i adressen, inte
 * standardperioden (senaste 30 dagarna), så att testet inte beror på dagens datum.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { PRICE_TITLE, PRICE_VALID_FROM } from "./support/fixture";
import { e2e, login } from "./support/session";

const TITLE = PRICE_TITLE;
/** Seedens orderperiod (test/fixtures/seed/awish-orderlista-2026-10-13--2026-11-01.csv). */
const SEED_PERIOD = "from=2026-10-13&to=2026-11-01";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];

beforeAll(async () => {
  browser = await launchBrowser();
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { theme: "light" }));
  await login(page, e2e().users.owner);
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

/** Hems rubrik (intäkt och vinst) och Lönsamhets nyckeltal. */
async function figures(): Promise<{ home: string; profitability: string }> {
  await page.goto(`/?${SEED_PERIOD}`);
  const home = await page.getByRole("heading", { level: 1 }).innerText();
  await page.goto(`/lonsamhet?${SEED_PERIOD}`);
  const kpis = page.getByRole("region", { name: /^Nyckeltal/ });
  await kpis.waitFor();
  return { home, profitability: await kpis.innerText() };
}

/**
 * Ett pris som skiljer sig från titelns nuvarande pris för dagen (läst ur databasen före
 * körningen), så att testet kan köras flera gånger mot samma databas.
 */
function newPrice(): string {
  let ore = 3_000 + (Date.now() % 4_000);
  if (ore === e2e().priceBefore) ore += 1;
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
    await form.getByLabel("Giltig från").fill(PRICE_VALID_FROM);
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

  it("klick var som helst på titelraden visar redigeraren, och direktlänk sparar", async () => {
    // Klick i en sifferkolumn, inte på namnet: redigeraren rullas fram med markören i priset.
    await page.goto("/inkopspriser");
    const row = page.getByRole("row").filter({ hasText: TITLE }).first();
    await row.locator("td:visible").last().click();
    const form = page.getByRole("form", { name: `Nytt inköpspris för ${TITLE}` });
    await form.waitFor();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("name")))
      .toBe("unitCost");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const top = document.querySelector('input[name="unitCost"]')?.getBoundingClientRect().top;
          return top !== undefined && top >= 0 && top < window.innerHeight;
        }),
      )
      .toBe(true);

    // Direktlänk (Hem, Att göra) och klick direkt: knappen väntar in sidans skript i stället
    // för att ladda om sidan och tappa priset (felet "jag kan inte ändra inköpspriser").
    const url = page.url();
    await page.goto(url, { waitUntil: "commit" });
    const price = newPrice();
    await form.getByLabel("Inköpspris per pack").fill(price);
    await form.getByLabel("Giltig från").fill(PRICE_VALID_FROM);
    await form.getByRole("button", { name: "Spara pris" }).click();
    await page
      .getByText(/^Inköpspriset (sparat|ändrat)$/)
      .first()
      .waitFor();
    expect(page.url()).toBe(url);
  });
});
