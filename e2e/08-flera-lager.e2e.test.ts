/**
 * Flera lager: ägaren på datorn skapar "Kontoret" i Vårt lager, räknar en titel där och
 * flyttar 5 pack från Hemma (med Ångra). På en iPhone 15 fyller påfyllaren på en automat i
 * /fyll-pa med "Från: Kontoret" och packen dras ur Kontoret, inte Hemma. Databasen
 * kontrolleras direkt efter varje steg.
 *
 * Förberedelse (E2E_DATABASE_URL): ett Kontoret från en tidigare körning töms och tas
 * bort, Hemma räknas till 50 pack av titeln och automaten får en Awish-läsning med plats
 * för 6 pack (som i 07-fyll-pa). Testet går att köra flera gånger.
 */

import postgres from "postgres";
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

let browser: Browser;
let sql: postgres.Sql;

interface Target {
  orgId: string;
  machineId: string;
  machineLocation: string;
  hemma: string;
  titleId: string;
  title: string;
  before: number;
}
let target: Target;
let kontoret = "";

async function level(location: string, titleId: string): Promise<number> {
  const [r] = await sql<{ q: number }[]>`
    select quantity::int as q from public.stock_levels
    where location_id = ${location}::uuid and title_id = ${titleId}::uuid`;
  return r?.q ?? 0;
}

async function ownTotal(): Promise<number> {
  const [r] = await sql<{ q: number }[]>`
    select coalesce(sum(quantity), 0)::int as q from public.warehouse_stock
    where organization_id = ${target.orgId}::uuid and title_id = ${target.titleId}::uuid`;
  return r?.q ?? 0;
}

