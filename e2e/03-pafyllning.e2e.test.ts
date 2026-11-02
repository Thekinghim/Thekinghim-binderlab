/**
 * Påfyllning i fält: påfyllaren på en mobil (375 px) registrerar påfyllning av en titel i en
 * automat och ser det nya saldot direkt. Påfyllaren ser ingen ekonomi: inga kronor på
 * sidan, inga ekonomisidor i menyn, och Lönsamhet, Ekonomi, Inköpspriser och Rapporter
 * skickar vidare.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];

beforeAll(async () => {
  browser = await launchBrowser();
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl, {
    viewport: "mobile",
    theme: "light",
  }));
  await login(page, e2e().users.refiller);
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const form = () => page.getByRole("form", { name: "Registrera påfyllning" });

/** Saldot i automaten enligt titelväljaren ("Ascended Heroes · 3 i automaten"). */
async function onHand(title: string): Promise<{ value: string; count: number }> {
  const option = form().getByLabel("Titel").locator("option").filter({ hasText: title }).first();
  const text = (await option.textContent()) ?? "";
  // Negativt saldo skrivs med typografiskt minus (U+2212).
  const match = /·\s*([-\u2212]?\d+)\s+i automaten/.exec(text);
  if (!match) throw new Error(`Saldot saknas i "${text}"`);
  const count = Number(match[1]!.replace("\u2212", "-"));
  return { value: (await option.getAttribute("value")) ?? "", count };
}

describe("påfyllning som påfyllare (375 px)", () => {
  it("registrerar påfyllning och ser nytt saldo", async () => {
    await page.goto("/drift/pafyllning");
    await form().waitFor();
    await form().getByLabel("Automat").selectOption({ index: 0 });
    const before = await onHand("Ascended Heroes");
    await form().getByLabel("Titel").selectOption(before.value);
    await form().getByLabel("Antal pack").fill("4");
    const central = form().getByLabel("Från centrallagret");
    if (await central.isChecked()) await central.uncheck();
    await screenshot(page, "03-pafyllning-formular-375");
    await form().getByRole("button", { name: "Registrera påfyllning" }).click();

    // Nytt saldo: titelväljaren räknar om när påfyllningen är sparad.
    await until(
      async () => (await onHand("Ascended Heroes")).count === before.count + 4,
      `saldot för Ascended Heroes blir ${before.count + 4}`,
    );
    await page.getByText("Påfyllning registrerad", { exact: true }).first().waitFor();
    await page
      .getByRole("heading", { level: 1 })
      .filter({ hasText: /pack påfyllda i dag/ })
      .waitFor();
    await screenshot(page, "03-pafyllning-registrerad-375");
  });

  it("ser ingen ekonomi", async () => {
    await page.goto("/drift/pafyllning");
    await form().waitFor();
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\d\s?kr\b|kronor|intäkt|vinst|marginal/i);
    for (const name of ["Lönsamhet", "Ekonomi", "Inköpspriser", "Rapporter"]) {
      expect(await page.getByRole("link", { name, exact: true }).count()).toBe(0);
    }
    for (const path of ["/lonsamhet", "/ekonomi", "/inkopspriser", "/rapporter"]) {
      await page.goto(path);
      await page.waitForURL((url) => !url.pathname.startsWith(path));
    }
  });
});
