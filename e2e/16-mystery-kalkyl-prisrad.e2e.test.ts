/**
 * Mystery-kalkylen och Prisråd på iPhone SE (375 px).
 *
 * Läget: "Kalkyl Mystery Premium" packas av 6 Kalkyl Fusion Strike och 4 Kalkyl Phantasmal
 * Flames per omgång på 10. Fusion Strike har rättats från 133 till 220 kr, men mystery-packet
 * har kvar sitt inskrivna inköpspris 174 kr. Kalkylen säger 192 kr (1 920 kr per omgång).
 *
 * 1. Ägaren (svenska): Att göra säger "… kostar nu 192 kr, inte 174 kr". Mystery-sidan visar
 *    notisen och kalkylen (kostnad per omgång och pack, pris, vinst). "Ändra innehåll" räknar
 *    om kalkylen live när antalen ändras, utan att något sparas. Inköpspriser visar notisen.
 * 2. Delägaren (Enkel vy, engelska): Purchase prices och Mystery visar notisen och kalkylen
 *    på engelska. "Update the price from today" sparar 192 kr från i dag; det gamla priset
 *    174 kr ligger kvar i databasen (historiken skrivs inte om).
 * 3. Ägaren: Lönsamhet visar Prisråd med pris, inköp, marginal och "Höj till X kr för Y %
 *    marginal", och säger att priset ändras i automatens system. Målet ändras till 15 %:
 *    mystery-packet försvinner ur listan. Att göra har punkten "… tjänar för lite".
 *
 * Utan sidledes scroll och med tryckytor på minst 44 px. Förberedelsen görs i databasen
 * (E2E_DATABASE_URL) och går att köra flera gånger (titlarna återanvänds, priserna och
 * köpen läggs om).
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { suggestedPriceOre, unitMargin } from "@/domain";
import { hashPassword } from "@/server/auth/password";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

/** iPhone SE (3:e generationen): 375 × 667, 2× pixeltäthet. */
const DEVICE = "iPhone SE (3rd gen)";
/** Samma delägare som e2e/13 (ägarroll); här sätts Enkel vy och engelska direkt. */
const PARTNER = "delagare-enkel@binderlab.local";
const PARTNER_PASSWORD = "enkel-vy-e2e-losenord";

const MYSTERY = "Kalkyl Mystery Premium";
const FUSION = "Kalkyl Fusion Strike";
const FLAMES = "Kalkyl Phantasmal Flames";
/** Mystery-packet säljs för 249 kr. */
const SALE_ORE = 24_900;

let browser: Browser;
let sql: postgres.Sql;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];
let orgId: string;
let mysteryId: string;
let fees: { vatRateBp: number; cardFeeBp: number };

async function newPage(locale: string): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark", locale });
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened.page;
}

async function ownerPage(): Promise<Page> {
  const page = await newPage("sv-SE");
  await login(page, e2e().users.owner);
  return page;
}

async function partnerPage(): Promise<Page> {
  const page = await newPage("en-GB");
  await page.goto("/logga-in");
  await page.getByLabel("Email").fill(PARTNER);
  await page.getByLabel("Password").fill(PARTNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  return page;
}

/** Dev-servern kompilerar sidan kallt första gången: hämta den först, sedan gå dit. */
async function visit(page: Page, path: string): Promise<void> {
  const context = contexts.at(-1);
  if (!context) throw new Error("Sidan saknar sammanhang.");
  expect((await context.request.get(path, { maxRedirects: 0 })).status()).toBe(200);
  await page.goto(path);
}

/** Elementets text med vanliga mellanslag (talen har hårda mellanslag). */
async function plain(locator: Locator): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, " ").trim();
}

/** Skärmbild när sidans ändliga animationer (rader som tonas in) är klara. */
async function shot(page: Page, name: string): Promise<void> {
  await until(
    () =>
      page.evaluate(() =>
        document.getAnimations().every(
          (a) =>
            a.playState !== "running" ||
            a.effect === null ||
            // Eviga animationer (t.ex. en pulserande prick) väntar vi inte på.
            a.effect.getComputedTiming().iterations === Infinity,
        ),
      ),
    "animationerna är klara",
  );
  await screenshot(page, name);
}

