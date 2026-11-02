/**
 * Import: seedens orderlista (Awish-CSV) laddas upp till en egen datakälla, förhandsvisas
 * (inget sparas), bekräftas (nya order) och laddas upp en gång till (0 nya: alla är
 * dubbletter). Importloggen visar båda.
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

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  ({ page, context } = await openPage(browser, e2e().baseUrl));
  await login(page, e2e().users.owner);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

/** Väljer källan, laddar upp seed-CSV:n och väntar på förhandsvisningen. */
async function uploadSeedCsv(): Promise<void> {
  await page.goto("/datakallor");
  await page.getByLabel("Datakälla").selectOption({ label: e2e().importSource.name });
  await page.locator('input[type="file"]').setInputFiles(e2e().seedCsv);
  await page.getByText("Förhandsvisning · inget är sparat ännu").waitFor();
}

describe("import av orderlistan", () => {
  it("förhandsvisning och import: 460 nya order", async () => {
    await uploadSeedCsv();
    const confirm = page.getByRole("button", { name: /^Importera 460 order$/ });
    await confirm.waitFor();
    await screenshot(page, "02-import-forhandsvisning");
    await confirm.click();
    await page.getByText("Importerad", { exact: true }).waitFor();
    await page.getByText(/460 nya order importerade/).first().waitFor();
    await screenshot(page, "02-import-klar");
  });

  it("samma fil igen ger 0 nya order", async () => {
    await uploadSeedCsv();
    const save = page.getByRole("button", { name: "Spara i loggen (0 nya)" });
    await save.waitFor();
    expect(await page.getByRole("button", { name: /^Importera \d/ }).count()).toBe(0);
    await page.getByText(/Inget nytt att importera/).waitFor();
    await save.click();
    await page.getByText("Importerad", { exact: true }).waitFor();
    await page.getByText(/Inga nya order: 460 fanns redan/).first().waitFor();
    await screenshot(page, "02-import-andra-gangen");
  });
});