async function findKontoret(): Promise<string | undefined> {
  const [r] = await sql<{ id: string }[]>`
    select id from public.stock_locations
    where organization_id = ${target.orgId}::uuid and kind = 'warehouse'
      and archived_at is null and name = 'Kontoret'`;
  return r?.id;
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const [row] = await sql<
    {
      org_id: string;
      machine_id: string;
      location_id: string;
      hemma: string;
      title_id: string;
      title: string;
    }[]
  >`
    select m.organization_id as org_id, m.id as machine_id, l.id as location_id,
           c.id as hemma, t.id as title_id, t.name as title
    from public.memberships ms
    join auth.users u on u.id = ms.user_id and u.email = ${e2e().users.refiller}
    join public.machines m on m.organization_id = ms.organization_id and m.archived_at is null
    join public.machine_placements p on p.organization_id = m.organization_id
      and p.machine_id = m.id and p.valid_from <= current_date
      and (p.valid_to is null or p.valid_to >= current_date)
    join public.stock_locations l on l.organization_id = m.organization_id and l.machine_id = m.id
    join public.stock_locations c on c.organization_id = m.organization_id and c.is_central
      and c.archived_at is null
    join public.stock_levels sl on sl.location_id = l.id and sl.quantity between 0 and 50
    join public.titles t on t.organization_id = m.organization_id and t.id = sl.title_id
      and t.archived_at is null and t.merged_into_id is null
    order by m.code, t.name
    limit 1`;
  if (!row) throw new Error("Seeden saknar en automat med placering och saldo.");
  target = {
    orgId: row.org_id,
    machineId: row.machine_id,
    machineLocation: row.location_id,
    hemma: row.hemma,
    titleId: row.title_id,
    title: row.title,
    before: await level(row.location_id, row.title_id),
  };
  // Ett Kontoret från en tidigare körning: töm (räkna till 0) och ta bort.
  const old = await findKontoret();
  if (old) {
    await sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
      select sl.organization_id, sl.location_id, sl.title_id, 'count', 0, 'E2E: töm'
      from public.stock_levels sl where sl.location_id = ${old}::uuid and sl.quantity <> 0`;
    await sql`update public.stock_locations set refill_source_id = null
              where organization_id = ${target.orgId}::uuid and refill_source_id = ${old}::uuid`;
    await sql`update public.stock_locations set archived_at = now() where id = ${old}::uuid`;
  }
  await sql`
    insert into public.stock_events
      (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
    values (${target.orgId}::uuid, ${target.hemma}::uuid, ${target.titleId}::uuid, 'count', 50,
            now(), 'E2E: Flera lager')`;
  await sql`update public.stock_locations set awish_fill = null, awish_synced_at = null
            where organization_id = ${target.orgId}::uuid and machine_id is not null`;
  await sql`
    update public.stock_locations
    set awish_synced_at = now(),
        awish_fill = ${sql.json([
          {
            title_id: target.titleId,
            units: target.before,
            capacity: target.before + 6,
            channels: 2,
            empty: 1,
          },
        ])}
    where id = ${target.machineLocation}::uuid`;
  expect(await level(target.hemma, target.titleId)).toBe(50);
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await sql?.end();
});

describe("Flera lager på datorn (ägaren)", () => {
  let context: BrowserContext;
  let page: Page;
  let errors: Error[];

  beforeAll(async () => {
    ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { viewport: "desktop" }));
    await login(page, e2e().users.owner);
  });
  afterAll(async () => {
    await context?.close();
  });
  afterEach(() => expectNoPageErrors(errors));

  it("+ Nytt lager: Kontoret", async () => {
    await page.goto("/vart-lager");
    await page.getByRole("button", { name: "Nytt lager" }).click();
    await page.getByLabel("Namn").fill("Kontoret");
    await screenshot(page, "08-nytt-lager-desktop");
    await page.getByRole("button", { name: "Skapa lager" }).click();
    await page.getByText("Klart! Kontoret finns nu").first().waitFor();
    kontoret = await until(findKontoret, "Kontoret finns i databasen");
    // Vyn byter till Kontoret: raden "Alla · Hemma · Kontoret" och fältet gäller Kontoret.
    const switcher = page.getByRole("radiogroup", { name: "Visa lager" });
    await switcher.getByRole("radio", { name: /Kontoret/ }).waitFor();
    expect(
      await switcher.getByRole("radio", { name: /Kontoret/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("räkna en titel i Kontoret", async () => {
    const input = page.getByLabel(`Antal i Kontoret, ${target.title}`, { exact: true });
    await input.fill("10");
    await input.press("Enter");
    await until(async () => (await level(kontoret, target.titleId)) === 10, "Kontoret har 10");
    expect(await level(target.hemma, target.titleId)).toBe(50);
    await screenshot(page, "08-kontoret-raknat-desktop");
  });

  it("Alla: summan, Vilket lager? och Flytta 5 pack med Ångra", async () => {
    const switcher = page.getByRole("radiogroup", { name: "Visa lager" });
    await switcher.getByRole("radio", { name: "Alla" }).click();
    const row = page.locator(`li[data-title="${target.title}"]`);
    const total = row.getByRole("button", { name: `Ändra antal, ${target.title}` });
    await until(async () => (await total.innerText()).trim() === "60", "summan 60 visas");
    // Ett klick på summan frågar vilket lager.
    await total.click();
    await page.getByRole("dialog", { name: "Vilket lager?" }).waitFor();
    await screenshot(page, "08-vilket-lager-desktop");
    await page.getByRole("dialog").getByRole("button", { name: "Stäng" }).click();

    await row.getByRole("button", { name: `Flytta, ${target.title}` }).click();
    const dialog = page.getByRole("dialog", { name: `Flytta ${target.title}` });
    await dialog.waitFor();
    await dialog
      .getByRole("radiogroup", { name: "Från" })
      .getByRole("radio", { name: /Hemma/ })
      .click();
    await dialog
      .getByRole("radiogroup", { name: "Till" })
      .getByRole("radio", { name: /Kontoret/ })
      .click();
    await dialog.getByLabel("Antal pack").fill("5");
    await screenshot(page, "08-flytta-desktop");
    await dialog.getByRole("button", { name: "Flytta 5 pack till Kontoret" }).click();
    await page.getByText("Klart! 5 pack till Kontoret").first().waitFor();
    await until(async () => (await level(kontoret, target.titleId)) === 15, "Kontoret har 15");
    expect(await level(target.hemma, target.titleId)).toBe(45);
    expect(await ownTotal()).toBe(60);
    await screenshot(page, "08-flyttat-desktop");

    // Ångra i toasten: tillbaka, summan oförändrad. Sedan flytta igen.
    await page.getByRole("button", { name: "Ångra" }).first().click();
    await until(async () => (await level(kontoret, target.titleId)) === 10, "Ångrat");
    expect(await level(target.hemma, target.titleId)).toBe(50);
    expect(await ownTotal()).toBe(60);
    await row.getByRole("button", { name: `Flytta, ${target.title}` }).click();
    await dialog.waitFor();
    await dialog
      .getByRole("radiogroup", { name: "Från" })
      .getByRole("radio", { name: /Hemma/ })
      .click();
    await dialog.getByLabel("Antal pack").fill("5");
    await dialog.getByRole("button", { name: "Flytta 5 pack till Kontoret" }).click();
    await until(async () => (await level(kontoret, target.titleId)) === 15, "Kontoret har 15 igen");
    expect(await ownTotal()).toBe(60);
  });

  it("automatens sida visar Fylls på från", async () => {
    const [m] = await sql<{ code: string }[]>`
      select code from public.machines where id = ${target.machineId}::uuid`;
    await page.goto(`/automater/${m!.code.toLowerCase()}?vy=lager`);
    const picker = page.getByRole("radiogroup", { name: "Fylls på från" });
    await picker.waitFor();
    await picker.scrollIntoViewIfNeeded();
    await screenshot(page, "08-fylls-pa-fran-desktop");
  });
});

describe("Fyll på från Kontoret på iPhone 15", () => {
  let context: BrowserContext;
  let page: Page;
  let errors: Error[];

  beforeAll(async () => {
    ({ page, context, errors } = await openPage(browser, e2e().baseUrl, {
      device: "iPhone 15",
      theme: "dark",
    }));
    await login(page, e2e().users.refiller);
  });
  afterAll(async () => {
    await context?.close();
  });
  afterEach(() => expectNoPageErrors(errors));

  it("Från: Hemma ▾ → Kontoret, Klar: packen dras ur Kontoret", async () => {
    await page.goto(`/fyll-pa`);
    await page
      .getByText(/pack i lager/)
      .first()
      .waitFor();
    await screenshot(page, "08-fyll-pa-lista-iphone15");
    await page.goto(`/fyll-pa/${target.machineId}`);
    const chip = page.getByRole("button", { name: /^Från Hemma/ });
    await chip.waitFor();
    await chip.click();
    await page
      .getByRole("radiogroup", { name: "Ta pack från" })
      .getByRole("radio", { name: /Kontoret/ })
      .click();
    await page.getByRole("button", { name: /^Från Kontoret/ }).waitFor();
    const input = page.getByLabel(target.title, { exact: true });
    // Förslaget: plats för 6, Kontoret har 15.
    expect(await input.inputValue()).toBe("6");
    // Vänta ut inglidningen (raderna tonas in) innan skärmbilden.
    await new Promise((r) => setTimeout(r, 1_200));
    await screenshot(page, "08-fyll-pa-kontoret-iphone15");
    await page.getByRole("button", { name: /^Klar/ }).click();
    await page.getByText("Sparat – 6 pack påfyllda, 9 kvar i Kontoret").first().waitFor();
    await until(async () => (await level(kontoret, target.titleId)) === 9, "Kontoret har 9");
    expect(await level(target.hemma, target.titleId)).toBe(45);
    expect(await level(target.machineLocation, target.titleId)).toBe(target.before + 6);
    const [sub] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.field_submissions
      where machine_id = ${target.machineId}::uuid and from_location_id = ${kontoret}::uuid
        and quantity = 6 and occurred_at > now() - interval '5 minutes'`;
    expect(sub?.n).toBe(1);
    await screenshot(page, "08-fyll-pa-klar-iphone15");
  });

  it("Vårt lager på iPhone: Alla · Hemma · Kontoret", async () => {
    // Påfyllaren ser inte Vårt lager; ägaren på telefonen.
    const owner = await openPage(browser, e2e().baseUrl, { device: "iPhone 15", theme: "dark" });
    try {
      await login(owner.page, e2e().users.owner);
      await owner.page.goto("/vart-lager");
      const switcher = owner.page.getByRole("radiogroup", { name: "Visa lager" });
      await switcher.waitFor();
      await switcher.scrollIntoViewIfNeeded();
      await new Promise((r) => setTimeout(r, 800));
      await screenshot(owner.page, "08-vart-lager-iphone15");
      expectNoPageErrors(owner.errors);
    } finally {
      await owner.context.close();
    }
  });
});
