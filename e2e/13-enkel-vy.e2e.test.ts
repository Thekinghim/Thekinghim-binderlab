/**
 * Enkel vy på engelska (iPhone SE, 375 px): ägaren slår på Enkel vy och engelska för en
 * delägare i Inställningar → Användare. Delägaren loggar in (webbläsaren på engelska) och
 * ser bara tre flikar: Refill, Sales och Mystery, allt på engelska. /lonsamhet och
 * /installningar skickar tillbaka till Sales. Fyll på: Done frågar "Have you refilled the
 * machine now?", "Yes, I refilled" sparar (vårt lager och automaten ändras i databasen).
 * Mystery: ett mystery pack visar innehållet. Menyn har Update app, och en ny version visas
 * för delägaren på engelska ("A new version of the app is ready", som e2e/12 på svenska).
 *
 * Förberedelse i databasen (E2E_DATABASE_URL): en delägare (ägarroll) med eget lösenord,
 * en Awish-läsning för en automat (som e2e/07) och ett mystery pack med innehåll. Testet går
 * att köra flera gånger (delägaren och mystery-packet återanvänds).
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { TEST_BUILD_COOKIE } from "@/lib/build-id";
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

const DEVICE = "iPhone SE";
const PARTNER = "delagare-enkel@binderlab.local";
const PARTNER_PASSWORD = "enkel-vy-e2e-losenord";
const MYSTERY = "E2E Mystery Pack";

let browser: Browser;
let sql: postgres.Sql;
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
  mysteryId: string;
}
let target: Target;

async function level(location: string, titleId: string): Promise<number> {
  const [r] = await sql<{ q: number }[]>`
    select quantity::int as q from public.stock_levels
    where location_id = ${location}::uuid and title_id = ${titleId}::uuid`;
  return r?.q ?? 0;
}

async function newPage(locale: string): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark", locale });
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened.page;
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

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const orgId = e2e().organizationId;

  // Delägaren: ägarroll, full vy och svenska från början (ägaren ändrar det i testet).
  const hash = await hashPassword(PARTNER_PASSWORD);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${PARTNER}, ${hash}, ${sql.json({ full_name: "Delägare Enkel" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql`
    insert into public.memberships (organization_id, user_id, role)
    values (${orgId}::uuid, ${user!.id}::uuid, 'owner')
    on conflict (organization_id, user_id) do update set view_mode = 'full'`;
  await sql`
    insert into public.profiles (organization_id, user_id, display_name)
    values (${orgId}::uuid, ${user!.id}::uuid, 'Delägare Enkel')
    on conflict (organization_id, user_id) do update set locale = 'sv'`;

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
          { title_id: row.title_id, units: before, capacity: before + 4, channels: 2, empty: 1 },
        ])}
    where id = ${row.location_id}::uuid`;
  await sql`
    insert into public.stock_events
      (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
    values (${orgId}::uuid, ${row.central}::uuid, ${row.title_id}::uuid, 'count', 50, now(),
            'E2E: Enkel vy')`;

  // Mystery: en egen produkt med innehåll (två vanliga titlar, en markerad som HIT).
  const parts = await sql<{ id: string }[]>`
    select id from public.titles
    where organization_id = ${orgId}::uuid and archived_at is null and merged_into_id is null
      and not own_product
    order by name limit 2`;
  const [mystery] = await sql<{ id: string }[]>`
    select id from public.titles where organization_id = ${orgId}::uuid and name = ${MYSTERY}`;
  const mysteryId =
    mystery?.id ??
    (
      await sql<{ id: string }[]>`
        insert into public.titles (organization_id, name, own_product)
        values (${orgId}::uuid, ${MYSTERY}, true) returning id`
    )[0]!.id;
  await sql`update public.titles set own_product = true where id = ${mysteryId}::uuid`;
  await asOwner(
    (tx) => tx`select public.save_mystery_recipe(${orgId}::uuid, ${mysteryId}::uuid, 10,
      ${tx.json([
        { titleId: parts[0]!.id, quantity: 7, hit: false },
        { titleId: parts[1]!.id, quantity: 3, hit: true },
      ])})`,
  );

  target = {
    orgId,
    machineId: row.machine_id,
    machineLocation: row.location_id,
    central: row.central,
    titleId: row.title_id,
    title: row.title,
    place: row.place,
    before,
    mysteryId,
  };
  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
});

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  // Delägaren tillbaka till full vy och svenska (testet går att köra igen).
  await sql`
    update public.memberships m set view_mode = 'full'
    from auth.users u where u.id = m.user_id and u.email = ${PARTNER}`;
  await sql?.end();
});

describe("Enkel vy på engelska (iPhone SE)", () => {
  it("ägaren slår på Enkel vy och engelska för delägaren", async () => {
    const page = await newPage("sv-SE");
    await login(page, e2e().users.owner);
    await page.goto("/installningar/anvandare");
    const row = page
      .getByRole("listitem")
      .filter({ has: page.getByText(PARTNER, { exact: true }) });
    await row.getByText("Enkel vy", { exact: true }).waitFor();
    await row.getByText("Ser bara Fyll på, Försäljning och Mystery.").waitFor();
    expect(await row.getByRole("switch").isChecked()).toBe(false);
    // Etiketten är tryckytan (44 px); brytaren följer med.
    await row.getByText("Enkel vy", { exact: true }).click();
    await page.getByText("Delägare Enkel ser nu bara den enkla vyn.").waitFor();
    await row.getByRole("combobox").selectOption("en");
    await page.getByText("Språket för Delägare Enkel är sparat.").waitFor();
    await until(async () => {
      const [r] = await sql<{ view_mode: string; locale: string }[]>`
        select m.view_mode, p.locale from public.memberships m
        join auth.users u on u.id = m.user_id and u.email = ${PARTNER}
        join public.profiles p on p.organization_id = m.organization_id and p.user_id = m.user_id
        where m.organization_id = ${target.orgId}::uuid`;
      return r?.view_mode === "simple" && r.locale === "en";
    }, "delägaren har enkel vy och engelska i databasen");
    await row.scrollIntoViewIfNeeded();
    await screenshot(page, "13-agare-team-enkel-vy-iphonese");
    // Den egna raden har ingen brytare (man ändrar aldrig sin egen vy).
    const own = page
      .getByRole("listitem")
      .filter({ has: page.getByText(e2e().users.owner, { exact: true }) });
    await own.waitFor();
    expect(await own.getByRole("switch").count()).toBe(0);
  });

  it("delägaren ser bara Refill, Sales och Mystery, på engelska", async () => {
    const page = await newPage("en-GB");
    await page.goto("/logga-in");
    // Före inloggningen: webbläsarens språk.
    await page.getByRole("heading", { name: "Sign in." }).waitFor();
    await screenshot(page, "13-delagare-logga-in-iphonese");
    await page.getByLabel("Email").fill(PARTNER);
    await page.getByLabel("Password").fill(PARTNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");

    const nav = page.getByRole("navigation", { name: "Menu" });
    const tabs = nav.getByRole("link");
    expect(await tabs.allInnerTexts()).toEqual(["Refill", "Sales", "Mystery"]);
    await page.getByText("Our profit (before stores' share)").first().waitFor();
    await page.getByText("Today", { exact: true }).waitFor();
    await page.getByText("This week", { exact: true }).waitFor();
    await page.getByText("This month", { exact: true }).waitFor();
    // Inget av hela appen: ingen sidomeny, ingen sökning, ingen AI-knapp.
    for (const word of ["Lönsamhet", "Inställningar", "Sök", "Fråga AI", "Hem"]) {
      expect(await page.getByRole("link", { name: word, exact: true }).count(), word).toBe(0);
    }
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/Försäljning|Vår vinst|Fyll på|I dag/);
    // Bredare än skärmen? (iPhone SE: 375 px)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await screenshot(page, "13-delagare-sales-iphonese");

    // Menyn: bara språk, Update app och Log out.
    await page.getByRole("button", { name: "More" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "English" }).waitFor();
    await dialog.getByRole("button", { name: "Update app", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Log out" }).waitFor();
    expect(await dialog.getByRole("link").count()).toBe(0);
    await screenshot(page, "13-delagare-meny-iphonese");
    await dialog.getByRole("button", { name: "Close" }).click();

    // En ny version driftsätts (kakan, som e2e/12): rutan visas på engelska.
    await until(
      async () => (await page.evaluate(() => document.documentElement.dataset.appVersion)) === "ok",
      "versionen ok",
    );
    // Sidans kontext: den senast öppnade (newPage ovan).
    await contexts[contexts.length - 1]!.addCookies([
      { name: TEST_BUILD_COOKIE, value: `e2e-en-${Date.now().toString(36)}`, url: e2e().baseUrl },
    ]);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })),
    );
    const banner = page.getByRole("status", { name: "New version of the app" });
    await banner.waitFor();
    expect(await banner.innerText()).toContain("A new version of the app is ready");
    await banner.getByRole("button", { name: "Update", exact: true }).waitFor();
    await screenshot(page, "13-delagare-ny-version-iphonese");
    await banner.getByRole("button", { name: "Later", exact: true }).click();
    await banner.waitFor({ state: "detached" });

    // Allt annat skickas tillbaka till Sales.
    for (const path of [
      "/lonsamhet",
      "/installningar",
      "/installningar/anvandare",
      "/",
      "/drift",
    ]) {
      await page.goto(path);
      await page.waitForURL((url) => url.pathname === "/");
    }
  });

  it("Refill: Done frågar på engelska och sparar påfyllningen", async () => {
    const page = await newPage("en-GB");
    await page.goto("/logga-in");
    await page.getByLabel("Email").fill(PARTNER);
    await page.getByLabel("Password").fill(PARTNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");

    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "Refill" })
      .click();
    await page.waitForURL((url) => url.pathname === "/fyll-pa");
    await page
      .getByRole("heading", { name: /^Refill \d+ machines?\.$|^Nothing is empty/ })
      .waitFor();
    const cards = page.getByRole("list", { name: "Machines" }).getByRole("link");
    await cards.first().waitFor();
    expect(await cards.first().getAttribute("aria-label")).toContain(target.place);
    await page.getByRole("button", { name: "More" }).waitFor();
    await screenshot(page, "13-delagare-refill-iphonese");

    await cards.first().click();
    await page.waitForURL((url) => url.pathname === `/fyll-pa/${target.machineId}`);
    const input = page.getByLabel(target.title, { exact: true });
    await input.waitFor();
    expect(await input.inputValue()).toBe("4");
    await page.getByRole("button", { name: `One less ${target.title}` }).click();
    expect(await input.inputValue()).toBe("3");
    // Bottenraden döljs här: Done står nedtill.
    expect(await page.getByRole("navigation", { name: "Menu" }).count()).toBe(0);
    await screenshot(page, "13-delagare-refill-automat-iphonese");

    const done = page.getByRole("button", { name: /^Done/ });
    const total = Number((await done.innerText()).replace(/\D/g, ""));
    expect(total).toBeGreaterThanOrEqual(3);
    await done.click();
    await page.getByText("Have you refilled the machine now?").first().waitFor();
    await page.getByRole("button", { name: "No, I'm only packing" }).waitFor();
    await screenshot(page, "13-delagare-refill-bekrafta-iphonese");
    expect(await level(target.central, target.titleId)).toBe(50);
    await page.getByRole("button", { name: "Yes, I refilled" }).click();
    await page
      .getByText(new RegExp(`Done! ${total}\\s?packs? refilled`))
      .first()
      .waitFor();
    await page.waitForURL((url) => url.pathname === "/fyll-pa");
    await until(
      async () => (await level(target.central, target.titleId)) === 47,
      "vårt lager har 47 pack kvar",
    );
    expect(await level(target.machineLocation, target.titleId)).toBe(target.before + 3);
    await page.getByRole("button", { name: "Undo" }).waitFor();
    await screenshot(page, "13-delagare-refill-klar-iphonese");
  });

  it("Mystery: listan och innehållet på engelska", async () => {
    const page = await newPage("en-GB");
    await page.goto("/logga-in");
    await page.getByLabel("Email").fill(PARTNER);
    await page.getByLabel("Password").fill(PARTNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");

    // Dev-servern kompilerar mystery-sidorna kallt vid första besöket och laddar då om
    // sidan mitt i navigeringen (tillbaka till /). Hämta dem en gång först, med samma
    // inloggning, så att klicken nedan testar appen och inte kompileringen.
    const context = contexts.at(-1);
    if (!context) throw new Error("Sidan saknar sammanhang.");
    for (const path of ["/vart-lager/mystery", `/vart-lager/mystery/${target.mysteryId}`]) {
      expect((await context.request.get(path, { maxRedirects: 0 })).status()).toBe(200);
    }

    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "Mystery" })
      .click();
    await page.waitForURL((url) => url.pathname === "/vart-lager/mystery");
    await page.getByRole("heading", { name: /mystery packs? in stock\.$/ }).waitFor();
    await page.getByText("Chance of a hit").first().waitFor();
    const body = await page.locator("body").innerText();
    // Inga belopp och ingen redigering i den enkla vyn.
    expect(body).not.toMatch(
      /\d\s?kr\b|Inköpspris|Purchase price|Lägg in innehållet|Change contents/,
    );
    await screenshot(page, "13-delagare-mystery-iphonese");

    await page.getByRole("link", { name: MYSTERY }).click();
    await page.waitForURL((url) => url.pathname === `/vart-lager/mystery/${target.mysteryId}`);
    await page.getByRole("heading", { name: "Contents" }).waitFor();
    await page.getByText("7 of 10").waitFor();
    await page.getByText("3 of 10").first().waitFor();
    await page.getByText("HIT", { exact: true }).first().waitFor();
    await page.getByText("Chance of a hit", { exact: true }).waitFor();
    expect(await page.getByRole("link", { name: "Purchase prices" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Change contents" }).count()).toBe(0);
    await screenshot(page, "13-delagare-mystery-innehall-iphonese");
  });
});