async function expectNoSideScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= Math.min(window.innerWidth, window.screen.width),
    ),
  ).toBe(true);
}

/** Tryckytor på minst 44 × 44 px inom `scope` (en CSS-väljare). */
async function expectTapTargets(page: Page, scope: string): Promise<void> {
  const small = await page.evaluate(
    (sel: string) =>
      Array.from(document.querySelectorAll(sel)).flatMap((root) =>
        Array.from(root.querySelectorAll("a, button, input, select, summary"))
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
  expect(small, JSON.stringify(small)).toEqual([]);
}

/** Som ägaren i databasen (RLS, auth.uid()): för RPC:er som kräver en inloggad ägare. */
async function asOwner<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const [owner] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${e2e().users.owner}`;
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: owner!.id,
      email: e2e().users.owner,
      role: "authenticated",
    })}, true), set_config('role', 'authenticated', true)`;
    return fn(tx);
  })) as T;
}

async function titleId(name: string, own: boolean): Promise<string> {
  const [found] = await sql<{ id: string }[]>`
    select id from public.titles where organization_id = ${orgId}::uuid and name = ${name}`;
  if (found) return found.id;
  const [made] = await sql<{ id: string }[]>`
    insert into public.titles (organization_id, name, own_product)
    values (${orgId}::uuid, ${name}, ${own}) returning id`;
  return made!.id;
}

const mysteryPrices = () => sql<{ ore: number; today: boolean }[]>`
  select unit_cost_ore::int as ore,
         valid_from = (now() at time zone 'Europe/Stockholm')::date as today
  from public.purchase_prices
  where organization_id = ${orgId}::uuid and title_id = ${mysteryId}::uuid
  order by valid_from`;

