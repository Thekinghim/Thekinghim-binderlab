/**
 * Import: körningens orderlista (rader ur seedens Awish-CSV med körningens egna ordernummer,
 * e2e/support/fixture.ts) laddas upp till datakällan "E2E-import", förhandsvisas (inget
 * sparas), bekräftas (12 nya order) och laddas upp en gång till (0 nya: alla är dubbletter).
 * Ordern syns sedan under Order.
 */

import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

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
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { theme: "light" }));
  await login(page, e2e().users.owner);
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

/** Väljer källan, laddar upp körningens CSV och väntar på förhandsvisningen. */
async function uploadRunCsv(): Promise<void> {
  await page.goto("/datakallor#ladda-upp");
  await page.getByLabel("Datakälla").selectOption({ label: e2e().importSource.name });
  await page.locator('input[type="file"]').setInputFiles(e2e().importCsv.file);
  await page.getByText("Förhandsvisning · inget är sparat ännu").waitFor();
}

describe("import av orderlistan", () => {
  const rows = () => e2e().importCsv.rows;

  it("förhandsvisning och import: alla rader blir nya order", async () => {
    await uploadRunCsv();
    const confirm = page.getByRole("button", { name: `Importera ${rows()} order`, exact: true });
    await confirm.waitFor();
    await page.getByText("Förhandsvisning · inget är sparat ännu").scrollIntoViewIfNeeded();
    await screenshot(page, "02-import-forhandsvisning");
    await confirm.click();
    await page.getByText("Importerad", { exact: true }).waitFor();
    await page
      .getByText(new RegExp(`${rows()} nya order importerade`))
      .first()
      .waitFor();
    await page.getByText("Importerad", { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, "02-import-klar");
  });

  it("ordern finns under Order", async () => {
    const orderNo = e2e().importCsv.orderNumbers[0]!;
    await page.goto(`/order?q=${encodeURIComponent(orderNo)}&period=allt`);
    await page.getByText(orderNo).first().waitFor();
    await screenshot(page, "02-import-order");
  });

  it("samma fil igen ger 0 nya order", async () => {
    await uploadRunCsv();
    const save = page.getByRole("button", { name: "Spara i loggen (0 nya)" });
    await save.waitFor();
    const importButtons = page.getByRole("button", { name: /^Importera \d/ });
    if ((await importButtons.count()) > 0) throw new Error("Importknappen visas för 0 nya order.");
    await page.getByText(/Inget nytt att importera/).waitFor();
    await save.click();
    await page.getByText("Importerad", { exact: true }).waitFor();
    await page
      .getByText(new RegExp(`Inga nya order: ${rows()} fanns redan`))
      .first()
      .waitFor();
    await page.getByText("Importerad", { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, "02-import-andra-gangen");
  });
});
