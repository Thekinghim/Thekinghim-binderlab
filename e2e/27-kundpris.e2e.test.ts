/**
 * Pris mot kund på Inköpspriser: ägaren ser vårt pris och pris mot kund bredvid varandra,
 * ändrar pris mot kund för sig och ihop med ett nytt inköpspris, och tar bort det igen.
 * Vinsten på Hem och Lönsamhet ändras inte av pris mot kund (den räknas på vårt pris).
 *
 * Titeln är Surging Sparks (seedens inköpspris 72 kr från 1 okt. 2026, ingen annan fil
 * ändrar den). Inköpspriser öppnas med standardperioden (slutar i dag), så att tabellen
 * visar priset som gäller i dag. Hem och Lönsamhet läses för seedens fasta period
 * (13 okt.–1 nov. 2026). Beloppen slumpas, så testet kan köras om.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const TITLE = "Surging Sparks";
const SEED_PERIOD = "from=2026-10-13&to=2026-11-01";
const NBSP = " ";

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
async function figures(p: Page = page): Promise<{ home: string; profitability: string }> {
  await p.goto(`/?${SEED_PERIOD}`);
  const home = await p.getByRole("heading", { level: 1 }).innerText();
  await p.goto(`/lonsamhet?${SEED_PERIOD}`);
  const kpis = p.getByRole("region", { name: /^Nyckeltal/ });
  await kpis.waitFor();
  return { home, profitability: await kpis.innerText() };
}

/** "145,37" ur öre. */
function text(ore: number): string {
  return `${Math.floor(ore / 100)},${String(ore % 100).padStart(2, "0")}`;
}

/** Ett belopp i öre som byts varje körning (aldrig jämna kronor, så det känns igen). */
function random(fromOre: number, spanOre: number, salt = 0): number {
  const ore = fromOre + ((Date.now() + salt) % spanOre);
  return ore % 100 === 0 ? ore + 1 : ore;
}

/** Sidan med titeln vald, och titelns formulär. */
async function openTitle(p: Page = page): Promise<Locator> {
  // Standardperioden (slutar i dag): tabellen visar då priset som gäller i dag.
  await p.goto("/inkopspriser");
  await p.getByRole("link", { name: TITLE, exact: true }).first().click();
  const form = p.getByRole("form", { name: `Nytt inköpspris för ${TITLE}` });
  await form.waitFor();
  return form;
}

/** Titelns tre tal i huvudet: vårt pris, pris mot kund och skillnad. */
function prices(p: Page = page): Locator {
  return p.locator(`dl[aria-label="Priser för ${TITLE}"]`);
}

/** Prisvakten kan be om ett extra tryck när inköpspriset ändras mycket: svara ja då. */
async function confirmIfAsked(saved: Locator): Promise<void> {
  const yes = page.getByRole("button", { name: "Ja, spara ändå" });
  const first = await Promise.race([
    saved.waitFor().then(
      () => "saved" as const,
      () => null,
    ),
    yes.waitFor().then(
      () => "asked" as const,
      () => null,
    ),
  ]);
  if (first === "asked") await yes.click();
  if (first !== "saved") await saved.waitFor();
}

