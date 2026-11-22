/**
 * Periodvalet på datorn och på en iPhone 15: ägaren väljer I går på Hem (listan "Sålt i går"
 * visas och adressen får ?period=igar), väljer ett eget intervall i datumrutan/arket med
 * datumfälten, och nästa periodsida (Pengar) öppnas med samma intervall utan att välja om.
 * Påfyllaren ser vad som såldes i går, men inga kronor.
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

/** "ÅÅÅÅ-MM-DD" för en dag `back` dagar före i dag (i webbläsarens tid). */
function isoDaysAgo(back: number): string {
  const d = new Date();
  d.setDate(d.getDate() - back);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

describe.each([
  ["dator", { viewport: "desktop" as const }],
  ["iPhone 15", { device: "iPhone 15" }],
])("Periodvalet på %s", (name, options) => {
  it("ägaren: I går på Hem, eget intervall som följer med till Pengar", async () => {
    const page = await pageFor(e2e().users.owner, options);
    await page.goto("/");
    await page.getByRole("heading", { level: 1, name: /Hem/ }).waitFor();
    await page.getByRole("group", { name: "Period" }).first().waitFor();
    // Snabbvalet I går (det synliga segmentet: i sidhuvudet på datorn, under rubriken på telefon).
    await page
      .locator(".v2-seg-period:visible")
      .first()
      .getByRole("button", { name: "I går", exact: true })
      .click();
    await page.waitForURL((url) => url.searchParams.get("period") === "igar");
    await page.getByRole("heading", { name: /^Sålt i går/ }).waitFor();
    await screenshot(page, `datum-hem-igar-${name}`);

    // Eget intervall: datumknappen, datumfälten och Använd.
    const from = isoDaysAgo(13);
    const to = isoDaysAgo(7);
    await page
      .locator(".v2-seg-period:visible")
      .first()
      .getByRole("button", { name: /Välj datum|Period:/ })
      .click();
    await page.getByLabel("Från", { exact: true }).fill(from);
    await page.getByLabel("Till", { exact: true }).fill(to);
    await screenshot(page, `datum-valjare-${name}`);
    await page.getByRole("button", { name: "Använd" }).click();
    await page.waitForURL(
      (url) => url.searchParams.get("from") === from && url.searchParams.get("to") === to,
    );

    // Nästa periodsida utan ?period: kakan ger samma intervall.
    await page.goto("/pengar");
    await page.waitForURL(
      (url) => url.searchParams.get("from") === from && url.searchParams.get("to") === to,
    );
    await page.locator('[data-testid="pengar-vinst"]').waitFor();
    await screenshot(page, `datum-pengar-eget-${name}`);
  });

  it("påfyllaren: Sålt i går utan kronor", async () => {
    const page = await pageFor(e2e().users.refiller, options);
    await page.goto("/?period=igar");
    await page.getByRole("heading", { name: /^Sålt i går/ }).waitFor();
    const text = await page.locator(".o-sold").innerText();
    expect(text).not.toMatch(/\bkr\b/);
    // Fyll på:s retur (?fran=hem) är ingen period och skrivs aldrig om av proxyn.
    await page.goto("/fyll-pa?fran=hem");
    expect(new URL(page.url()).searchParams.get("fran")).toBe("hem");
  });
});
