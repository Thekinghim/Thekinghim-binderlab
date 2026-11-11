/**
 * Veckosammanfattning, Fyll på (bekräftelsen efter Klar och Ta med-listan) och antal sålda i
 * Lönsamhet, på iPhone SE (3:e generationen, 375 px). Svenska för påfyllaren och ägaren,
 * engelska för delägaren i den enkla vyn.
 *
 * 1. Fyll på, bekräftelsen: efter "Ja, jag har fyllt på" visas "Klart! N pack påfyllda" med
 *    Ångra, och den finns kvar när sidan laddas om och när datan hämtas om (Uppdatera).
 *    Felet som rättades: sparandet räknar om sidan på servern, och med automaten vald i
 *    listan (adressen är automatens, sidan är listans) var adressen och sidan två olika
 *    rutter: Next bytte rutt, monterade om Fyll på och laddade ibland om hela sidan.
 *    Bekräftelsen låg i komponentens minne och syntes då aldrig. Nu är det en rutt
 *    (src/lib/rewrites.ts) och bekräftelsen ligger utanför komponenten. Testet kräver att
 *    sidan inte laddas om av sig själv efter Klar, och att bekräftelsen finns kvar efter en
 *    omladdning. Båda vägarna in provas: automaten vald i listan och öppnad direkt
 *    (/fyll-pa/<id>).
 * 2. Ta med-listan: hur många pack av varje produkt som ska med, per automat och totalt,
 *    mot saldot hemma; varnar när lagret inte räcker; räknas i telefonen, också när nätet
 *    försvinner.
 * 3. Delägaren (enkel vy, engelska): samma bekräftelse ("Done! N packs refilled"), Bring
 *    list, veckosammanfattningen på Sales (/?vecka=…, dit måndagens notis leder) och knappen
 *    Weekly summary i menyn.
 * 4. Ägaren: sidan Veckan (förra veckan mot veckan innan, bästa produkten, Att göra), knappen
 *    under Notiser, cron-routen kräver hemligheten, och Lönsamhet visar antal sålda under
 *    namnet på telefonen.
 *
 * Förberedelse i databasen (E2E_DATABASE_URL): en automat med en Awish-läsning (som e2e/07),
 * 50 pack hemma, order i förra veckan och veckan innan (kopior av seedens order med nya
 * tider), och delägaren med Enkel vy och engelska. Testet går att köra flera gånger: det
 * som fylls på ångras, och veckornas order läggs bara in en gång per vecka.
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@/server/auth/password";

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

/** iPhone SE (3:e generationen): 375 × 667, 2× pixeltäthet. */
const DEVICE = "iPhone SE (3rd gen)";
const PARTNER = "delagare-vecka@binderlab.local";
const PARTNER_PASSWORD = "vecka-e2e-losenord";
const SEED_PERIOD = "from=2026-10-13&to=2026-11-01";

/** Utan nät misslyckas det som går till nätet (versionen, dev-serverns filer och HMR). */
const OFFLINE_ERRORS =
  /Failed to load resource: net::ERR_(FAILED|INTERNET_DISCONNECTED)|WebSocket connection to '[^']*\/_next\/(webpack-)?hmr[^']*' failed: .*net::ERR_INTERNET_DISCONNECTED/;

let browser: Browser;
let sql: postgres.Sql;
/** Testet som pågår har kopplat ner nätet: fel från anrop som går till nätet är väntade. */
let offlineTest = false;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];

interface Target {
  orgId: string;
  machineId: string;
  machineLocation: string;
  central: string;
  titleId: string;
  title: string;
  place: string;
  before: number;
  /** Måndagen i förra veckan (svensk tid). */
  week: string;
  lastPacks: number;
  previousPacks: number;
}
let target: Target;

async function level(location: string, titleId: string): Promise<number> {
  const [r] = await sql<{ q: number }[]>`
    select quantity::int as q from public.stock_levels
    where location_id = ${location}::uuid and title_id = ${titleId}::uuid`;
  return r?.q ?? 0;
}

