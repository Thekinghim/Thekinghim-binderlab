/**
 * Rutt och Vårt lager i V2 (G3) på datorn och på en iPhone 15: sidorna ritas utan sidledsrullning
 * och utan sidfel. Ägaren ser Vårt lager med Per titel och Lagervärde; påfyllaren ser Rutt utan
 * kronor.
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
])("Rutt och Vårt lager V2 på %s", (name, options) => {
  it("ägaren: Rutt med packlista och Vårt lager med per titel", async () => {
    const page = await pageFor(e2e().users.owner, options);
    await page.goto("/rutt");
    await page.getByRole("heading", { level: 1, name: /Rutt/ }).waitFor();
    await page.locator(".v2-rutt").waitFor();
    await page.getByRole("heading", { name: /Packlista/ }).waitFor();
    await page.waitForLoadState("networkidle");
    await noSideScroll(page);
    await screenshot(page, `rutt-v2-agare-${name}`);

    await page.goto("/vart-lager");
    await page.getByRole("heading", { level: 1, name: /Vårt lager/ }).waitFor();
    await page.locator(".v2-lager").waitFor();
    await page.getByRole("heading", { name: /Per titel/ }).waitFor();
    await page.getByRole("heading", { name: /Lagervärde/ }).waitFor();
    await page.waitForLoadState("networkidle");
    await noSideScroll(page);
    await screenshot(page, `vart-lager-v2-agare-${name}`);
  });

  it("påfyllaren: Rutt utan kronor", async () => {
    const page = await pageFor(e2e().users.refiller, options);
    await page.goto("/rutt");
    await page.locator(".v2-rutt").waitFor();
    await page.waitForLoadState("networkidle");
    const body = await page.locator("[data-v2-page]").innerText();
    expect(body).not.toMatch(/\d\s?kr\b/);
    await noSideScroll(page);
    await screenshot(page, `rutt-v2-pafyllare-${name}`);
  });
});
