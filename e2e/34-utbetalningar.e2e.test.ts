/**
 * Utbetalningar från Nayax på telefon (390 × 844) och dator (1 440 × 900): ägaren lägger in
 * en utbetalning från en CSV med okända kolumner, väljer kolumnerna, sparar, ser "Betala så
 * här" där summan är beloppet, markerar butiken, partnern och momsen som betalda och kommer
 * till "Allt betalt". Butiken ser sin betalning i portalen och inget om fördelningen.
 *
 * Egen organisation med påhittade namn: Butik A (50 % av vinsten) och Butik B (20 % av
 * försäljningen), en automat i var och en med två köp à 79 kr per dag de senaste 20
 * dagarna, inköpspris 45 kr och Partner X (inköpet tillbaka + 50 % av vinsten).
 *
 * Skärmbilderna hamnar i E2E_SCREENSHOT_DIR.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@/server/auth/password";

import {
  expectNoPageErrors,
  launchBrowser,
  screenshot,
  until,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

let browser: Browser;
let sql: postgres.Sql;
let owner = "";
let orgId = "";
let storeA = "";
const contexts: BrowserContext[] = [];
const errors: Error[] = [];

const text = (s: string) => s.replace(/[  ⁠]/g, " ");

async function open(viewport: { width: number; height: number }, mobile: boolean): Promise<Page> {
  const context = await browser.newContext({
    baseURL: e2e().baseUrl,
    viewport,
    colorScheme: "light",
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addCookies([{ name: "binderlab-theme", value: "light", url: e2e().baseUrl }]);
  await context.addInitScript(
    `try { localStorage.setItem("binderlab-theme", "light"); } catch {}
     window.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "nextjs-portal{display:none!important}"; document.head.appendChild(s); });`,
  );
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 60_000));
  page.on("pageerror", (e) => errors.push(e));
  await login(page, owner);
  return page;
}

/** Skärmbild när sidbytet och arken har tonat in klart. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
  );
  await new Promise((r) => setTimeout(r, 400));
  await screenshot(page, name);
}

async function noSideScroll(page: Page): Promise<void> {
  const wide = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth
      ? document.documentElement.scrollWidth
      : 0,
  );
  expect(wide, `sidan är ${wide} px bred`).toBe(0);
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const id = e2e().runId.toLowerCase();
  owner = `utbetalning-${id}@binderlab.local`;
  const hash = await hashPassword(e2e().password);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${owner}, ${hash}, ${sql.json({ full_name: "E2E Utbetalning" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: user!.id,
      email: owner,
      role: "authenticated",
    })}, true), set_config('role', 'authenticated', true)`;
    const [org] = await tx<{ id: string }[]>`
      select public.create_organization(${`E2E Utbetalning ${id}`}, ${`e2e-utb-${id}`}) as id`;
    orgId = org!.id;
    const [title] = await tx<{ id: string }[]>`
      insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Pack') returning id`;
    await tx`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
      values (${orgId}::uuid, ${title!.id}::uuid, 4500, current_date - 200)`;
    const [source] = await tx<{ id: string }[]>`
      insert into public.data_sources (organization_id, provider, name)
      values (${orgId}::uuid, 'awish_csv', 'E2E Utbetalning') returning id`;
    await tx`insert into public.partner_agreements (organization_id, partner_name, valid_from)
      values (${orgId}::uuid, 'Partner X', current_date - 200)`;
    await tx`update public.organization_settings set vat_reserve_mode = 'vmb'
      where organization_id = ${orgId}::uuid`;
    const specs: Array<[string, string, string, number | null]> = [
      ["Butik A", "BL-001", "profit_after_costs", 5000],
      ["Butik B", "BL-002", "net_excl_vat", 2000],
    ];
    for (const [name, code, base, bp] of specs) {
      const [store] = await tx<{ id: string }[]>`
        insert into public.stores (organization_id, name) values (${orgId}::uuid, ${name}) returning id`;
      if (name === "Butik A") storeA = store!.id;
      await tx`insert into public.store_agreements (organization_id, store_id, valid_from, commission_base, commission_bp)
        values (${orgId}::uuid, ${store!.id}::uuid, current_date - 200, ${base}, ${bp})`;
      const [machine] = await tx<{ id: string }[]>`
        insert into public.machines (organization_id, code, name, active_from)
        values (${orgId}::uuid, ${code}, ${name}, current_date - 60) returning id`;
      await tx`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
        values (${orgId}::uuid, ${machine!.id}::uuid, ${store!.id}::uuid, current_date - 60)`;
      await tx`
        insert into public.orders (organization_id, data_source_id, machine_id, payment_method,
                                   external_id, raw_title, title_id, ordered_at, amount_ore, source_hash)
        select ${orgId}::uuid, ${source!.id}::uuid, ${machine!.id}::uuid, 'card',
               ${code} || '-' || ago || '-' || k, 'Pack', ${title!.id}::uuid,
               ((current_date - ago) + time '10:00' + k * interval '20 minutes') at time zone 'Europe/Stockholm',
               7900, md5(${id} || ${code} || ago || '-' || k)
        from generate_series(1, 20) as ago, generate_series(1, 2) as k`;
    }
  });
  browser = await launchBrowser();
});

afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  await browser?.close();
  await sql?.end();
});

describe("Utbetalningar (telefon)", () => {
  it("CSV med okända kolumner → kolumnsteget → Betala så här → Allt betalt", async () => {
    const page = await open({ width: 390, height: 844 }, true);
    await page.goto("/pengar/utbetalningar");
    await page.locator('[data-testid="all-paid"]').waitFor();
    await shot(page, "utbetalningar-tom-390");

    // En rapport med en layout appen inte känner igen.
    const dir = mkdtempSync(path.join(tmpdir(), "utb-"));
    const file = path.join(dir, "nayax-rapport.csv");
    const [day] = await sql<{ paid: string }[]>`select (current_date - 1)::text as paid`;
    const paid = day!.paid;
    // 40 köp à 79 kr de senaste 10 dagarna ≈ 3 160 kr; Nayax tar en avgift.
    writeFileSync(file, `Kolumn 1;Kolumn 2\n${paid};3 050,00\n${paid};0\n`);

    await page.getByRole("button", { name: "Lägg in utbetalning från Nayax", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await sheet.locator('[data-testid="payout-file"]').setInputFiles(file);
    await sheet.locator('[data-testid="map-amount"]').waitFor();
    await shot(page, "utbetalningar-kolumnsteg-390");
    await sheet
      .locator('[data-testid="map-amount"]')
      .selectOption({ label: "Kolumn 2 (t.ex. 3 050,00)" });
    await sheet.locator('[data-testid="map-paid_on"]').selectOption({ value: "Kolumn 1" });
    await sheet.locator('[data-testid="mapping-next"]').click();
    await sheet.locator('[data-testid="payout-amount"]').waitFor();
    expect(await sheet.locator('[data-testid="payout-amount"]').inputValue()).toBe("3050");
    await shot(page, "utbetalningar-utkast-390");
    await sheet.locator('[data-testid="payout-save"]').click();
    await page.waitForURL(/\/pengar\/utbetalningar\/[0-9a-f-]{36}$/);

    // Betala så här: summan är beloppet.
    const sum = page.locator('[data-testid="payout-sum"]');
    await sum.waitFor();
    expect(text(await sum.innerText())).toBe("3 050 kr ✓");
    await page.locator('[data-line="Butik A"]').waitFor();
    await shot(page, "utbetalning-betala-sa-har-390");
    await noSideScroll(page);

    // Markera butiken, partnern och momsen som betalda från Att betala just nu.
    await page.goto("/pengar/utbetalningar");
    await shot(page, "utbetalningar-att-betala-390");
    for (const kind of ["store", "store", "partner", "vat_reserve"] as const) {
      const button = page.locator(`[data-testid="pay-${kind}"]`).first();
      await button.waitFor();
      await button.click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('[data-testid="pay-confirm"]').click();
      await dialog.waitFor({ state: "detached" });
      await page.getByText("är markerat som").first().waitFor();
    }
    await until(
      async () => (await page.locator('[data-testid="pay-store"]').count()) === 0,
      "betalt",
    );
    await page.reload();
    await page.locator('[data-testid="all-paid"]').waitFor();
    await shot(page, "utbetalningar-allt-betalt-390");

    // Butikens betalning är en vanlig butiksbetalning kopplad till raden.
    const pays = await sql<{ n: number }[]>`
      select count(*)::int as n from public.store_payments
      where organization_id = ${orgId}::uuid and payout_allocation_line_id is not null`;
    expect(pays[0]!.n).toBeGreaterThanOrEqual(2);
    expectNoPageErrors(errors);
  });

  it("Skriv in själv: perioden räknas ut", async () => {
    const page = await open({ width: 390, height: 844 }, true);
    await page.goto("/pengar/utbetalningar");
    await page.getByRole("button", { name: "Lägg in utbetalning från Nayax", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Skriv in själv", exact: true }).click();
    await sheet.locator('[data-testid="payout-amount"]').fill("100");
    await shot(page, "utbetalningar-skriv-in-390");
    await sheet.getByRole("button", { name: "Avbryt", exact: true }).click();
    expectNoPageErrors(errors);
  });
});

describe("Utbetalningar (dator) och portalen", () => {
  it("1 440 × 900: sidan och en utbetalning", async () => {
    const page = await open({ width: 1440, height: 900 }, false);
    await page.goto("/pengar/utbetalningar");
    await page.locator('[data-testid="to-pay"]').waitFor();
    await shot(page, "utbetalningar-1440");
    await page.locator("[data-payout]").first().click();
    await page.locator('[data-testid="payout-sum"]').waitFor();
    await page.locator('[data-line="Partner X"] summary').click();
    await shot(page, "utbetalning-betala-sa-har-1440");
    // Kolumnsteget och "Skriv in själv" på dator.
    await page.goto("/pengar/utbetalningar");
    await page.getByRole("button", { name: "Lägg in utbetalning från Nayax", exact: true }).click();
    let sheet = page.getByRole("dialog");
    const dir = mkdtempSync(path.join(tmpdir(), "utb-"));
    const file = path.join(dir, "annan-rapport.csv");
    writeFileSync(
      file,
      "Datum X;Summa Y;Avg Z\n2026-11-20;1 000,00;20,00\n2026-11-21;500,00;10,00\n",
    );
    await sheet.locator('[data-testid="payout-file"]').setInputFiles(file);
    await sheet.locator('[data-testid="map-amount"]').waitFor();
    await shot(page, "utbetalningar-kolumnsteg-1440");
    await sheet.getByRole("button", { name: "Avbryt", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Lägg in utbetalning från Nayax", exact: true }).click();
    sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Skriv in själv", exact: true }).click();
    await sheet.locator('[data-testid="payout-amount"]').fill("1 250");
    await shot(page, "utbetalningar-skriv-in-1440");
    await sheet.locator('[data-testid="payout-save"]').click();
    await page.waitForURL(/\/pengar\/utbetalningar\/[0-9a-f-]{36}$/);
    expect(text(await page.locator('[data-testid="payout-sum"]').innerText())).toBe("1 250 kr ✓");
    // En sammanställning med två utbetalningar: en i taget, "1 av 2 – Stämmer, nästa".
    await page.goto("/pengar/utbetalningar");
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const two = path.join(dir, "sammanstallning.csv");
    writeFileSync(
      two,
      `Settlement Date;Net Amount;Total Fees\n${iso(yesterday)};300,00;5,00\n${iso(today)};320,00;5,00\nTotalt;620,00;10,00\n`,
    );
    await page.getByRole("button", { name: "Lägg in utbetalning från Nayax", exact: true }).click();
    sheet = page.getByRole("dialog");
    await sheet.locator('[data-testid="payout-file"]').setInputFiles(two);
    await sheet.locator('[data-testid="payout-step"]').waitFor();
    expect(text(await sheet.locator('[data-testid="payout-step"]').innerText())).toContain(
      "1 av 2",
    );
    expect(await sheet.locator('[data-testid="payout-amount"]').inputValue()).toBe("300");
    await sheet.getByRole("button", { name: "Stämmer, nästa", exact: true }).click();
    await sheet.getByText("2 av 2").waitFor();
    expect(await sheet.locator('[data-testid="payout-amount"]').inputValue()).toBe("320");
    await sheet.getByRole("button", { name: "Stämmer, spara", exact: true }).click();
    await page.waitForURL(/\/pengar\/utbetalningar\/[0-9a-f-]{36}$/);
    expect(text(await page.locator('[data-testid="payout-sum"]').innerText())).toBe("320 kr ✓");
    await page.goto("/pengar/utbetalningar");
    await page.locator('[data-testid="pay-partner"]').waitFor();
    await shot(page, "utbetalningar-att-betala-1440");
    expectNoPageErrors(errors);
  });

  it("butiken ser sin betalning i portalen men inget om fördelningen", async () => {
    const rows = await sql.begin(async (tx) => {
      const [u] = await tx<{ id: string }[]>`select id from auth.users where email = ${owner}`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: u!.id, role: "authenticated" })}, true)`;
      const [inv] = await tx<{ token: string }[]>`
        select public.create_store_invitation(${orgId}::uuid, ${storeA}::uuid, ${`butik-${e2e().runId.toLowerCase()}@binderlab.local`}) as token`;
      const [store] = await tx<{ id: string }[]>`
        insert into auth.users (email) values (${`butik-${e2e().runId.toLowerCase()}@binderlab.local`}) returning id`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: store!.id, email: `butik-${e2e().runId.toLowerCase()}@binderlab.local`, role: "authenticated" })}, true), set_config('role', 'authenticated', true)`;
      await tx`select public.accept_invitation(${inv!.token})`;
      const payments = await tx`select * from public.portal_store_payments(${storeA}::uuid)`;
      const hidden = await tx<{ n: number }[]>`
        select (select count(*) from public.payout_allocation_lines)
             + (select count(*) from public.partner_agreements)
             + (select count(*) from public.recipient_payments)
             + (select count(*) from public.purchase_prices) as n`;
      return { payments: payments.length, hidden: Number(hidden[0]!.n) };
    });
    expect(rows.payments).toBeGreaterThan(0);
    expect(rows.hidden).toBe(0);
  });
});
