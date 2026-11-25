/**
 * Pengar, Butiker och Mer i V2 (G4) på datorn och på en iPhone 15: ägaren ser resultatet,
 * vem pengarna är till (Min andel först), vattenfallet och tabellen per automat, butikslistan
 * med den valda butiken och Mer utan sidledsrullning. Påfyllaren skickas bort från Pengar och
 * Butiker och får 403 på exporten.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  type Browser,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

let browser: Browser;
const errors: Error[][] = [];

beforeAll(async () => {
  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
  errors.length = 0;
});

afterAll(async () => {
  await browser?.close();
});

async function pageFor(email: string, options: Parameters<typeof openPage>[2]): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, options);
  errors.push(opened.errors);
  await login(opened.page, email);
  return opened.page;
}

async function noSideScroll(page: Page): Promise<void> {
  const [scroll, inner] = await page.evaluate((): [number, number] => [
    document.documentElement.scrollWidth,
    Math.min(window.innerWidth, window.screen.width),
  ]);
  expect(scroll).toBeLessThanOrEqual(inner);
}

describe.each([
  ["dator", { viewport: "desktop" as const }],
  ["iPhone 15", { device: "iPhone 15" }],
])("Pengar, Butiker och Mer V2 på %s", (name, options) => {
  it("ägaren: Pengar", async () => {
    const page = await pageFor(e2e().users.owner, options);
    await page.goto("/pengar");
    await page.getByRole("heading", { level: 1, name: /Pengar/ }).waitFor();
    await page.locator('[data-testid="pengar-vinst"]').waitFor();
    await page.locator('[data-waterfall="result"]').waitFor();
    // Vem pengarna är till: Min andel först (eller en lugn rad utan försäljning).
    await page
      .locator('[data-testid="pengar-fordelning"], [data-testid="split-empty"]')
      .first()
      .waitFor();
    const split = page.locator('[data-testid="pengar-fordelning"] [data-split-row]');
    if ((await split.count()) > 0) {
      expect(await split.first().getAttribute("data-split-row")).toBe("owner");
    }
    await page.waitForLoadState("networkidle");
    await noSideScroll(page);
    await screenshot(page, `pengar-v2-agare-${name}`);
  });

  it("ägaren: Butiker och Mer", async () => {
    const page = await pageFor(e2e().users.owner, options);
    await page.goto("/butiker");
    await page.getByRole("heading", { level: 1, name: /Butiker/ }).waitFor();
    await page.locator("[data-shop]").first().waitFor();
    await page.waitForLoadState("networkidle");
    await noSideScroll(page);
    await screenshot(page, `butiker-v2-agare-${name}`);
    await page.goto("/mer");
    await page.locator('[data-testid="mer-v2"]').waitFor();
    await noSideScroll(page);
    await screenshot(page, `mer-v2-agare-${name}`);
  });

  it("påfyllaren: inga pengar", async () => {
    const page = await pageFor(e2e().users.refiller, options);
    await page.goto("/pengar");
    await page.waitForURL((url) => !url.pathname.startsWith("/pengar"));
    await page.goto("/butiker");
    await page.waitForURL((url) => !url.pathname.startsWith("/butiker"));
    const status = await page.evaluate(async () => (await fetch("/pengar/export")).status);
    expect(status).toBe(403);
  });
});
