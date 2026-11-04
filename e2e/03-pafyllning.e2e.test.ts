/**
 * Påfyllning i fält: påfyllaren på en mobil (375 px) öppnar Drift → Påfyllning, ser dagens
 * påfyllningar och kommer med den stora knappen till Fyll på (registreringen testas i
 * 07-fyll-pa). Påfyllaren ser ingen ekonomi: inga kronor på sidan, inga ekonomisidor i
 * menyn, och Lönsamhet, Ekonomi, Inköpspriser och Rapporter skickar vidare.
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

describe("påfyllning som påfyllare (375 px)", () => {
  it("Drift → Påfyllning visar dagens påfyllningar och leder till Fyll på", async () => {
    await page.goto("/drift/pafyllning");
    await page
      .getByRole("heading", { level: 1 })
      .filter({ hasText: /påfyllt i dag|påfyllda i dag/ })
      .waitFor();
    // Ett sätt att registrera: Fyll på (det gamla formuläret finns inte kvar).
    expect(await page.getByRole("form", { name: "Registrera påfyllning" }).count()).toBe(0);
    await screenshot(page, "03-pafyllning-logg-375");
    await page
      .getByRole("link", { name: /^Fyll på/ })
      .first()
      .click();
    await page.waitForURL((url) => url.pathname.startsWith("/fyll-pa"));
  });

  it("ser ingen ekonomi", async () => {
    await page.goto("/drift/pafyllning");
    await page.getByRole("heading", { level: 1 }).waitFor();
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
