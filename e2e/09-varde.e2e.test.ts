/**
 * Värde (/varde) på datorn och på en iPhone 15: ägaren ser rubriken, de fyra korten och
 * månadsväljaren utan sidledsrullning, kan öppna de hopfällda blocken och månadsrapporten
 * (A4 utan för högt innehåll), och Hem har kortet "Vad Binderlab gett dig". Delägaren
 * (läsare) skickas bort från sidan och rapporten.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
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
});

afterAll(async () => {
  await browser?.close();
});

async function ownerPage(options: Parameters<typeof openPage>[2]): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, options);
  errors.push(opened.errors);
  await login(opened.page, e2e().users.owner);
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
])("Värde på %s", (name, options) => {
  it("rubrik, kort, block och månadsrapport", async () => {
    const page = await ownerPage(options);
    await page.goto("/varde");
    const h1 = page.getByRole("heading", { level: 1 });
    await h1.waitFor();
    expect(await h1.innerText()).toMatch(/Binderlab|räddade|Kvar efter inköp|Inget att visa/);
    for (const label of ["Slutsålt undvikt", "Tid sparad", "Kvar efter inköp", "Försäljning"]) {
      expect(await page.getByText(label, { exact: true }).count()).toBeGreaterThan(0);
    }
    await page.getByRole("navigation", { name: "Välj månad" }).waitFor();
    await noSideScroll(page);
    // Medan sidan strömmas in kan blocket en kort stund finnas två gånger (den nya delen
    // ligger dold tills den byts in): vänta tills det finns exakt ett.
    const how = page.getByText("Så räknas det", { exact: true });
    await until(async () => (await how.count()) === 1, "Så räknas det finns en gång");
    await how.click();
    await page.getByText(/^Slutsålt undvikt: pack som såldes/).waitFor();
    await noSideScroll(page);
    await screenshot(page, `09-varde-${name === "dator" ? "dator" : "iphone15"}`);

    await page.getByRole("link", { name: "Månadsrapport" }).click();
    await page.waitForURL((url) => url.pathname === "/rapport/varde");
    await page.getByText("Bästa åtgärder.").first().waitFor();
    expect(await page.locator("[data-overflow]").count()).toBe(0);

    await page.goto("/");
    await page.locator('[data-testid="varde-card"]').waitFor();
  });
});

describe("Värde för läsaren", () => {
  it("skickas till Hem med förklaring", async () => {
    const opened = await openPage(browser, e2e().baseUrl, { viewport: "desktop" });
    errors.push(opened.errors);
    await login(opened.page, e2e().users.partner);
    await opened.page.goto("/varde");
    await opened.page.waitForURL((url) => url.searchParams.get("nekad") === "varde");
    await opened.page.goto("/rapport/varde");
    await opened.page.waitForURL((url) => url.searchParams.get("nekad") === "varde");
    expect(await opened.page.locator('[data-testid="varde-card"]').count()).toBe(0);
  });
});