async function setHome(quantity: number): Promise<void> {
  await sql`
    insert into public.stock_events
      (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
    values (${target.orgId}::uuid, ${target.central}::uuid, ${target.titleId}::uuid, 'count',
            ${quantity}, now(), 'E2E: Vecka')`;
}

/**
 * Utgångsläget för Fyll på: automaten har plats för 6 pack till av titeln (ett tomt fack)
 * och hemma finns 50. Görs om före varje test, så att ett tidigare test inte påverkar.
 */
async function prepareFill(): Promise<{ home: number; machine: number }> {
  const machine = await level(target.machineLocation, target.titleId);
  await sql`
    update public.stock_locations
    set awish_synced_at = now(),
        awish_fill = ${sql.json([
          {
            title_id: target.titleId,
            units: machine,
            capacity: machine + 6,
            channels: 2,
            empty: 1,
          },
        ])}
    where id = ${target.machineLocation}::uuid`;
  await setHome(50);
  return { home: 50, machine };
}

async function newPage(locale: string): Promise<{ page: Page; context: BrowserContext }> {
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark", locale });
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened;
}

async function partnerPage(): Promise<{ page: Page; context: BrowserContext }> {
  const opened = await newPage("en-GB");
  const { page } = opened;
  await page.goto("/logga-in");
  await page.getByLabel("Email").fill(PARTNER);
  await page.getByLabel("Password").fill(PARTNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  return opened;
}

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Tryckytor under 44 × 44 px inom `scope` (knappar, länkar och fält som syns). */
async function smallTargets(page: Page, scope: string) {
  return page.evaluate(
    (sel: string) =>
      Array.from(document.querySelectorAll(sel)).flatMap((root) =>
        Array.from(root.querySelectorAll("a, button, input, select, [role=radio], [role=switch]"))
          .map((el) => {
            const r = el.getBoundingClientRect();
            const label = (el.getAttribute("aria-label") ?? el.textContent ?? "")
              .trim()
              .slice(0, 40);
            return { label, w: Math.round(r.width), h: Math.round(r.height) };
          })
          .filter((x) => x.w > 0 && x.h > 0 && (x.h < 44 || x.w < 44)),
      ),
    scope,
  );
}

/**
 * Väntar tills blocken har glidit upp (ändliga animationer), före en skärmbild. Prickar som
 * pulserar för alltid räknas inte, och väntan är högst några sekunder.
 */
async function settled(page: Page): Promise<void> {
  const started = Date.now();
  for (;;) {
    const moving = await page
      .evaluate(() =>
        document.getAnimations().some((a) => {
          const timing = a.effect?.getComputedTiming();
          return (
            a.playState === "running" && timing !== undefined && timing.iterations !== Infinity
          );
        }),
      )
      .catch(() => false);
    if (!moving || Date.now() - started > 5_000) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Ta med-listan: avmarkerar alla automater utom vår. */
async function onlyTargetMachine(page: Page): Promise<void> {
  await page.evaluate((place: string) => {
    for (const b of Array.from(
      document.querySelectorAll<HTMLElement>('button[role="checkbox"][aria-checked="true"]'),
    )) {
      if (!(b.textContent ?? "").includes(place)) b.click();
    }
  }, target.place);
  await until(
    async () => (await page.getByRole("checkbox", { checked: true }).count()) === 1,
    "bara vår automat är vald",
  );
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const orgId = e2e().organizationId;

  // Delägaren: ägarroll, Enkel vy och engelska.
  const hash = await hashPassword(PARTNER_PASSWORD);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${PARTNER}, ${hash}, ${sql.json({ full_name: "Partner Week" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql`
    insert into public.memberships (organization_id, user_id, role, view_mode)
    values (${orgId}::uuid, ${user!.id}::uuid, 'owner', 'simple')
    on conflict (organization_id, user_id) do update set view_mode = 'simple'`;
  await sql`
    insert into public.profiles (organization_id, user_id, display_name, locale)
    values (${orgId}::uuid, ${user!.id}::uuid, 'Partner Week', 'en')
    on conflict (organization_id, user_id) do update set locale = 'en', weekly_summary = null`;

  // Fyll på: samma förberedelse som e2e/07 (en automat med en Awish-läsning och 50 hemma).
  const [row] = await sql<
    {
      machine_id: string;
      location_id: string;
      central: string;
      title_id: string;
      title: string;
      place: string;
    }[]
  >`
    select m.id as machine_id, l.id as location_id, c.id as central, t.id as title_id,
           t.name as title, st.name as place
    from public.machines m
    join public.machine_placements p on p.organization_id = m.organization_id
      and p.machine_id = m.id and p.valid_from <= current_date
      and (p.valid_to is null or p.valid_to >= current_date)
    join public.stores st on st.organization_id = p.organization_id and st.id = p.store_id
    join public.stock_locations l on l.organization_id = m.organization_id and l.machine_id = m.id
    join public.stock_locations c on c.organization_id = m.organization_id and c.is_central
      and c.archived_at is null
    join public.stock_levels sl on sl.location_id = l.id and sl.quantity between 0 and 50
    join public.titles t on t.organization_id = m.organization_id and t.id = sl.title_id
      and t.archived_at is null and t.merged_into_id is null and not t.own_product
    where m.organization_id = ${orgId}::uuid and m.archived_at is null
    order by m.code, t.name
    limit 1`;
  if (!row) throw new Error("Seeden saknar en automat med placering och saldo.");
  const before = await level(row.location_id, row.title_id);
  await sql`update public.stock_locations set awish_fill = null, awish_synced_at = null
            where organization_id = ${orgId}::uuid and machine_id is not null`;
  await sql`
    update public.stock_locations
    set awish_synced_at = now(),
        awish_fill = ${sql.json([
          { title_id: row.title_id, units: before, capacity: before + 6, channels: 2, empty: 1 },
        ])}
    where id = ${row.location_id}::uuid`;

  // Order i förra veckan (5) och veckan innan (3): kopior av seedens order med nya tider.
  const [w] = await sql<{ week: string }[]>`
    select (date_trunc('week', (now() at time zone 'Europe/Stockholm')) - interval '7 days')::date::text
           as week`;
  const week = w!.week;
  const plan = [
    ...[0, 1, 2, 4, 6].map((d) => ({ offset: d, tag: "f" })),
    ...[-7, -5, -2].map((d) => ({ offset: d, tag: "i" })),
  ];
  for (const [i, p] of plan.entries()) {
    await sql`
      insert into public.orders
        (organization_id, data_source_id, external_id, raw_title, title_id, ordered_at,
         amount_ore, payment_method, source_machine_id, machine_id, import_id, source_hash)
      select o.organization_id, o.data_source_id, ${`E2E-VECKA-${week}-${i}`}, o.raw_title,
             o.title_id,
             ((${week}::date + ${p.offset}::int)::timestamp + interval '12 hours')
               at time zone 'Europe/Stockholm',
             o.amount_ore, o.payment_method, o.source_machine_id, o.machine_id, o.import_id,
             ${`e2e-vecka-${week}-${i}`}
      from public.orders o
      join public.purchase_prices pp on pp.organization_id = o.organization_id
        and pp.title_id = o.title_id
      where o.organization_id = ${orgId}::uuid and o.title_id is not null
        and o.machine_id is not null and o.test_purchase_at is null
        and not exists (
          select 1 from public.orders x
          where x.organization_id = o.organization_id
            and x.external_id = ${`E2E-VECKA-${week}-${i}`}
        )
      order by o.ordered_at, o.id
      limit 1`;
  }
  const count = async (from: number, to: number) =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from public.orders
        where organization_id = ${orgId}::uuid and test_purchase_at is null
          and business_date between ${week}::date + ${from}::int and ${week}::date + ${to}::int`
    )[0]!.n;

  target = {
    orgId,
    machineId: row.machine_id,
    machineLocation: row.location_id,
    central: row.central,
    titleId: row.title_id,
    title: row.title,
    place: row.place,
    before,
    week,
    lastPacks: await count(0, 6),
    previousPacks: await count(-7, -1),
  };
  await setHome(50);
  expect(target.lastPacks).toBeGreaterThanOrEqual(5);
  expect(target.previousPacks).toBeGreaterThanOrEqual(3);
  browser = await launchBrowser();
});

afterEach(async () => {
  const lists = errors.splice(0, errors.length);
  // Varje test har egna sidor: de stängs, så att en gammal sida inte stör nästa test.
  for (const c of contexts.splice(0, contexts.length)) await c.close().catch(() => {});
  for (const list of lists) {
    expectNoPageErrors(list.filter((e) => !offlineTest || !OFFLINE_ERRORS.test(e.message)));
  }
  offlineTest = false;
});

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  await sql?.end();
});

/**
 * Klar → Ja: bekräftelsen syns på listan, finns kvar efter Uppdatera (datan hämtas om och
 * rutten kan bytas) och Ångra ställer tillbaka lagret.
 */
async function fillAndCheckBanner(
  page: Page,
  via: "direkt" | "listan",
  text: {
    list: string;
    done: RegExp;
    yes: string;
    banner: (n: number) => RegExp;
    refresh: string;
    refreshed: RegExp;
    undo: string;
    undone: RegExp;
  },
): Promise<{ home: number; machine: number }> {
  const { home: homeBefore, machine: machineBefore } = await prepareFill();
  if (via === "direkt") {
    await page.goto(`/fyll-pa/${target.machineId}`);
  } else {
    await page.goto("/fyll-pa");
    const cards = page.getByRole("list", { name: text.list }).getByRole("link");
    await cards.first().waitFor();
    await cards.filter({ hasText: target.place }).first().click();
    await page.waitForURL((url) => url.pathname === `/fyll-pa/${target.machineId}`);
  }
  const input = page.getByLabel(target.title, { exact: true });
  await input.waitFor();
  expect(await input.inputValue()).toBe("6");
  const total = Number(
    (await page.getByRole("button", { name: text.done }).innerText()).replace(/\D/g, ""),
  );
  expect(total).toBeGreaterThanOrEqual(6);
  // Markerar sidan: markeringen försvinner om sidan laddas om.
  await page.evaluate(() => {
    (window as unknown as { __kvar?: boolean }).__kvar = true;
  });
  await page.getByRole("button", { name: text.done }).click();
  await page.getByRole("button", { name: text.yes }).click();

  // Bekräftelsen visas på listan, med Ångra.
  const banner = page.getByRole("status").filter({ hasText: text.banner(total) });
  await banner.waitFor();
  await page.waitForURL((url) => url.pathname === "/fyll-pa");
  await until(
    async () => (await level(target.central, target.titleId)) === homeBefore - 6,
    "vårt lager har 6 pack färre",
  );
  expect(await level(target.machineLocation, target.titleId)).toBe(machineBefore + 6);

  // Sidans egen omhämtning efter Klar är klar: bekräftelsen står kvar på listan.
  await page.waitForLoadState("networkidle");
  expect(await banner.isVisible(), "bekräftelsen finns kvar efter omhämtningen").toBe(true);
  expect(new URL(page.url()).pathname).toBe("/fyll-pa");
  // Felet: Next laddade om hela sidan när påfyllningen sparades. Sidan är samma sida.
  expect(
    await page.evaluate(() => (window as unknown as { __kvar?: boolean }).__kvar === true),
    "sidan laddades inte om av sig själv efter Klar",
  ).toBe(true);

  // Laddas sidan ändå om (t.ex. en ny version av appen) ska bekräftelsen och Ångra finnas
  // kvar: förut låg den i komponentens minne och försvann.
  await page.reload();
  await page.getByRole("list", { name: text.list }).getByRole("link").first().waitFor();
  await banner.waitFor();

  // Uppdatera hämtar om datan en gång till: bekräftelsen och Ångra finns kvar.
  await page.getByRole("button", { name: text.refresh, exact: true }).click();
  await page.getByText(text.refreshed).waitFor();
  await page.waitForLoadState("networkidle");
  expect(await banner.isVisible(), "bekräftelsen finns kvar efter Uppdatera").toBe(true);
  expect(await banner.getByRole("button", { name: text.undo, exact: true }).isVisible()).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/fyll-pa");
  await settled(page);
  return { home: homeBefore, machine: machineBefore };
}

async function undoFill(
  page: Page,
  text: { undo: string; undone: RegExp },
  home: number,
  machine: number,
): Promise<void> {
  await page.getByRole("status").getByRole("button", { name: text.undo, exact: true }).click();
  await page.getByText(text.undone).first().waitFor();
  await until(
    async () =>
      (await level(target.central, target.titleId)) === home &&
      (await level(target.machineLocation, target.titleId)) === machine,
    "Ångra ställer tillbaka lagret och automaten",
  );
}

const SV = {
  list: "Automater",
  done: /^Klar/,
  yes: "Ja, jag har fyllt på",
  banner: (n: number) => new RegExp(`Klart! ${n}\\s?pack påfyllda`),
  refresh: "Uppdatera",
  refreshed: /^Uppdaterat \d\d:\d\d$/,
  undo: "Ångra",
  undone: /^Ångrat · \d+\s?pack$/,
};

const EN = {
  list: "Machines",
  done: /^Done/,
  yes: "Yes, I refilled",
  banner: (n: number) => new RegExp(`Done! ${n}\\s?packs refilled`),
  refresh: "Refresh",
  refreshed: /^Updated \d\d:\d\d$/,
  undo: "Undo",
  undone: /^Undone · \d+\s?packs$/,
};

describe("Fyll på på iPhone SE: bekräftelsen efter Klar", () => {
  it.each(["listan", "direkt"] as const)(
    "svenska, automaten öppnad via %s: Klart! N pack påfyllda syns och finns kvar",
    async (via) => {
      const { page } = await newPage("sv-SE");
      await login(page, e2e().users.refiller);
      const before = await fillAndCheckBanner(page, via, SV);
      if (via === "listan") await screenshot(page, "vecka-fyll-pa-klar-sv");
      await undoFill(page, SV, before.home, before.machine);
    },
  );

  it.each(["listan", "direkt"] as const)(
    "engelska i den enkla vyn, automaten öppnad via %s: Done! N packs refilled syns och finns kvar",
    async (via) => {
      const { page } = await partnerPage();
      const before = await fillAndCheckBanner(page, via, EN);
      if (via === "listan") await screenshot(page, "vecka-fyll-pa-klar-en");
      await undoFill(page, EN, before.home, before.machine);
    },
  );
});

describe("Ta med-listan på iPhone SE", () => {
  it("svenska: totalt och per automat, varnar när lagret inte räcker, fungerar utan nät", async () => {
    const { page, context } = await newPage("sv-SE");
    await login(page, e2e().users.refiller);
    await prepareFill();
    await page.goto("/fyll-pa");
    await page.getByRole("button", { name: "Ta med-lista" }).click();
    await page.getByRole("heading", { level: 1, name: /^Ta med \d+\s?pack\.$/ }).waitFor();
    // Bara vår automat: den vill ha 6 pack av titeln, och hemma finns 50.
    await onlyTargetMachine(page);
    const total = page.getByRole("list", { name: "Totalt" });
    const line = total.getByRole("listitem").filter({ hasText: target.title });
    await line.waitFor();
    expect((await line.innerText()).split("\n").map((x) => x.trim())).toEqual([
      target.title,
      "6",
      "Hemma: 50",
    ]);
    const perMachine = page.getByRole("region", { name: "Per automat" });
    expect(await perMachine.innerText()).toContain(target.place);
    expect(await perMachine.innerText()).toContain(target.title);
    expect(await noSideScroll(page)).toBe(true);
    expect(await smallTargets(page, "body")).toEqual([]);
    await settled(page);
    await screenshot(page, "vecka-ta-med-sv");

    // Avmarkerad automat räknas inte.
    const box = page.getByRole("checkbox", { name: target.place });
    await box.click();
    expect(await total.getByRole("listitem").filter({ hasText: target.title }).count()).toBe(0);
    await box.click();
    await line.waitFor();

    // Lagret räcker inte: 2 hemma, 6 behövs.
    await setHome(2);
    await page.getByRole("button", { name: "Uppdatera", exact: true }).click();
    await until(async () => (await line.innerText()).includes("saknas 4"), "raden visar saknas 4");
    // Det som går att ta med står stort (2), behovet och saldot under.
    expect((await line.innerText()).split("\n").map((x) => x.trim())).toEqual([
      target.title,
      "2",
      "behöver 6 · Hemma: 2",
      "saknas 4",
    ]);
    const warning = page.getByRole("alert").filter({ hasText: "Lagret räcker inte." });
    await warning.waitFor();
    expect(await warning.innerText()).toMatch(/Lagret räcker inte\. \d+\s?pack saknas\./);
    // Valet av automat står kvar efter Uppdatera.
    expect(await page.getByRole("checkbox", { checked: true }).count()).toBe(1);
    // Listan är kvar efter Uppdatera (den ligger inte i komponentens minne).
    await page.getByRole("heading", { level: 1, name: /^Ta med \d+\s?pack\.$/ }).waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await settled(page);
    await screenshot(page, "vecka-ta-med-saknas-sv");

    // Tillbaka till automaterna.
    await page.getByRole("button", { name: "Automater" }).click();
    await page.getByRole("list", { name: "Automater" }).getByRole("link").first().waitFor();

    // Nätet försvinner (appen är öppen): listan räknas i telefonen, utan något anrop.
    offlineTest = true;
    await context.setOffline(true);
    try {
      await page.getByRole("status").filter({ hasText: "Utan nät" }).first().waitFor();
      await page.getByRole("button", { name: "Ta med-lista" }).click();
      await page.getByRole("heading", { level: 1, name: /^Ta med \d+\s?pack\.$/ }).waitFor();
      await page.getByText("Utan nät: listan räknas på det som sparats i telefonen.").waitFor();
      expect(await page.getByRole("list", { name: "Totalt" }).innerText()).toContain(target.title);
      expect(await page.getByRole("region", { name: "Per automat" }).innerText()).toContain(
        target.place,
      );
      await settled(page);
      await screenshot(page, "vecka-ta-med-utan-nat-sv");
    } finally {
      await context.setOffline(false);
      await setHome(50);
    }
  });

  it("engelska i den enkla vyn: Bring list", async () => {
    await prepareFill();
    const { page } = await partnerPage();
    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "Refill" })
      .click();
    await page.waitForURL((url) => url.pathname === "/fyll-pa");
    await page.getByRole("button", { name: "Bring list" }).click();
    await page.getByRole("heading", { level: 1, name: /^Bring \d+\s?packs\.$/ }).waitFor();
    await onlyTargetMachine(page);
    const line = page
      .getByRole("list", { name: "Total" })
      .getByRole("listitem")
      .filter({ hasText: target.title });
    await line.waitFor();
    expect(await line.innerText()).toContain("Home: 50");
    await page.getByRole("heading", { name: "Which machines?" }).waitFor();
    await page.getByRole("heading", { name: "Per machine" }).waitFor();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/Ta med|Totalt|Per automat|Vilka|Hemma|saknas|behöver|Lagret/);
    expect(await noSideScroll(page)).toBe(true);
    await settled(page);
    await screenshot(page, "vecka-bring-list-en");
    await page.getByRole("button", { name: "Machines" }).click();
    await page.getByRole("button", { name: "Bring list" }).waitFor();
  });
});

describe("Veckosammanfattningen på iPhone SE", () => {
  it("ägaren: Veckan visar förra veckan mot veckan innan, bästa produkten och Att göra", async () => {
    const { page } = await newPage("sv-SE");
    await login(page, e2e().users.owner);
    await page.goto(`/veckan?v=${target.week}`);
    const heading = page.getByRole("heading", { level: 1 });
    await heading.waitFor();
    expect(await heading.innerText()).toMatch(
      new RegExp(`^${target.lastPacks}\\s?pack sålda\\. .+\\skr i vinst\\.$`),
    );
    const last = page.getByRole("region", { name: "Förra veckan" });
    expect(await last.innerText()).toContain("Vår vinst (före butikernas andel)");
    expect(await last.innerText()).toMatch(new RegExp(`${target.lastPacks}\\s?pack`));
    const diff = target.lastPacks - target.previousPacks;
    if (diff > 0) {
      expect(await last.innerText()).toMatch(new RegExp(`${diff}\\s?pack fler än veckan innan`));
    }
    const before = page.getByRole("region", { name: /^Veckan innan/ });
    expect(await before.innerText()).toMatch(new RegExp(`${target.previousPacks}\\s?pack`));
    await page.getByRole("region", { name: "Bästa produkten" }).waitFor();
    expect(await page.getByRole("region", { name: "Bästa produkten" }).innerText()).toMatch(
      /\d+\s?pack · .+ i vinst/,
    );
    await page.getByRole("region", { name: "Att göra" }).waitFor();
    await page.getByText("Butikernas andel är inte dragen.").waitFor();
    expect(await noSideScroll(page)).toBe(true);
    expect(await smallTargets(page, "main section[aria-labelledby=veckan]")).toEqual([]);
    await settled(page);
    await screenshot(page, "vecka-veckan-sv");

    // Utan ?v= visas förra veckan (samma sida).
    await page.goto("/veckan");
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toMatch(
      new RegExp(`^${target.lastPacks}\\s?pack sålda\\.`),
    );
    // Att göra går att öppna härifrån (om det finns något att göra).
    const open = page.getByRole("link", { name: "Öppna Att göra" });
    if ((await open.count()) > 0) {
      await open.click();
      await page.waitForURL((url) => url.pathname === "/att-gora");
    }
  });

  it("ägaren: knappen Veckosammanfattning finns under Notiser och leder till Veckan", async () => {
    const { page } = await newPage("sv-SE");
    await login(page, e2e().users.owner);
    await page.goto("/drift/larm");
    const card = page.getByRole("region", { name: "Veckosammanfattning" });
    await card.waitFor();
    const knob = card.getByRole("switch", { name: "Veckosammanfattning" });
    await knob.waitFor();
    await card
      .getByText("En notis varje måndag morgon: sålt, vinst och bästa produkten.")
      .waitFor();
    const box = await knob.boundingBox();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box!.width)).toBeGreaterThanOrEqual(44);
    // Safari på iPhone utan appen på hemskärmen kan inte få notiser: det sägs, inget sparas.
    await knob.click();
    await card.getByRole("alert").waitFor();
    expect(await card.getByRole("alert").innerText()).toContain("Lägg till på hemskärmen");
    expect(await knob.getAttribute("aria-checked")).toBe("false");
    await card.scrollIntoViewIfNeeded();
    await settled(page);
    await screenshot(page, "vecka-knapp-notiser-sv");
    await card.getByRole("link", { name: /Visa förra veckan/ }).click();
    await page.waitForURL((url) => url.pathname === "/veckan");
    await page.getByRole("region", { name: "Förra veckan" }).waitFor();
  });

  it("delägaren: notisen öppnar sammanfattningen på Sales, på engelska", async () => {
    const { page } = await partnerPage();
    await page.goto(`/?vecka=${target.week}`);
    const summary = page.locator("section[aria-labelledby=veckan]");
    await summary.waitFor();
    expect(await summary.getByRole("heading", { level: 2 }).first().innerText()).toMatch(
      new RegExp(`^${target.lastPacks}\\s?packs sold\\. .+\\skr profit\\.$`),
    );
    const text = await summary.innerText();
    // Etiketterna visas med versaler (CSS): jämför utan hänsyn till det.
    expect(text).toMatch(/last week/i);
    expect(text).toMatch(/the week before/i);
    expect(text).toContain("Our profit (before the stores' share)");
    expect(text).toMatch(/best product/i);
    expect(text).toContain("The stores' share is not deducted.");
    // Engelska rakt igenom, och inget om Att göra (listan finns inte i den enkla vyn).
    expect(text).not.toMatch(/förra|veckan|vinst|sålda|att göra|to do|butikernas|bästa/i);
    // Sales står kvar under sammanfattningen.
    await page.getByText("This week", { exact: true }).waitFor();
    expect(await noSideScroll(page)).toBe(true);
    expect(await smallTargets(page, "main")).toEqual([]);
    await settled(page);
    await screenshot(page, "vecka-sales-summary-en");

    // Close tar bort sammanfattningen.
    await summary.getByRole("link", { name: "Close", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/" && !url.search);
    await until(async () => (await summary.count()) === 0, "sammanfattningen är stängd");
    // Hela appens sida Veckan är inte hans: den skickar tillbaka till Sales.
    await page.goto("/veckan");
    await page.waitForURL((url) => url.pathname === "/");
  });

  it("delägaren: Weekly summary i menyn, på engelska", async () => {
    const { page } = await partnerPage();
    await page.getByRole("button", { name: "More" }).click();
    const dialog = page.getByRole("dialog");
    const knob = dialog.getByRole("switch", { name: "Weekly summary" });
    await knob.waitFor();
    await dialog
      .getByText("A notification every Monday morning: sold, profit and best product.")
      .waitFor();
    expect(await knob.getAttribute("aria-checked")).toBe("false");
    const box = await knob.boundingBox();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
    await knob.click();
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("alert").innerText()).toBe(
      "iPhone: tap Share and Add to Home Screen. Open Binderlab from there.",
    );
    expect(await knob.getAttribute("aria-checked")).toBe("false");
    const [pref] = await sql<{ weekly_summary: boolean | null }[]>`
      select p.weekly_summary from public.profiles p
      join auth.users u on u.id = p.user_id and u.email = ${PARTNER}
      where p.organization_id = ${target.orgId}::uuid`;
    expect(pref?.weekly_summary ?? null).toBeNull();
    await settled(page);
    await screenshot(page, "vecka-menu-weekly-summary-en");
  });

  it("cron-routen kräver hemligheten och skickar inget utanför måndag morgon", async () => {
    const open = await fetch(new URL("/api/cron/vecka", e2e().baseUrl));
    expect(open.status).toBe(401);
    const secret = e2e().cronSecret;
    if (!secret) throw new Error("E2E_CRON_SECRET saknas (serverns CRON_SECRET).");
    const res = await fetch(new URL("/api/cron/vecka", e2e().baseUrl), {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; errors: number };
    // Ingen i e2e-databasen har en telefon med notiser: inget skickas, vilken dag det än är.
    expect(body).toMatchObject({ sent: 0, errors: 0 });
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.weekly_summaries
      where organization_id = ${target.orgId}::uuid`;
    expect(n!.n).toBe(0);
  });
});

describe("Lönsamhet på iPhone SE", () => {
  it("antal sålda står under namnet per titel, utan sidledes scroll", async () => {
    const { page } = await newPage("sv-SE");
    await login(page, e2e().users.owner);
    await page.goto(`/lonsamhet?${SEED_PERIOD}`);
    const table = page
      .getByRole("table")
      .filter({ has: page.getByRole("columnheader", { name: "Titel" }) });
    await table.first().waitFor();
    // Kolumnen Order är dold på telefonen.
    expect(await table.first().getByRole("columnheader", { name: "Order" }).isVisible()).toBe(
      false,
    );
    // Titeln med flest order i perioden (ur databasen) har antalet under namnet.
    const [top] = await sql<{ name: string; n: number }[]>`
      select t.name, count(*)::int as n from public.orders o
      join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
      where o.organization_id = ${target.orgId}::uuid and o.test_purchase_at is null
        and o.business_date between '2026-10-13' and '2026-11-01'
      group by t.name order by n desc, t.name limit 1`;
    const row = table.first().getByRole("row").filter({ hasText: top!.name }).first();
    await row.scrollIntoViewIfNeeded();
    const sold = row.locator("[data-sold]");
    expect(await sold.isVisible()).toBe(true);
    expect((await sold.innerText()).replace(/\s/g, " ")).toBe(`${top!.n} sålda`);
    // Varje titelrad har ett antal, och totalen står sist.
    const lines = await table.first().locator("tbody [data-sold]").allInnerTexts();
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => /^\d[\d\s]*\ssåld(a)?$/.test(l))).toBe(true);
    expect(await table.first().locator("tfoot [data-sold]").isVisible()).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await settled(page);
    await screenshot(page, "vecka-lonsamhet-salda-sv");
  });
});
