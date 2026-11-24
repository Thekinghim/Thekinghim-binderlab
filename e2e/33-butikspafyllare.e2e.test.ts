/**
 * Påfyllare i butiken (rollen machine_refiller), telefon först.
 *
 * 1. Ägaren (dator, 1440 × 900) öppnar automaten, Påfyllare i butiken → Lägg till påfyllare,
 *    skriver namn och mobilnummer och skapar kontot: PIN-koden och QR-koden visas.
 * 2. Personen (390 × 844) skannar QR-koden (/m/<nyckel>), skriver bara PIN-koden, väljer en
 *    egen PIN-kod, fyller på (förslaget är förifyllt), trycker Klart och Ångra. På datorn
 *    loggar hen in med mobilnummer och PIN-kod.
 * 3. Personen kommer aldrig åt appen: /, /automater, /lager, /fyll-pa, /portal och
 *    /installningar slutar på /pafyll, och ingenstans på /pafyll står "kr".
 *
 * Skärmbilder: E2E_SCREENSHOT_DIR (butikspafyll-*.png).
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
let sql: postgres.Sql;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];

const NAME = "Testperson Butik";
const PHONE = `070${String(Date.now()).slice(-7)}`;

let machine: { id: string; code: string };
let pin = "";
let qrLink = "";

async function page(viewport: { width: number; height: number }, mobile = false): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, {
    theme: "light",
    viewport: mobile ? "mobile" : "desktop",
  });
  await (
    opened.page as unknown as {
      setViewportSize(v: { width: number; height: number }): Promise<void>;
    }
  ).setViewportSize(viewport);
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened.page;
}

beforeAll(async () => {
  browser = await launchBrowser();
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1 });
  const [m] = await sql<{ id: string; code: string }[]>`
    select id, code from public.machines
    where organization_id = ${e2e().organizationId}::uuid and archived_at is null
    order by code limit 1`;
  machine = m!;
  // En Awish-läsning, så att förslaget finns (3 av 10 → fyll 7).
  const [t] = await sql<{ id: string }[]>`
    select id from public.titles where organization_id = ${e2e().organizationId}::uuid
      and merged_into_id is null order by name limit 1`;
  await sql`update public.stock_locations
    set awish_fill = ${sql.json([{ title_id: t!.id, units: 3, capacity: 10, channels: 1, empty: 0 }])},
        awish_synced_at = now()
    where organization_id = ${e2e().organizationId}::uuid and machine_id = ${machine.id}::uuid`;
  // Vårt lager på automatens plats säger samma sak (det går före Awish-läsningen).
  await sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
    select l.organization_id, l.id, ${t!.id}::uuid, 'count', 3, now()
    from public.stock_locations l
    where l.organization_id = ${e2e().organizationId}::uuid and l.kind = 'machine'
      and l.machine_id = ${machine.id}::uuid and l.archived_at is null
    limit 1`;
});

afterAll(async () => {
  for (const c of contexts) await c.close();
  await browser?.close();
  await sql?.end();
});

describe("påfyllare i butiken", () => {
  it("ägaren skapar kontot på automatens sida", async () => {
    const p = await page({ width: 1440, height: 900 });
    await login(p, e2e().users.owner);
    await p.goto(`/automater/${machine.code.toLowerCase()}`);
    await p.getByRole("button", { name: "Lägg till påfyllare" }).click();
    await p.getByLabel("Namn").fill(NAME);
    await p.getByLabel("Mobilnummer").fill(PHONE);
    await screenshot(p, "butikspafyll-1-agare-formular-1440");
    await p.getByRole("button", { name: "Skapa konto" }).click();
    const shown = p.locator('[data-testid="staff-pin"]');
    await shown.waitFor();
    pin = (await shown.innerText()).trim();
    expect(pin).toMatch(/^\d{6}$/);
    qrLink = (await p.locator('[data-testid="staff-qr"]').getAttribute("data-link")) ?? "";
    expect(qrLink).toMatch(/\/m\/[A-Za-z0-9_-]{43}$/);
    await screenshot(p, "butikspafyll-2-agare-pin-qr-1440");
    const [row] = await sql<{ hash: string }[]>`select pin_hash as hash from private.phone_logins
      where phone_e164 = ${`+46${PHONE.slice(1)}`}`;
    expect(row!.hash).not.toContain(pin);
    // Samma på telefonen.
    const phoneOwner = await page({ width: 390, height: 844 }, true);
    await login(phoneOwner, e2e().users.owner);
    await phoneOwner.goto(`/automater/${machine.code.toLowerCase()}`);
    await phoneOwner.getByText("Påfyllare i butiken").first().scrollIntoViewIfNeeded();
    await screenshot(phoneOwner, "butikspafyll-2-agare-kort-390");
  });

  it("personen loggar in, väljer PIN-kod, fyller på och ångrar (390 px)", async () => {
    const p = await page({ width: 390, height: 844 }, true);
    await p.goto(new URL(qrLink).pathname);
    await p.waitForURL(/\/logga-in\/mobil/);
    await p.getByText("Hej Testperson!").waitFor();
    await screenshot(p, "butikspafyll-3-inloggning-390");
    await p.getByLabel(/^PIN-kod/).fill(pin);
    await p.getByRole("button", { name: "Logga in" }).click();
    await p.waitForURL(/\/pafyll\/ny-pin/);
    await screenshot(p, "butikspafyll-4-ny-pin-390");
    await p.getByLabel("Ny PIN-kod").fill("482915");
    await p.getByLabel("Samma PIN-kod igen").fill("482915");
    await p.getByRole("button", { name: "Spara" }).click();
    await p.waitForURL((u) => u.pathname === "/pafyll");
    await p.getByRole("button", { name: /^Klart – jag har fyllt på \d+ pack$/ }).waitFor();
    await screenshot(p, "butikspafyll-5-fyll-pa-390");
    const body = await p.locator("main").innerText();
    expect(body).not.toMatch(/\bkr\b|SEK|Försäljning|Vinst/);
    await p.getByRole("button", { name: /^Klart – jag har fyllt på/ }).click();
    await p.getByText(/^Tack! Du har fyllt på \d+ pack\.$/).waitFor();
    await screenshot(p, "butikspafyll-6-klart-390");
    const [saved] = await sql<
      { n: number }[]
    >`select count(*)::int as n from public.field_submissions f
      join private.phone_logins l on l.user_id = f.submitted_by
      where l.phone_e164 = ${`+46${PHONE.slice(1)}`} and f.undone_at is null`;
    expect(saved!.n).toBeGreaterThan(0);
    await p.getByRole("button", { name: "Ångra (fel antal)" }).click();
    await p.getByText("Ångrat").waitFor();
    // Klar: tillbaka till listan med förslaget igen (inte samma inskick en gång till).
    await p.getByRole("button", { name: "Klar", exact: true }).click();
    await p.getByRole("button", { name: /^Klart – jag har fyllt på 7 pack$/ }).waitFor();
    const [left] = await sql<
      { n: number }[]
    >`select count(*)::int as n from public.field_submissions f
      join private.phone_logins l on l.user_id = f.submitted_by
      where l.phone_e164 = ${`+46${PHONE.slice(1)}`} and f.undone_at is null`;
    expect(left!.n).toBe(0);

    for (const path of ["/", "/automater", "/lager", "/fyll-pa", "/portal", "/installningar"]) {
      await p.goto(path);
      await p.waitForURL((u) => u.pathname.startsWith("/pafyll"));
    }

    // Samma skärm på datorn.
    const wide = await page({ width: 1440, height: 900 });
    await wide.goto("/logga-in/mobil");
    await wide.getByLabel("Mobilnummer").waitFor();
    await screenshot(wide, "butikspafyll-3-inloggning-1440");
    await wide.getByLabel("Mobilnummer").fill(PHONE);
    await wide.getByLabel(/^PIN-kod/).fill("482915");
    await wide.getByRole("button", { name: "Logga in" }).click();
    await wide.waitForURL((u) => u.pathname === "/pafyll");
    await wide.getByRole("button", { name: /^Klart/ }).waitFor();
    await screenshot(wide, "butikspafyll-5-fyll-pa-1440");
    await wide.getByRole("button", { name: /^Klart – jag har fyllt på/ }).click();
    await wide.getByText(/^Tack!/).waitFor();
    await screenshot(wide, "butikspafyll-6-klart-1440");
    for (const e of errors) expectNoPageErrors(e);
  });
});
