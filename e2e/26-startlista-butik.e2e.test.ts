/**
 * Startlista per ny butik och varningen i "Placera automat" på iPhone SE (375 px).
 *
 * En egen organisation med två nya butiker utan automat och en automat utan butik:
 * - "Klar butik" har villkor och ett kontrakt registrerat för hand (räknas som signerat).
 * - "Osignerad butik" har villkor och ett kontrakt från mallen som inte är signerat.
 *
 * Butiker → På väg in: "1 av 2 butiker är klara för automat.", bockarna syns utan att fälla
 * ut något, och varje butik har EN knapp ("Placera automat" respektive "Signera").
 * "Placera automat" öppnar rutan på automaten med butiken vald. Väljs den osignerade butiken
 * står det "Kontraktet är inte signerat. Signera först eller placera ändå.", och automaten
 * går att placera ändå. Efteråt har Automater "N saker kvar" på raden och Startklar-listan
 * överst på automatens sida.
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@/server/auth/password";

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

const DEVICE = "iPhone SE (3rd gen)";
const WARNING = "Kontraktet är inte signerat. Signera först eller placera ändå.";

let browser: Browser;
let sql: postgres.Sql;
let owner = "";
let readyStore = "";
let unsignedStore = "";
let machineId = "";
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];

const text = (s: string) => s.replace(/[ ⁠]/g, " ");

async function signedIn(): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark" });
  contexts.push(opened.context);
  errors.push(opened.errors);
  await login(opened.page, owner);
  return opened.page;
}

/** Ingen sidledes scroll, och länkar och knappar i avsnittet är minst 44 px. */
async function expectFits(page: Page, selector: string): Promise<void> {
  const problems = await page.evaluate((sel: string) => {
    const out: string[] = [];
    const doc = document.documentElement;
    const width = Math.min(window.innerWidth, window.screen.width);
    if (doc.scrollWidth > width) out.push(`sidan är ${doc.scrollWidth} px bred`);
    const root = document.querySelector(sel);
    if (!root) return [`${sel} saknas`];
    for (const el of Array.from(root.querySelectorAll("a[href], button"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.height < 44 || r.width < 44)) {
        out.push(
          `liten tryckyta ${Math.round(r.width)}×${Math.round(r.height)}: "${(el.textContent ?? "").trim().slice(0, 30)}"`,
        );
      }
    }
    return out;
  }, selector);
  expect(problems, problems.join("\n")).toEqual([]);
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const runId = e2e().runId;
  const id = runId.toLowerCase();
  owner = `startlista-${id}@binderlab.local`;
  const hash = await hashPassword(e2e().password);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${owner}, ${hash}, ${sql.json({ full_name: "E2E Startlista" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: user!.id,
      email: owner,
      role: "authenticated",
    })}, true), set_config('role', 'authenticated', true)`;
    const [org] = await tx<{ id: string }[]>`
      select public.create_organization(${`E2E Startlista ${runId}`}, ${`e2e-startlista-${id}`}) as id`;
    const orgId = org!.id;
    const store = async (name: string, template: string | null) => {
      const [s] = await tx<{ id: string }[]>`
        insert into public.stores (organization_id, name) values (${orgId}::uuid, ${name})
        returning id`;
      const [c] = await tx<{ id: string }[]>`
        insert into public.contracts (organization_id, store_id, valid_from, template)
        values (${orgId}::uuid, ${s!.id}::uuid, current_date - 30, ${template})
        returning id`;
      await tx`
        insert into public.store_agreements
          (organization_id, store_id, contract_id, valid_from, commission_bp)
        values (${orgId}::uuid, ${s!.id}::uuid, ${c!.id}::uuid, current_date - 30, 2000)`;
      return s!.id;
    };
    readyStore = await store("Klar butik", null);
    unsignedStore = await store("Osignerad butik", "placering-vinstdelning-v1");
    const [machine] = await tx<{ id: string }[]>`
      insert into public.machines (organization_id, code, name, active_from)
      values (${orgId}::uuid, 'BL-001', 'Ny automat', current_date - 1) returning id`;
    machineId = machine!.id;
  });
  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
  errors.length = 0;
});

afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  await browser?.close();
  await sql?.end();
});

describe("Startlista per ny butik (iPhone SE)", () => {
  it("På väg in: bockar och en knapp per butik, synliga utan att fälla ut", async () => {
    const page = await signedIn();
    await page.goto("/butiker");
    const section = page.locator('section[aria-labelledby="pa-vag-in"] >> visible=true');
    await section.waitFor();
    expect(text(await section.innerText())).toContain("1 av 2 butiker är klara för automat.");

    const ready = page.locator(`[data-startlista="${readyStore}"]`);
    const readyText = text(await ready.innerText());
    expect(readyText).toContain("2 av 5 klart");
    for (const label of [
      "Villkor",
      "Kontrakt signerat",
      "Automat placerad",
      "Rapportmottagare",
      "Portal-inbjudan",
    ]) {
      expect(readyText).toContain(label);
    }
    const place = ready.getByRole("link", { name: "Placera automat", exact: true });
    expect(await place.getAttribute("href")).toBe(
      `/automater/bl-001?gor=placera&butik=${readyStore}`,
    );

    const unsigned = page.locator(`[data-startlista="${unsignedStore}"]`);
    expect(text(await unsigned.innerText())).toContain("1 av 5 klart");
    const sign = unsigned.getByRole("link", { name: "Signera", exact: true });
    expect(await sign.getAttribute("href")).toBe(`/avtal#butik-${unsignedStore}`);
    // En knapp per butik: den osignerade har ingen "Placera automat".
    expect(await unsigned.getByRole("link", { name: "Placera automat" }).count()).toBe(0);

    await expectFits(page, 'section[aria-labelledby="pa-vag-in"]');
    await screenshot(page, "startlista-01-pa-vag-in");
  });

  it("Placera automat: butiken är vald, och den osignerade butiken ger varningen", async () => {
    const page = await signedIn();
    await page.goto("/butiker");
    await page
      .locator(`[data-startlista="${readyStore}"]`)
      .getByRole("link", { name: "Placera automat", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname === "/automater/bl-001");

    const dialog = page.getByRole("dialog");
    await dialog.getByText("Placera BL-001.").waitFor();
    const select = dialog.getByLabel("Till butik");
    expect(await select.inputValue()).toBe(readyStore);
    // Klar butik: villkor och signerat kontrakt, ingen varning.
    expect(await dialog.locator("[data-no-contract]").count()).toBe(0);
    expect(await dialog.locator("[data-no-agreement]").count()).toBe(0);

    await select.selectOption(unsignedStore);
    const warning = dialog.locator("[data-no-contract]");
    await warning.waitFor();
    expect(text(await warning.innerText())).toContain(WARNING);
    expect(await warning.getByRole("link", { name: /Signera/ }).getAttribute("href")).toBe(
      `/avtal#butik-${unsignedStore}`,
    );
    // Butiken har villkor från i dag: ingen varning om 0 %.
    expect(await dialog.locator("[data-no-agreement]").count()).toBe(0);
    await screenshot(page, "startlista-02-placera-varning");

    // "… eller placera ändå": varningen stoppar inte.
    await dialog.getByRole("button", { name: "Placera", exact: true }).click();
    await page.getByText("Automaten är placerad").waitFor();
    const placed = await sql<{ store_id: string }[]>`
      select store_id from public.machine_placements where machine_id = ${machineId}::uuid`;
    expect(placed.map((p) => p.store_id)).toEqual([unsignedStore]);
  });

  it("Automater: 'saker kvar' på raden och Startklar överst på automatens sida", async () => {
    const page = await signedIn();
    await page.goto("/automater");
    const left = page.locator("[data-startklar-kvar] >> visible=true").first();
    await left.waitFor();
    expect(text(await left.innerText())).toMatch(/^\d+ sak(er)? kvar$/);

    await page.goto("/automater/bl-001");
    const list = page.locator('[data-startklar="BL-001"] >> visible=true');
    await list.waitFor();
    const listText = text(await list.innerText());
    expect(listText).toMatch(/BL-001: \d av \d klart\./);
    expect(listText).toContain("Nästa:");
    // Automaten står i butiken nu: det steget är avbockat.
    expect(await list.getByText("Klart: ").count()).toBeGreaterThan(0);
    await expectFits(page, '[data-startklar="BL-001"]');
    await screenshot(page, "startlista-03-startklar");
  });
});