const kr = (ore: number) =>
  ore % 100 === 0 ? `${ore / 100}` : (ore / 100).toFixed(2).replace(".", ",");

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  orgId = e2e().organizationId;

  // Delägaren: ägarroll, Enkel vy och engelska.
  const hash = await hashPassword(PARTNER_PASSWORD);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${PARTNER}, ${hash}, ${sql.json({ full_name: "Delägare Enkel" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql`
    insert into public.memberships (organization_id, user_id, role, view_mode)
    values (${orgId}::uuid, ${user!.id}::uuid, 'owner', 'simple')
    on conflict (organization_id, user_id) do update set view_mode = 'simple'`;
  await sql`
    insert into public.profiles (organization_id, user_id, display_name, locale)
    values (${orgId}::uuid, ${user!.id}::uuid, 'Delägare Enkel', 'en')
    on conflict (organization_id, user_id) do update set locale = 'en'`;

  mysteryId = await titleId(MYSTERY, true);
  const fusion = await titleId(FUSION, false);
  const flames = await titleId(FLAMES, false);
  const ids = [mysteryId, fusion, flames];

  // Samma utgångsläge varje körning: priserna och köpen läggs om (utan triggrar: en
  // tidigare körnings priser får tas bort i e2e-databasen).
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from public.purchase_prices
             where organization_id = ${orgId}::uuid and title_id in ${tx(ids)}`;
    await tx`delete from public.orders
             where organization_id = ${orgId}::uuid and external_id like 'e2e-kalkyl-%'`;
  });
  await sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    values (${orgId}::uuid, ${fusion}::uuid, 13300, '2020-01-01'),
           (${orgId}::uuid, ${fusion}::uuid, 22000, '2024-01-01'),
           (${orgId}::uuid, ${flames}::uuid, 15000, '2020-01-01'),
           (${orgId}::uuid, ${mysteryId}::uuid, 17400, '2020-01-01')`;
  await asOwner(
    (tx) => tx`select public.save_mystery_recipe(${orgId}::uuid, ${mysteryId}::uuid, 10,
      ${tx.json([
        { titleId: fusion, quantity: 6, hit: false },
        { titleId: flames, quantity: 4, hit: true },
      ])})`,
  );
  const [machine] = await sql<{ id: string }[]>`
    select id from public.machines
    where organization_id = ${orgId}::uuid and archived_at is null order by code limit 1`;
  if (!machine) throw new Error("Seeden saknar en automat.");
  for (const n of [1, 2, 3]) {
    await sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, amount_ore, machine_id, source_hash)
      values (${orgId}::uuid, ${e2e().importSource.id}::uuid, ${`e2e-kalkyl-${n}`}, ${MYSTERY},
              ${mysteryId}::uuid, now() - make_interval(hours => ${n * 20}), ${SALE_ORE},
              ${machine.id}::uuid, md5(${`e2e-kalkyl-${n}`}))`;
  }
  await sql`update public.organization_settings set target_margin_bp = 2500
            where organization_id = ${orgId}::uuid`;
  const [settings] = await sql<{ vat: number; fee: number }[]>`
    select vat_rate_bp::int as vat, card_fee_bp::int as fee from public.organization_settings
    where organization_id = ${orgId}::uuid`;
  fees = { vatRateBp: settings?.vat ?? 0, cardFeeBp: settings?.fee ?? 0 };

  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
  errors.length = 0;
});

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  if (sql) {
    await sql`update public.organization_settings set target_margin_bp = 2500
              where organization_id = ${orgId}::uuid`;
    await sql.end();
  }
});

describe("mystery-kalkylen och prisråd (iPhone SE)", () => {
  it("ägaren: notisen i Att göra, på Mystery och på Inköpspriser, och kalkylen live", async () => {
    const page = await ownerPage();
    const notice = `${MYSTERY} kostar nu 192 kr, inte 174 kr`;

    await visit(page, "/att-gora");
    await page.getByText(notice).first().waitFor();
    await page.getByText(notice).first().scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await shot(page, "16-agare-att-gora-mystery-pris-iphonese");

    // Listan: kortet för mystery-packet har notisen med länk till kalkylen.
    await visit(page, "/vart-lager/mystery");
    const card = page.locator("section").filter({ hasText: MYSTERY }).first();
    await card.getByText(notice).waitFor();
    await card.getByText(notice).scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await expectTapTargets(page, '[data-testid="mystery-kostnad-notis"]');
    await shot(page, "16-agare-mystery-lista-notis-iphonese");

    await visit(page, `/vart-lager/mystery/${mysteryId}`);
    const section = page.locator("#kalkyl");
    await section.getByRole("heading", { name: "Kalkyl", exact: true }).waitFor();
    await section.getByText(notice).waitFor();
    const calc = section.locator('[data-testid="kalkyl"]');
    expect(await plain(calc.locator('[data-testid="kalkyl-per-pack"]'))).toBe("192 kr");
    expect(await plain(calc.locator('[data-testid="kalkyl-per-omgang"]'))).toBe("1 920 kr");
    const profit = unitMargin(SALE_ORE, 19_200, fees);
    expect(
      (await calc.locator('[data-testid="kalkyl-vinst"]').innerText()).replace(/\s/g, " "),
    ).toBe(`${kr(profit.profitOre)} kr`);
    await calc.getByText("6 × Kalkyl Fusion Strike").waitFor();
    await calc.getByText("à 220 kr").waitFor();
    await section.getByRole("button", { name: /^Uppdatera priset från i dag/ }).waitFor();
    await section.getByRole("button", { name: /^Rätta priset/ }).waitFor();
    await expectNoSideScroll(page);
    await expectTapTargets(page, "#kalkyl");
    await section.scrollIntoViewIfNeeded();
    await shot(page, "16-agare-mystery-kalkyl-iphonese");

    // "Rätta priset" skriver om sålda pack: den frågar först, och Avbryt ändrar ingenting.
    await section.getByRole("button", { name: /^Rätta priset/ }).click();
    const confirm = section.locator('[data-testid="mystery-kostnad-bekrafta"]');
    await confirm
      .getByText(/Allt som redan är sålt räknas om med 192\skr\. Det går inte att ångra/)
      .waitFor();
    await confirm.getByRole("button", { name: "Ja, rätta priset", exact: true }).waitFor();
    await expectNoSideScroll(page);
    await expectTapTargets(page, '[data-testid="mystery-kostnad-notis"]');
    await shot(page, "16-agare-mystery-ratta-fraga-iphonese");
    await confirm.getByRole("button", { name: "Avbryt", exact: true }).click();
    await section.getByRole("button", { name: /^Uppdatera priset från i dag/ }).waitFor();
    expect((await mysteryPrices()).map((p) => p.ore)).toEqual([17_400]);

    // Vad händer om: en Fusion Strike mindre och en Phantasmal Flames till → 185 kr per pack.
    await page.getByRole("button", { name: "Ändra innehåll" }).click();
    const draft = page.locator('[data-testid="kalkyl-utkast"]');
    await draft.waitFor();
    expect(await plain(draft.locator('[data-testid="kalkyl-per-pack"]'))).toBe("192 kr");
    await page.getByRole("button", { name: `En mindre ${FUSION}` }).click();
    // Antalen går inte jämnt ut (9 av 10): ingen kostnad per pack visas.
    await draft.getByText(/Antalen blir 9 av 10/).waitFor();
    expect(await plain(draft.locator('[data-testid="kalkyl-per-pack"]'))).toBe("–");
    await page.getByRole("button", { name: `En till ${FLAMES}` }).click();
    await page.getByText(/10\sav\s10 · klart att spara/).waitFor();
    await draft.scrollIntoViewIfNeeded();
    await shot(page, "16-agare-mystery-kalkyl-vad-hander-om-iphonese");
    expect(await plain(draft.locator('[data-testid="kalkyl-per-pack"]'))).toBe("185 kr");
    expect(await plain(draft.locator('[data-testid="kalkyl-per-omgang"]'))).toBe("1 850 kr");
    await expectNoSideScroll(page);
    await expectTapTargets(page, "#innehall");
    // Inget sparas: Avbryt, och den sparade kalkylen är kvar.
    await page.getByRole("button", { name: "Avbryt" }).click();
    expect(await plain(calc.locator('[data-testid="kalkyl-per-pack"]'))).toBe("192 kr");
    const [versions] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.mystery_recipes
      where organization_id = ${orgId}::uuid and title_id = ${mysteryId}::uuid`;
    expect(versions!.n).toBe(1);

    await visit(page, "/inkopspriser");
    const banner = page
      .locator('[data-testid="mystery-kostnad-notis"]')
      .filter({ hasText: MYSTERY });
    await banner.getByText(notice).waitFor();
    await banner.getByRole("link", { name: "Visa kalkylen" }).waitFor();
    await banner.scrollIntoViewIfNeeded();
    await shot(page, "16-agare-inkopspriser-notis-iphonese");
  });

  it("delägaren (Enkel vy, engelska) ser notisen och kalkylen och uppdaterar priset från i dag", async () => {
    const page = await partnerPage();
    const notice = `${MYSTERY} now costs 192 kr, not 174 kr`;

    await visit(page, "/inkopspriser");
    const banner = page
      .locator('[data-testid="mystery-kostnad-notis"]')
      .filter({ hasText: MYSTERY });
    await banner.getByText(notice).waitFor();
    await banner.getByRole("button", { name: /^Update the price from today/ }).waitFor();
    await expectNoSideScroll(page);
    await expectTapTargets(page, '[data-testid="mystery-kostnad-notis"]');
    await shot(page, "16-delagare-purchase-prices-notis-iphonese");

    await visit(page, "/vart-lager/mystery");
    const card = page.locator("section").filter({ hasText: MYSTERY }).first();
    await card.getByText(notice).waitFor();
    await card.getByText(notice).scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await shot(page, "16-delagare-mystery-list-notis-iphonese");

    await visit(page, "/inkopspriser");
    await banner.getByRole("link", { name: "Show the calculator" }).click();
    await page.waitForURL((url) => url.pathname === `/vart-lager/mystery/${mysteryId}`);
    const section = page.locator("#kalkyl");
    await section.getByRole("heading", { name: "Calculator", exact: true }).waitFor();
    await section.getByText(notice).waitFor();
    const calc = section.locator('[data-testid="kalkyl"]');
    await calc.getByText("Profit per pack", { exact: true }).waitFor();
    await calc.getByText("Cost per batch (10 packs)", { exact: true }).waitFor();
    expect(await plain(calc.locator('[data-testid="kalkyl-per-pack"]'))).toBe("192 kr");
    await calc.getByText("220 kr each").waitFor();
    const text = await section.innerText();
    expect(text).not.toMatch(/Kostnad|Vinst per|Marginal|Rätta|Uppdatera|VMB|kortavgift/);
    // Delägaren ändrar inte innehållet.
    expect(await page.getByRole("button", { name: "Change contents" }).count()).toBe(0);
    await expectNoSideScroll(page);
    await expectTapTargets(page, "#kalkyl");
    await section.scrollIntoViewIfNeeded();
    await shot(page, "16-delagare-mystery-calculator-iphonese");

    // "Correct the price" frågar först, på engelska; Cancel ändrar ingenting.
    await section.getByRole("button", { name: /^Correct the price/ }).click();
    const confirm = section.locator('[data-testid="mystery-kostnad-bekrafta"]');
    await confirm
      .getByText(/Everything already sold is counted again with 192\skr\. This cannot be undone/)
      .waitFor();
    await confirm.getByRole("button", { name: "Yes, correct the price", exact: true }).waitFor();
    expect(await confirm.innerText()).not.toMatch(/Rätta|Avbryt|sålt/);
    await expectNoSideScroll(page);
    await expectTapTargets(page, '[data-testid="mystery-kostnad-notis"]');
    await shot(page, "16-delagare-mystery-correct-question-iphonese");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();

    // Före: bara det gamla priset.
    expect(await mysteryPrices()).toEqual([{ ore: 17_400, today: false }]);
    await section.getByRole("button", { name: /^Update the price from today/ }).click();
    await page.getByText("The price is 192 kr from today.").first().waitFor();
    await until(async () => (await mysteryPrices()).length === 2, "det nya priset är sparat");
    // Det gamla priset ligger kvar: historiken är inte omskriven.
    expect(await mysteryPrices()).toEqual([
      { ore: 17_400, today: false },
      { ore: 19_200, today: true },
    ]);
    await until(
      async () => (await page.locator('[data-testid="mystery-kostnad-notis"]').count()) === 0,
      "notisen är borta",
    );
    await section.scrollIntoViewIfNeeded();
    await shot(page, "16-delagare-mystery-calculator-uppdaterad-iphonese");

    // Prisråd ligger på Lönsamhet, som delägaren inte når (Enkel vy skickar honom vidare).
    await page.goto("/lonsamhet");
    await page.waitForURL((url) => url.pathname !== "/lonsamhet");
    expect(await page.locator("#prisrad").count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toMatch(/Prisråd|tjänar för lite/);
  });

  it("ägaren: Prisråd på Lönsamhet, målet ändras, och punkten i Att göra", async () => {
    const page = await ownerPage();
    await visit(page, "/lonsamhet");
    const section = page.locator("#prisrad");
    await section.getByRole("heading", { name: /tjänar för lite\.$/ }).waitFor();
    const row = section.locator('[data-testid="prisrad-rad"]').filter({ hasText: MYSTERY });
    // Raden kan ligga bakom "Visa alla" om seeden har många produkter under målet.
    const more = section.locator("details > summary");
    if ((await row.count()) === 0 || !(await row.first().isVisible())) await more.click();
    await row.waitFor();
    const now = unitMargin(SALE_ORE, 19_200, fees);
    const suggested = suggestedPriceOre(19_200, 2_500, fees, SALE_ORE)!;
    const after = unitMargin(suggested, 19_200, fees);
    const pct = (bp: number) => `${Math.round(bp / 100)} %`;
    const rowText = await plain(row);
    expect(rowText).toContain(`Säljs för 249 kr · inköp 192 kr · marginal ${pct(now.marginBp!)}`);
    expect(rowText).toContain(`Höj till ${kr(suggested)} kr för ${pct(after.marginBp!)} marginal`);
    await section
      .getByText("Priset ändras i automatens system. Appen kan inte ändra det.")
      .waitFor();
    await section.getByText("Mål: 25 % marginal").waitFor();
    await expectNoSideScroll(page);
    await expectTapTargets(page, "#prisrad");
    await section.scrollIntoViewIfNeeded();
    await shot(page, "16-agare-lonsamhet-prisrad-iphonese");

    // Målet sänks till 15 %: mystery-packet (cirka 23 %) når det och försvinner ur listan.
    await section.getByRole("button", { name: "Ändra mål" }).click();
    const field = section.getByLabel("Mål för marginalen");
    await field.fill("15");
    await expectTapTargets(page, "#prisrad form");
    await shot(page, "16-agare-lonsamhet-prisrad-mal-iphonese");
    await section.getByRole("button", { name: "Spara", exact: true }).click();
    await section.getByText("Mål: 15 % marginal").waitFor();
    await until(async () => {
      const [r] = await sql<{ bp: number }[]>`
        select target_margin_bp::int as bp from public.organization_settings
        where organization_id = ${orgId}::uuid`;
      return r?.bp === 1_500;
    }, "målet är sparat");
    expect(now.marginBp!).toBeGreaterThan(1_500);
    await until(
      async () =>
        (await section
          .locator('[data-testid="prisrad-rad"]')
          .filter({ hasText: MYSTERY })
          .count()) === 0,
      "mystery-packet når målet 15 %",
    );

    // Tillbaka till 25 %: Att göra har en punkt om produkter som tjänar för lite.
    await sql`update public.organization_settings set target_margin_bp = 2500
              where organization_id = ${orgId}::uuid`;
    await visit(page, "/att-gora");
    // Rådet ligger under "Senare", som är hopfälld på mobilen.
    const later = page.getByRole("button", { name: /^Visa · \d+/ });
    const todo = page.getByText(/produkt(er)? tjänar för lite/).first();
    await later.waitFor();
    await later.click();
    await todo.waitFor();
    await todo.scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await shot(page, "16-agare-att-gora-prisrad-iphonese");

    // "Visa prisråd" landar på Prisråd, inte längre ner på Lönsamhet: rubriken syns på
    // skärmen även när sidan har satt sig (skelettet först, sedan diagrammen).
    await page
      .getByRole("link", { name: /Visa prisråd/ })
      .first()
      .click();
    await page.waitForURL((url) => url.pathname === "/lonsamhet" && url.hash === "#prisrad");
    const heading = page.locator("#prisrad-rubrik");
    await heading.waitFor();
    const inView = () =>
      page.evaluate(() => {
        const r = document.getElementById("prisrad-rubrik")?.getBoundingClientRect();
        return r !== undefined && r.top >= 0 && r.bottom <= window.innerHeight;
      });
    await until(inView, "Prisråd syns på skärmen efter länken från Att göra");
    await page.waitForLoadState("networkidle");
    // Och den ligger kvar där när sidan har satt sig (diagrammen har fått sin höjd): synlig
    // utan avbrott i minst 1,5 sekunder.
    let since = Date.now();
    await until(async () => {
      if (!(await inView())) since = Date.now();
      return Date.now() - since >= 1_500;
    }, "Prisråd ligger kvar på skärmen");
    expect(await inView()).toBe(true);
  });

  it("ägaren: mystery pack utan inköpspris har EN punkt och EN knapp, och de sålda packen får priset", async () => {
    // Ett sålt mystery pack som aldrig har fått något inköpspris: 6 × 220 + 4 × 150 = 192 kr.
    const NAME = "Kalkyl Mystery Utan Pris";
    const id = await titleId(NAME, true);
    const [parts] = await sql<{ fusion: string; flames: string }[]>`
      select (select id from public.titles where organization_id = ${orgId}::uuid
                and name = ${FUSION}) as fusion,
             (select id from public.titles where organization_id = ${orgId}::uuid
                and name = ${FLAMES}) as flames`;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.titles set archived_at = null where id = ${id}::uuid`;
      await tx`delete from public.purchase_prices
               where organization_id = ${orgId}::uuid and title_id = ${id}::uuid`;
    });
    await asOwner(
      (tx) => tx`select public.save_mystery_recipe(${orgId}::uuid, ${id}::uuid, 10,
        ${tx.json([
          { titleId: parts!.fusion, quantity: 6, hit: false },
          { titleId: parts!.flames, quantity: 4, hit: true },
        ])})`,
    );
    const [machine] = await sql<{ id: string }[]>`
      select id from public.machines
      where organization_id = ${orgId}::uuid and archived_at is null order by code limit 1`;
    for (const n of [1, 2]) {
      await sql`
        insert into public.orders (organization_id, data_source_id, external_id, raw_title,
                                   title_id, ordered_at, amount_ore, machine_id, source_hash)
        values (${orgId}::uuid, ${e2e().importSource.id}::uuid, ${`e2e-kalkyl-utan-${n}`}, ${NAME},
                ${id}::uuid, now() - make_interval(hours => ${n * 30}), ${SALE_ORE},
                ${machine!.id}::uuid, md5(${`e2e-kalkyl-utan-${n}`}))`;
    }
    const prices = () => sql<{ ore: number; before_today: boolean }[]>`
      select unit_cost_ore::int as ore,
             valid_from < (now() at time zone 'Europe/Stockholm')::date as before_today
      from public.purchase_prices
      where organization_id = ${orgId}::uuid and title_id = ${id}::uuid`;
    try {
      const page = await ownerPage();
      // Att göra: kalkylens punkt, inte också den vanliga "Lägg in inköpspris".
      await visit(page, "/att-gora");
      await page.getByText(`${NAME} kostar 192 kr men saknar inköpspris`).first().waitFor();
      const later = page.getByRole("button", { name: /^Visa · \d+/ });
      if ((await later.count()) > 0) await later.first().click();
      expect(await page.getByText(`Lägg in inköpspris för ${NAME}`).count()).toBe(0);

      // Kalkylen: en enda knapp. Inget val mellan "från i dag" och "Rätta priset".
      await visit(page, `/vart-lager/mystery/${id}`);
      const notice = page.locator('#kalkyl [data-testid="mystery-kostnad-notis"]');
      await notice.getByText(`${NAME} kostar 192 kr men saknar inköpspris`).waitFor();
      const add = notice.getByRole("button", { name: /^Lägg in priset 192 kr/ });
      await add.waitFor();
      expect(await notice.getByRole("button").count()).toBe(1);
      expect(await plain(add)).toContain("Gäller även allt som redan är sålt.");
      await expectNoSideScroll(page);
      await expectTapTargets(page, '#kalkyl [data-testid="mystery-kostnad-notis"]');
      await notice.scrollIntoViewIfNeeded();
      await shot(page, "16-agare-mystery-utan-pris-iphonese");
      await add.click();
      // Ett pris, från före i dag: de två sålda packen har nu en kostnad.
      await until(async () => (await prices()).length === 1, "priset är sparat");
      expect(await prices()).toEqual([{ ore: 19_200, before_today: true }]);
      await until(async () => (await notice.count()) === 0, "notisen är borta");
      const [unpriced] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.orders o
        where o.organization_id = ${orgId}::uuid and o.title_id = ${id}::uuid
          and not exists (
            select 1 from public.purchase_prices p
            where p.organization_id = o.organization_id and p.title_id = o.title_id
              and p.valid_from <= o.business_date)`;
      expect(unpriced!.n).toBe(0);
      // Att göra har ingen punkt kvar om mystery-packet.
      await visit(page, "/att-gora");
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      const open = page.getByRole("button", { name: /^Visa · \d+/ });
      if ((await open.count()) > 0) await open.first().click();
      const body = await plain(page.locator("main"));
      expect(body).not.toContain(`${NAME} kostar`);
      expect(body).not.toContain(`Lägg in inköpspris för ${NAME}`);
    } finally {
      // Titeln arkiveras, så att den inte ligger kvar i andra testers listor.
      await sql`update public.titles set archived_at = now() where id = ${id}::uuid`;
    }
  });
});
