/**
 * Rapportutskick: ägaren lägger till butikens mottagare, skapar butiksrapporten för oktober,
 * godkänner den (PDF skapas) och skickar. Mejlet hamnar i serverns lokala utkorg
 * (MAIL_PROVIDER=outbox) med rätt mottagare, ämne, hälsning och PDF som bilaga. Till sist
 * pausas mottagaren, så att mottagarlistan inte växer för varje körning.
 *
 * Rapporten är den korta (standard): uträkningen och summor på en A4-sida, utan titlar,
 * snittköp och service, i förhandsvisningen, PDF:en och mejlet. Med butikens val "Visa
 * detaljer i rapporten" visar förhandsvisningen titlarna och service igen, medan den
 * redan skickade rapporten står kvar som den skickades.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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

const STORE = "Gallerian Väst (exempel)";
/** Det som bara visas med "Visa detaljer i rapporten". */
const DETAILS_ONLY = ["Snittköp", "Flest köp", "Titlar", "Service", "Påfyllningsbesök"];
const MONTH = "oktober 2026";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];
const run = Date.now().toString(36);
const recipient = { name: `Butikschef ${run}`, email: `butik-${run}@example.se` };
const greeting = `Tack för oktober! (${run})`;

interface OutboxMeta {
  to: string;
  subject: string;
  tags: Record<string, string>;
  attachments: { filename: string; contentType: string; size: number }[];
}

/** Mejlet till adressen i serverns utkorg, när det finns. */
async function findMail(to: string): Promise<{ dir: string; meta: OutboxMeta } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(e2e().outboxDir);
  } catch {
    return undefined;
  }
  for (const entry of entries.sort().reverse()) {
    const dir = path.join(e2e().outboxDir, entry);
    try {
      const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as OutboxMeta;
      if (meta.to === to) return { dir, meta };
    } catch {
      // Mappen skrivs just nu, eller är inget mejl.
    }
  }
  return undefined;
}

beforeAll(async () => {
  browser = await launchBrowser();
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl));
  await login(page, e2e().users.owner);
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

/** Butikens sida, fliken Kontakt och rapport (där brytaren står). */
async function openStoreReportSettings(): Promise<void> {
  await page.goto("/butiker");
  await page.getByRole("link", { name: STORE }).first().click();
  await page.waitForURL(/\/butiker\/[0-9a-f-]{36}/);
  await page.goto(`${new URL(page.url()).pathname}?vy=kontakt`);
}

