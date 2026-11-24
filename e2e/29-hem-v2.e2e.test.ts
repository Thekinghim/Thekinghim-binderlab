/**
 * Hem i V2 (G1) på datorn och på en iPhone 15: ägaren ser dagens rad, KPI-bandet, Kräver
 * åtgärd, Dagens rutt, Att göra och Analys utan sidledsrullning, och periodvalet byter
 * analysens period. Påfyllaren har Hem som startsida och ser inga kronor alls.
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
])("Hem V2 på %s", (name, options) => {
  it("ägaren: band, kort och analys", async () => {
    const page = await pageFor(e2e().users.owner, options);
    await page.goto("/");
    await page.getByRole("heading", { level: 1, name: /Hem/ }).waitFor();
    await page.locator('section[aria-labelledby="hem-analys"]').waitFor();
    await page.locator(".act >> visible=true").first().waitFor();
    await page.locator(".rutt >> visible=true").first().waitFor();
    await page.locator(".todo >> visible=true").first().waitFor();
    await page.locator("#hem-ops").waitFor();
    await page.waitForLoadState("networkidle");
    await noSideScroll(page);
    await screenshot(page, `hem-v2-agare-${name}`);
    await page.goto("/?period=7d");
    await page.locator("#hem-analys").getByText("7 dagar").first().waitFor();
  });

  it("påfyllaren: Hem utan belopp", async () => {
    const page = await pageFor(e2e().users.refiller, options);
    await page.goto("/");
    await page.getByRole("heading", { level: 1, name: /Hem/ }).waitFor();
    await page.locator("#hem-ops").waitFor();
    await page.waitForLoadState("networkidle");
    const body = await page.locator("[data-v2-page]").innerText();
    expect(body).not.toMatch(/\d\s?kr\b/);
    expect(await page.locator(".v2-band").count()).toBe(0);
    await noSideScroll(page);
    await screenshot(page, `hem-v2-pafyllare-${name}`);
  });
});

describe("Hem V2 på iPhone 15, tillbaka till Hem", () => {
  // Hjälten får HeroIntros lugna klass när Hem visas igen i samma flik. Den hette förut
  // "calm", samma namn som Kräver åtgärds rad (.hem2 .calm, align-items: center): korten
  // krympte då till innehållets bredd mitt på skärmen efter ett periodbyte.
  it("hjältens kort fyller bredden efter ett besök på en annan sida", async () => {
    const page = await pageFor(e2e().users.owner, { device: "iPhone 15" });
    await page.goto("/");
    await page.locator(".hem2 .hh").waitFor();
    await page.locator(".v2-tabs").getByRole("link", { name: "Lager" }).click();
    await page.waitForURL((url) => url.pathname !== "/");
    await page.locator(".v2-tabs").getByRole("link", { name: "Hem" }).click();
    await page.locator(".hem2 .hh.hh-calm").waitFor();
    await page.locator(".v2-mperiod").getByRole("button", { name: "I går" }).click();
    await page.waitForURL((url) => url.searchParams.get("period") === "igar");
    await page.locator("main:not([aria-busy])").waitFor();
    const widths = await page.evaluate(() => {
      const hh = document.querySelector(".hem2 .hh");
      if (!hh) return null;
      const full = hh.getBoundingClientRect().width;
      return [...hh.children]
        .filter((c) => c.getBoundingClientRect().width > 0)
        .map((c) => Math.round(full - c.getBoundingClientRect().width));
    });
    expect(widths?.length).toBeGreaterThan(0);
    for (const gap of widths ?? []) expect(gap).toBe(0);
  });
});
