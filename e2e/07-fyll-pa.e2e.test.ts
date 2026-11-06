/**
 * Fyll på på en iPhone 15 (Playwrights devices["iPhone 15"], mörkt tema): påfyllaren öppnar
 * /fyll-pa, väljer automaten med tomma fack (den står först), minskar förslaget med −,
 * trycker Klar och ser "Klart! 5 pack påfyllda" (med Ångra). Vårt lager har då 5 pack
 * färre och automaten 5 fler (databasen kontrolleras direkt).
 *
 * Förberedelse i databasen (E2E_DATABASE_URL): automaten får en Awish-läsning
 * (stock_locations.awish_fill, som synken skriver) med plats för 6 pack och ett tomt fack,
 * och vårt lager räknas till 50 pack av titeln. Andra automater får ingen Awish-läsning,
 * så att den här står först. Testet går att köra flera gånger.
 *
 * Uppdatera: en ny Awish-läsning i databasen (fler fack) syns efter ett tryck på Uppdatera,
 * utan att sidan laddas om (i e2e finns ingen Awish API-källa, så knappen hämtar bara om
 * datan; läsningen i Awish testas i test/db/fyll-pa-uppdatera.test.ts).
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
let context: BrowserContext;
let page: Page;
let errors: Error[];
let sql: postgres.Sql;

interface Target {
  orgId: string;
  machineId: string;
  machineLocation: string;
  central: string;
  titleId: string;
  title: string;
  place: string;
  before: number;
}
let target: Target;

async function level(location: string, titleId: string): Promise<number> {
  const [r] = await sql<{ q: number }[]>`
    select quantity::int as q from public.stock_levels
    where location_id = ${location}::uuid and title_id = ${titleId}::uuid`;
  return r?.q ?? 0;
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const [row] = await sql<
    {
      org_id: string;
      machine_id: string;
      location_id: string;
      central: string;
      title_id: string;
      title: string;
      place: string;
    }[]
  >`
    select m.organization_id as org_id, m.id as machine_id, l.id as location_id,
           c.id as central, t.id as title_id, t.name as title, st.name as place
    from public.memberships ms
    join auth.users u on u.id = ms.user_id and u.email = ${e2e().users.refiller}
    join public.machines m on m.organization_id = ms.organization_id and m.archived_at is null
    join public.machine_placements p on p.organization_id = m.organization_id
      and p.machine_id = m.id and p.valid_from <= current_date
      and (p.valid_to is null or p.valid_to >= current_date)
    join public.stores st on st.organization_id = p.organization_id and st.id = p.store_id
    join public.stock_locations l on l.organization_id = m.organization_id and l.machine_id = m.id
    join public.stock_locations c on c.organization_id = m.organization_id and c.is_central
      and c.archived_at is null
    join public.stock_levels sl on sl.location_id = l.id and sl.quantity between 0 and 50
    join public.titles t on t.organization_id = m.organization_id and t.id = sl.title_id
      and t.archived_at is null and t.merged_into_id is null
    order by m.code, t.name
    limit 1`;
  if (!row) throw new Error("Seeden saknar en automat med placering och saldo.");
  const before = await level(row.location_id, row.title_id);
  target = {
    orgId: row.org_id,
    machineId: row.machine_id,
    machineLocation: row.location_id,
    central: row.central,
    titleId: row.title_id,
    title: row.title,
    place: row.place,
    before,
  };
  await sql`update public.stock_locations set awish_fill = null, awish_synced_at = null
            where organization_id = ${row.org_id}::uuid and machine_id is not null`;
  await sql`
    update public.stock_locations
    set awish_synced_at = now(),
        awish_fill = ${sql.json([
          { title_id: row.title_id, units: before, capacity: before + 6, channels: 2, empty: 1 },
        ])}
    where id = ${row.location_id}::uuid`;
  await sql`
    insert into public.stock_events
      (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
    values (${row.org_id}::uuid, ${row.central}::uuid, ${row.title_id}::uuid, 'count', 50, now(),
            'E2E: Fyll på')`;
  expect(await level(row.central, row.title_id)).toBe(50);

  browser = await launchBrowser();
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl, {
    device: "iPhone 15",
    theme: "dark",
  }));
  await login(page, e2e().users.refiller);
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await sql?.end();
});

describe("Fyll på på iPhone 15", () => {
  it("välj automat, −, Klar: vårt lager och automaten ändras", async () => {
    await page.goto("/fyll-pa");
    const cards = page.getByRole("list", { name: "Automater" }).getByRole("link");
    await cards.first().waitFor();
    // Automaten med tomma fack står först.
    expect(await cards.first().getAttribute("aria-label")).toContain(target.place);
    await screenshot(page, "07-fyll-pa-automater-iphone15");

    await cards.first().click();
    await page.waitForURL((url) => url.pathname === `/fyll-pa/${target.machineId}`);
    const input = page.getByLabel(target.title, { exact: true });
    await input.waitFor();
    // Förslaget: kapacitet − nu = 6 (50 hemma räcker).
    expect(await input.inputValue()).toBe("6");
    expect(await page.locator("main, body").first().innerText()).toContain(
      `${target.before}/${target.before + 6}`,
    );
    await page.getByRole("button", { name: `En mindre ${target.title}` }).click();
    expect(await input.inputValue()).toBe("5");
    await screenshot(page, "07-fyll-pa-automat-iphone15");

    // Klar frågar först (skydd mot tryck av misstag när man packar): Nej sparar ingenting.
    await page.getByRole("button", { name: /^Klar/ }).click();
    await page.getByRole("button", { name: "Nej, jag packar bara" }).click();
    await page.getByRole("button", { name: /^Klar/ }).waitFor();
    expect(await level(target.central, target.titleId)).toBe(50);
    expect(await level(target.machineLocation, target.titleId)).toBe(target.before);
    expect(new URL(page.url()).pathname).toBe(`/fyll-pa/${target.machineId}`);
    // Seeden kan ge andra titlar i automaten ett förslag också: bekräftelsen visar summan.
    const total = Number(
      (await page.getByRole("button", { name: /^Klar/ }).innerText()).replace(/\D/g, ""),
    );
    expect(total).toBeGreaterThanOrEqual(5);
    await page.getByRole("button", { name: /^Klar/ }).click();
    await page.getByRole("button", { name: "Ja, jag har fyllt på" }).click();
    await page
      .getByText(new RegExp(`${total}\\s?pack påfyllda`))
      .first()
      .waitFor();
    await page.waitForURL((url) => url.pathname === "/fyll-pa");

    await until(
      async () => (await level(target.central, target.titleId)) === 45,
      "vårt lager har 45 pack kvar",
    );
    expect(await level(target.machineLocation, target.titleId)).toBe(target.before + 5);
    const [ev] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.field_submissions
      where machine_id = ${target.machineId}::uuid and title_id = ${target.titleId}::uuid
        and quantity = 5 and from_warehouse and occurred_at > now() - interval '5 minutes'`;
    expect(ev?.n).toBe(1);
    await screenshot(page, "07-fyll-pa-klar-iphone15");
  });
  it("Uppdatera visar en ny Awish-läsning utan att sidan laddas om", async () => {
    await page.goto(`/fyll-pa/${target.machineId}`);
    await page.getByLabel(target.title, { exact: true }).waitFor();
    const now = await level(target.machineLocation, target.titleId);
    const text = () => page.locator("body").innerText();
    expect(await text()).toContain(`${now}/${target.before + 6}`);
    // Laddas sidan om försvinner markören.
    await page.evaluate(() => {
      (window as unknown as { __kvar?: boolean }).__kvar = true;
    });
    await sql`
      update public.stock_locations
      set awish_synced_at = now(),
          awish_fill = ${sql.json([
            { title_id: target.titleId, units: now, capacity: now + 17, channels: 3, empty: 0 },
          ])}
      where id = ${target.machineLocation}::uuid`;
    const button = page.getByRole("button", { name: "Uppdatera", exact: true });
    // Stor nog för en tumme (minst 44 px hög).
    const height = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll("button")]
          .filter((b) => b.textContent?.trim() === "Uppdatera")
          .map((b) => b.getBoundingClientRect().height),
      ),
    );
    expect(height).toBeGreaterThanOrEqual(44);
    await button.click();
    await until(async () => (await text()).includes(`${now}/${now + 17}`), "nya kapaciteten syns");
    await page.getByText(/^Uppdaterat \d\d:\d\d$/).waitFor();
    expect(await text()).toMatch(/Awish läst \d\d:\d\d/);
    expect(
      await page.evaluate(() => (window as unknown as { __kvar?: boolean }).__kvar === true),
    ).toBe(true);
    await screenshot(page, "07-fyll-pa-uppdatera-iphone15");

    // Listan: knappen finns där också och visar senaste läsningen.
    await page.getByRole("button", { name: "Automater" }).click();
    await page.waitForURL((url) => url.pathname === "/fyll-pa");
    await page.getByText(/^Awish läst \d\d:\d\d$/).waitFor();
    await page.getByRole("button", { name: "Uppdatera", exact: true }).waitFor();
    await screenshot(page, "07-fyll-pa-lista-uppdatera-iphone15");
  });
});