describe("rapportutskick", () => {
  it("lägger till butikens mottagare", async () => {
    await page.goto("/rapporter?vy=mottagare");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Lägg till", exact: true }) });
    await form.getByLabel("Typ").selectOption({ label: "Butik" });
    await form.getByLabel("Butik").selectOption({ label: STORE });
    await form.getByLabel("Namn").fill(recipient.name);
    await form.getByLabel("E-post").fill(recipient.email);
    await form.getByRole("button", { name: "Lägg till", exact: true }).click();
    await page.getByText(recipient.email).first().waitFor();
  });

  it("skapar, godkänner och skickar butiksrapporten", async () => {
    await page.goto("/rapporter");
    const builder = page.locator('section[aria-labelledby="ny-rapport"]');
    await builder.getByRole("radio", { name: "Butik" }).check();
    await builder.getByLabel("Månad").selectOption({ label: MONTH });
    await builder.getByLabel("Butik").selectOption({ label: STORE });
    await builder.getByLabel("Personlig hälsning").fill(greeting);
    // "Skapa ny version" när testet körts förut mot samma databas.
    await builder.getByRole("button", { name: /^Skapa (utkast|ny version)$/ }).click();

    // Godkännandet skapar PDF:en (headless Chromium på servern) och kan ta en stund.
    const approve = page.getByRole("button", { name: "Godkänn för utskick" });
    await approve.waitFor();
    // Förhandsvisningen är den korta rapporten: beloppet i rubriken och inga detaljer.
    const preview = page.locator('section[aria-labelledby="forhandsvisning"]');
    await preview.getByText("Underlag per titel finns på begäran.").waitFor();
    await preview
      .getByText(/^Er ersättning för oktober: /)
      .first()
      .waitFor();
    await preview.getByText("Så räknas ersättningen.").waitFor();
    for (const word of DETAILS_ONLY) expect(await preview.getByText(word).count(), word).toBe(0);
    await screenshot(page, "05-rapport-utkast");
    await approve.click();
    await page.getByText("Rapporten är godkänd").first().waitFor({ timeout: 120_000 });

    // Bara den här körningens mottagare (tidigare körningar kan ha lagt till fler).
    const group = page.getByRole("group", { name: "Skicka till" });
    await group.getByRole("checkbox", { name: new RegExp(recipient.email) }).waitFor();
    const boxes = group.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i += 1) {
      const box = boxes.nth(i);
      const label = await page.locator(`label[for="${await box.getAttribute("id")}"]`).innerText();
      if (label.includes(recipient.email)) await box.check();
      else await box.uncheck();
    }
    const send = page.getByRole("button", { name: "Skicka till 1 mottagare" });
    await send.click();
    await page.getByText("Rapport skickad").first().waitFor({ timeout: 120_000 });
    await page.getByText("Har fått den").first().waitFor();
    await screenshot(page, "05-rapport-skickad");
  });

  it("mejlet ligger i utkorgen med PDF och hälsningen", async () => {
    const mail = await until(() => findMail(recipient.email), `mejl till ${recipient.email}`);
    expect(mail.meta.subject).toBe(`Butiksrapport ${MONTH} · ${STORE}`);
    expect(mail.meta.tags.report_id).toMatch(/^[0-9a-f-]{36}$/);
    const pdf = mail.meta.attachments.find((a) => a.contentType === "application/pdf");
    expect(pdf?.size).toBeGreaterThan(1_000);
    const pdfBytes = await readFile(path.join(mail.dir, pdf!.filename));
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    // Den korta rapporten får plats på en A4-sida.
    expect(pdfBytes.toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g)).toHaveLength(1);
    const html = await readFile(path.join(mail.dir, "message.html"), "utf8");
    expect(html).toContain(greeting);
    // Mejlet: beloppet i rubriken, ingen service och inga titlar.
    const text = await readFile(path.join(mail.dir, "message.txt"), "utf8");
    expect(text).toMatch(/Er ersättning för oktober: /);
    for (const word of ["Flest köp", "Påfyllningar", "Snittköp", "Drift och service"]) {
      expect(html, word).not.toContain(word);
      expect(text, word).not.toContain(word);
    }
    const eml = await readFile(path.join(mail.dir, "message.eml"), "utf8");
    expect(eml).toMatch(new RegExp(`^To: .*${recipient.email.replace(/\./g, "\\.")}`, "m"));
  });

  it("med Visa detaljer i rapporten visar förhandsvisningen titlar och service igen", async () => {
    // Brytaren står på butikens sida, under Kontakt och rapport.
    await openStoreReportSettings();
    const toggle = page.getByRole("switch", { name: `Visa detaljer i rapporten, ${STORE}` });
    await page.getByText("Titlar och service. Av: butiken får bara uträkningen.").waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    await toggle.click();
    await page.getByText("Klart! Rapporten visar detaljer.").waitFor();
    await screenshot(page, "05-butik-visa-detaljer");

    await page.goto("/rapporter");
    const builder = page.locator('section[aria-labelledby="ny-rapport"]');
    await builder.getByRole("radio", { name: "Butik" }).check();
    await builder.getByLabel("Månad").selectOption({ label: MONTH });
    await builder.getByLabel("Butik").selectOption({ label: STORE });
    const preview = page.locator('section[aria-labelledby="forhandsvisning"]');
    await preview.getByText("Påfyllningsbesök").first().waitFor();
    await preview.getByText("Snittköp").first().waitFor();
    await preview.getByText("Flest köp").first().waitFor();
    expect(await preview.getByText("Underlag per titel finns på begäran.").count()).toBe(0);
    // Den skickade rapporten ändras inte: den står kvar som skickad, utan ny version.
    await page.getByText("Rapporten är skickad.").first().waitFor();
    await screenshot(page, "05-rapport-med-detaljer");

    // Tillbaka till standard, så att nästa körning börjar likadant.
    await openStoreReportSettings();
    await toggle.click();
    await page.getByText("Klart! Rapporten visar bara uträkningen.").waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("mottagaren pausas efteråt", async () => {
    await page.goto("/rapporter?vy=mottagare");
    const row = page.getByRole("listitem").filter({ hasText: recipient.email });
    await row.getByRole("button", { name: "Pausa", exact: true }).click();
    await row.getByText("Pausad", { exact: true }).waitFor();
  });
});