describe("pris mot kund", () => {
  it("tabellen visar Vårt pris och Pris mot kund, och raden som säger vad vinsten räknas på", async () => {
    await openTitle();
    for (const name of ["Vårt pris", "Pris mot kund"]) {
      expect(
        await page.getByRole("columnheader", { name, exact: true }).first().isVisible(),
        name,
      ).toBe(true);
    }
    // Seeden: 30th Celebration kostar oss 112 kr och har 145 kr mot kund.
    const seeded = page.getByRole("row").filter({ hasText: "30th Celebration" }).first();
    await expect.poll(() => seeded.innerText()).toContain(`145,00${NBSP}kr`);
    expect(await seeded.innerText()).toContain(`+33,00${NBSP}kr · +29${NBSP}%`);
    await page
      .getByText("Vinsten räknas på vårt pris. Pris mot kund visas bara här.")
      .first()
      .waitFor();
  });

  it("Spara pris mot kund: priset och skillnaden visas, vinsten är densamma", async () => {
    const before = await figures();
    const form = await openTitle();
    const row = page.getByRole("row").filter({ hasText: TITLE }).first();

    const customer = random(11_000, 3_000);
    const field = form.getByLabel("Pris mot kund per pack");
    await field.fill(text(customer));
    // Skillnaden mot vårt pris räknas direkt, före sparandet.
    await form.getByText(/^Skillnad mot vårt pris: [+−]/).waitFor();
    await form.getByRole("button", { name: "Spara pris mot kund" }).click();
    await page.getByText("Pris mot kund sparat").first().waitFor();

    await expect.poll(() => row.innerText(), { timeout: 15_000 }).toContain(text(customer));
    const head = await prices().innerText();
    // Etiketterna visas i versaler (CSS): jämför utan hänsyn till det.
    expect(head).toMatch(/Vårt pris[\s\S]*Pris mot kund[\s\S]*Skillnad/i);
    expect(head).toContain(text(customer));
    // Ändringsloggen har en egen rad för pris mot kund.
    await page
      .getByRole("row")
      .filter({ hasText: "Pris mot kund" })
      .filter({ hasText: text(customer) })
      .first()
      .waitFor();
    // Samma belopp igen går inte att spara: knappen är avstängd tills fältet ändras.
    expect(
      await form.getByRole("button", { name: "Spara pris mot kund" }).getAttribute("disabled"),
    ).not.toBeNull();
    await screenshot(page, "27-kundpris-sparat");

    const after = await figures();
    expect(after.home).toBe(before.home);
    expect(after.profitability).toBe(before.profitability);
  });

  it("Nytt inköpspris från i dag sparar båda priserna, och historiken visar dem", async () => {
    const form = await openTitle();
    const row = page.getByRole("row").filter({ hasText: TITLE }).first();
    const cost = random(7_000, 400, 7);
    const customer = random(11_000, 3_000, 13);
    await form.getByLabel("Vårt pris per pack").fill(text(cost));
    await form.getByLabel("Pris mot kund per pack").fill(text(customer));
    await form.getByRole("button", { name: /^Nytt inköpspris från i dag/ }).click();
    await confirmIfAsked(page.getByText("Nytt inköpspris sparat").first());

    await expect.poll(() => row.innerText(), { timeout: 15_000 }).toContain(text(customer));
    expect(await row.innerText()).toContain(text(cost));
    const head = await prices().innerText();
    expect(head).toContain(text(cost));
    expect(head).toContain(text(customer));
    // Prishistoriken: perioden som gäller nu har båda priserna.
    const current = page.getByRole("listitem").filter({ hasText: "Gäller nu" }).first();
    await expect.poll(() => current.innerText()).toContain(text(cost));
    expect(await current.innerText()).toContain(`Pris mot kund ${text(customer)}`);
    // Fältet för pris mot kund står kvar med det sparade priset.
    expect(await form.getByLabel("Pris mot kund per pack").inputValue()).toBe(text(customer));
    await screenshot(page, "27-kundpris-bada");
  });

  it("tomt fält tar bort pris mot kund: ett streck, aldrig 0 kr", async () => {
    const form = await openTitle();
    await form.getByLabel("Pris mot kund per pack").fill("");
    await form.getByRole("button", { name: "Spara pris mot kund" }).click();
    await page.getByText("Pris mot kund borttaget").first().waitFor();
    await expect
      .poll(() => prices().innerText(), { timeout: 15_000 })
      .toMatch(/Pris mot kund\s*–\s*Skillnad\s*–/i);
    expect(await prices().innerText()).not.toMatch(/Pris mot kund\s*0/i);

    // Ett felskrivet pris sparas inte.
    await form.getByLabel("Pris mot kund per pack").fill("abc");
    await form.getByLabel("Anteckning").click();
    await form.getByText("Skriv pris mot kund i kronor, t.ex. 145.").waitFor();

    // Lägg tillbaka ett pris, så att nästa körning börjar med ett.
    await form.getByLabel("Pris mot kund per pack").fill("119");
    await form.getByRole("button", { name: "Spara pris mot kund" }).click();
    await page.getByText("Pris mot kund sparat").first().waitFor();
  });

  it("läsaren ser båda priserna men kan inte ändra dem", async () => {
    const reader = await openPage(browser, e2e().baseUrl, { theme: "light" });
    try {
      await login(reader.page, e2e().users.partner);
      await reader.page.goto("/inkopspriser");
      await reader.page.getByRole("link", { name: TITLE, exact: true }).first().click();
      const head = reader.page.locator(`dl[aria-label="Priser för ${TITLE}"]`);
      await head.waitFor();
      expect(await head.innerText()).toMatch(/Pris mot kund\s*119,00/i);
      expect(await reader.page.getByLabel("Pris mot kund per pack").count()).toBe(0);
      expect(await reader.page.getByRole("button", { name: "Spara pris mot kund" }).count()).toBe(
        0,
      );
      expectNoPageErrors(reader.errors);
    } finally {
      await reader.context.close();
    }
  });

  it("375 px: båda priserna och fältet syns utan att sidan rullar i sidled", async () => {
    const mobile = await openPage(browser, e2e().baseUrl, { theme: "light", viewport: "mobile" });
    try {
      await login(mobile.page, e2e().users.owner);
      await mobile.page.goto("/inkopspriser");
      await mobile.page.getByRole("link", { name: TITLE, exact: true }).first().click();
      const head = mobile.page.locator(`dl[aria-label="Priser för ${TITLE}"]`);
      await head.waitFor();
      expect(await head.innerText()).toMatch(/Vårt pris[\s\S]*Pris mot kund[\s\S]*Skillnad/i);
      const field = mobile.page.getByLabel("Pris mot kund per pack");
      await field.scrollIntoViewIfNeeded();
      expect(await field.isVisible()).toBe(true);
      const width = await mobile.page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(width.scroll).toBeLessThanOrEqual(width.inner);
      // Fältet och knappen ryms inom skärmen och är minst 44 px höga.
      for (const target of [
        field,
        mobile.page.getByRole("button", { name: "Spara pris mot kund" }),
      ]) {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width.inner);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await screenshot(mobile.page, "27-kundpris-mobil");
      expectNoPageErrors(mobile.errors);
    } finally {
      await mobile.context.close();
    }
  });
});
