/**
 * Runda 2, spår T1 på iPhone SE (375 px): Fyll på, Awish-sändningen och Mystery packs.
 *
 * Läget: "R2 Mystery Pack" packas av 8 "R2 Del A" och 6 "R2 Del B" per omgång på 14. Lagret
 * har delar till två omgångar men inga färdiga mystery packs. Automatens mystery-fack är tomt
 * och titeln har sålt 3 om dagen i 14 dagar.
 *
 * 1. Ägaren (svenska): Mystery-kortet säger "Packa 1 omgång nu. <automat> är tom." och aldrig
 *    "packa N st". Ett minus på −14 visas i signalfärg med "Packa 1 omgång nu", −1 med
 *    "Räkna om lagret".
 * 2. Delägaren (Enkel vy, engelska): Fyll på frågar "Did you pack a batch?" före Klar. Avbryt
 *    sparar ingenting.
 * 3. Ägaren: Fyll på frågar "Packade du en omgång?". "Ja, packa 1 omgång och fyll på" lämnar
 *    mystery-lagret på 0 (inte −14), drar delarna enligt innehållet och fyller facket.
 *    Mystery-kortet säger sedan "Inget att packa den här veckan." eller en dag.
 * 4. Påfyllaren packar en omgång, laddar om sidan och kan fortfarande trycka Ångra.
 * 5. En sändning till Awish som inte gick fram syns på automaten ("Awish fick inte antalen
 *    för …" med Försök igen) och försvinner när ett nytt försök går igenom. Med
 *    E2E_FAKE_AWISH_PORT (servern startad med AWISH_WEB_BASE_URL=http://127.0.0.1:<port> och
 *    AWISH_GRPC_ADDRESS=127.0.0.1:1) körs hela vägen mot en låtsas-Awish: Klar när Awish är
 *    nere, raden på svenska och engelska, och Försök igen när den svarar. Aldrig riktiga Awish.
 *
 * Utan sidledes scroll och med tryckytor på minst 44 px. Förberedelsen görs i databasen
 * (E2E_DATABASE_URL) och går att köra flera gånger.
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startFakeAwishWeb } from "@/server/awish/testing/fake-web-server";
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

const DEVICE = "iPhone SE (3rd gen)";
const PARTNER = "delagare-enkel@binderlab.local";
const PARTNER_PASSWORD = "enkel-vy-e2e-losenord";

const MYSTERY = "R2 Mystery Pack";
const PART_A = "R2 Del A";
const PART_B = "R2 Del B";
const PLAIN = "R2 Vanlig titel";
const FAKE_PORT = Number(process.env.E2E_FAKE_AWISH_PORT ?? "");
const withFakeAwish = Number.isInteger(FAKE_PORT) && FAKE_PORT > 0;

let browser: Browser;
let sql: postgres.Sql;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];
let orgId: string;
let mysteryId: string;
let partA: string;
let partB: string;
let plainId: string;
let machineId: string;
let machineCode: string;
let machinePlace: string;
let machineLocation: string;
let central: string;
let centralName: string;
/** "hemma" eller "i Kontoret" (som appen skriver lagrets namn). */
let inCentral: string;

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

async function refillerPage(): Promise<Page> {
  const page = await newPage("sv-SE");
  await login(page, e2e().users.refiller);
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

async function visit(page: Page, path: string): Promise<void> {
  const context = contexts.at(-1);
  if (!context) throw new Error("Sidan saknar sammanhang.");
  expect((await context.request.get(path, { maxRedirects: 0 })).status()).toBe(200);
  await page.goto(path);
}

async function plain(locator: Locator): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, " ").trim();
}

async function shot(page: Page, name: string): Promise<void> {
  await until(
    () =>
      page.evaluate(() =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.playState !== "running" ||
              a.effect === null ||
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

async function level(location: string, title: string): Promise<number> {
  const [row] = await sql<{ q: number }[]>`
    select coalesce((select quantity from public.stock_levels
      where location_id = ${location}::uuid and title_id = ${title}::uuid), 0)::int as q`;
  return Number(row?.q ?? 0);
}

/** Räknar en titel på en plats till `quantity` (en inventering nu). */
async function count(location: string, title: string, quantity: number): Promise<void> {
  await sql`
    insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
    values (${orgId}::uuid, ${location}::uuid, ${title}::uuid, 'count', ${quantity}, 'E2E: runda 2 T1')`;
}

async function adjust(location: string, title: string, delta: number): Promise<void> {
  await sql`
    insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
    values (${orgId}::uuid, ${location}::uuid, ${title}::uuid, 'adjustment', ${delta}, 'E2E: runda 2 T1')`;
}

const logKinds = async () =>
  (
    await sql<{ kind: string }[]>`
      select kind from public.automation_log
      where organization_id = ${orgId}::uuid and machine_id = ${machineId}::uuid
      order by occurred_at, created_at`
  ).map((r) => r.kind);

/** Kortet för mystery-packet på Mystery-sidan. */
const card = (page: Page) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: MYSTERY }) });

/** Öppnar automaten i Fyll på. */
async function openMachine(page: Page): Promise<void> {
  await visit(page, `/fyll-pa/${machineId}`);
  await page.getByRole("heading", { name: machinePlace }).waitFor();
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  orgId = e2e().organizationId;

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
  partA = await titleId(PART_A, false);
  partB = await titleId(PART_B, false);
  plainId = await titleId(PLAIN, false);
  await asOwner(
    (tx) => tx`select public.save_mystery_recipe(${orgId}::uuid, ${mysteryId}::uuid, 14,
      ${tx.json([
        { titleId: partA, quantity: 8, hit: false },
        { titleId: partB, quantity: 6, hit: true },
      ])})`,
  );

  const [m] = await sql<
    { id: string; code: string; place: string; location: string; central: string; name: string }[]
  >`
    select m.id, m.code, st.name as place, l.id as location, c.id as central, c.name
    from public.machines m
    join public.machine_placements p on p.organization_id = m.organization_id
      and p.machine_id = m.id and p.valid_from <= current_date
      and (p.valid_to is null or p.valid_to >= current_date)
    join public.stores st on st.organization_id = p.organization_id and st.id = p.store_id
    join public.stock_locations l on l.organization_id = m.organization_id and l.machine_id = m.id
    join public.stock_locations c on c.organization_id = m.organization_id and c.is_central
      and c.archived_at is null
    where m.organization_id = ${orgId}::uuid and m.archived_at is null
    order by m.code limit 1`;
  if (!m) throw new Error("Seeden saknar en automat med placering.");
  machineId = m.id;
  machineCode = m.code;
  machinePlace = m.place;
  machineLocation = m.location;
  central = m.central;
  centralName = m.name;
  inCentral = centralName.trim().toLowerCase() === "hemma" ? "hemma" : `i ${centralName.trim()}`;

  // 3 köp om dagen de senaste 14 hela dagarna (samma ordernummer varje körning samma dag).
  await sql`
    insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                               ordered_at, amount_ore, machine_id, source_hash)
    select ${orgId}::uuid, ${e2e().importSource.id}::uuid,
           'e2e-r2t1-' || to_char(day, 'YYYYMMDD') || '-' || n, ${MYSTERY}, ${mysteryId}::uuid,
           (day + time '12:00' + (n || ' minutes')::interval) at time zone 'Europe/Stockholm',
           17900, ${machineId}::uuid, md5('e2e-r2t1-' || to_char(day, 'YYYYMMDD') || '-' || n)
    from generate_series(
           (now() at time zone 'Europe/Stockholm')::date - 14,
           (now() at time zone 'Europe/Stockholm')::date - 1, interval '1 day') as day,
         generate_series(1, 3) n
    on conflict do nothing`;

  // Utgångsläget: delar till två omgångar, inga färdiga mystery packs, tomt fack. Automaten
  // har en Awish-läsning med mystery-facket och en vanlig titel som är full (10 av 10).
  await count(central, mysteryId, 0);
  await count(central, partA, 16);
  await count(central, partB, 12);
  await count(central, plainId, 30);
  await count(machineLocation, mysteryId, 0);
  await count(machineLocation, plainId, 10);
  await sql`update public.stock_locations set awish_fill = null, awish_synced_at = null
            where organization_id = ${orgId}::uuid and machine_id is not null`;
  await sql`
    update public.stock_locations
    set awish_synced_at = now(),
        awish_fill = ${sql.json([
          { title_id: mysteryId, units: 0, capacity: 20, channels: 1, empty: 1 },
          { title_id: plainId, units: 10, capacity: 10, channels: 1, empty: 0 },
        ])}
    where id = ${machineLocation}::uuid`;

  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
  errors.length = 0;
});

afterAll(async () => {
  for (const c of contexts) await c.close();
  await browser?.close();
  await sql?.end();
});

describe("Mystery: omgångar räknade från facken, och minus i lagret", () => {
  it("kortet säger att en omgång ska packas nu, aldrig 'packa N st'", async () => {
    const page = await ownerPage();
    await visit(page, "/vart-lager/mystery");
    const text = await plain(card(page));
    expect(text).toContain(`Packa 1 omgång nu. ${machineCode} är tom.`);
    expect(text).not.toMatch(/packa \d+ st/i);
    expect(text).not.toContain("Inköp");
    await expectNoSideScroll(page);
    await shot(page, "r2-t1-mystery-packa-nu");
  });

  it("−14 i lagret och tomt fack: ETT besked, 'Packa 2 omgångar nu'; −1: 'Räkna om lagret'", async () => {
    await adjust(central, mysteryId, -14);
    const page = await ownerPage();
    await visit(page, "/vart-lager/mystery");
    const c = card(page);
    await c
      .getByText(`Det står −14 ${inCentral}. Någon har fyllt på utan att trycka Packa.`)
      .waitFor();
    // Facket är också tomt: minuset och fackets omgång står som ETT besked med summan
    // (förut två nästan likadana "Packa 1 omgång nu").
    const text = await plain(c);
    expect(text).toContain(
      `Packa 2 omgångar nu. 1 rättar minuset. 1 ska till automaten. ${machineCode} är tom.`,
    );
    expect(text).not.toContain(`Packa 1 omgång nu. ${machineCode} är tom.`);
    expect(await c.getByRole("link", { name: /Packa \d+ omgång(ar)? nu/ }).count()).toBe(1);
    const packNow = c.getByRole("link", { name: "Packa 2 omgångar nu" });
    expect(await packNow.getAttribute("href")).toBe(
      `/vart-lager/mystery/${mysteryId}?packa=28&lager=${central}#packa`,
    );
    await expectNoSideScroll(page);
    await expectTapTargets(page, "main li");
    await shot(page, "r2-t1-mystery-minus-14");

    await adjust(central, mysteryId, 13);
    await visit(page, "/vart-lager/mystery");
    // −1 är inte en påfyllning utan Packa: texten skyller inte på någon.
    await card(page).getByText(`Det står −1 ${inCentral}. Det kan inte stämma.`).waitFor();
    const countLink = card(page).getByRole("link", { name: "Räkna om lagret" });
    expect(await countLink.getAttribute("href")).toBe(`/vart-lager/inventering?lager=${central}`);
    expect(
      await card(page)
        .getByRole("link", { name: /Packa \d+ omgång(ar)? nu/ })
        .count(),
    ).toBe(0);
    await shot(page, "r2-t1-mystery-minus-1");
    await count(central, mysteryId, 0);
  });
});

describe("Fyll på: 'Packade du en omgång?'", () => {
  it("delägaren (engelska) får frågan, och Cancel sparar ingenting", async () => {
    const page = await partnerPage();
    await openMachine(page);
    await page.getByText(/^None ready .*Did you pack\?$/).waitFor();
    await page.getByRole("button", { name: "Refill one batch (14)" }).click();
    await page.getByRole("button", { name: /^Done/ }).click();
    const ask = page.getByRole("group", { name: "Did you pack a batch?" });
    await ask.waitFor();
    expect(await plain(ask)).toMatch(new RegExp(`There are 0 ${MYSTERY} at `));
    await ask.getByRole("button", { name: "Yes, pack 1 batch and refill" }).waitFor();
    await ask.getByRole("button", { name: "No, just refill" }).waitFor();
    await expectNoSideScroll(page);
    await expectTapTargets(page, '[role="group"]');
    await shot(page, "r2-t1-fyll-pa-fraga-en");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "hidden" });
    expect(await level(central, mysteryId)).toBe(0);
    expect(await level(machineLocation, mysteryId)).toBe(0);
  });

  it("ägaren svarar Ja: lagret står på 0 (inte −14) och delarna är dragna", async () => {
    const page = await ownerPage();
    await openMachine(page);
    await page.getByText(`Inga färdiga ${inCentral}. Har du packat?`).waitFor();
    await shot(page, "r2-t1-fyll-pa-tomt-mystery-fack");
    await page.getByRole("button", { name: /^Fyll på en omgång \(14\sst\)$/ }).click();
    await page.getByRole("button", { name: /^Klar/ }).click();
    const ask = page.getByRole("group", { name: "Packade du en omgång?" });
    await ask.waitFor();
    expect(await plain(ask)).toContain(`Det finns 0 ${MYSTERY} ${inCentral}.`);
    await expectNoSideScroll(page);
    await expectTapTargets(page, '[role="group"]');
    await shot(page, "r2-t1-fyll-pa-fraga");
    await ask.getByRole("button", { name: "Ja, packa 1 omgång och fyll på" }).click();
    await page.getByText(/Klart! \d+\spack påfyllda/).waitFor();
    await shot(page, "r2-t1-fyll-pa-klart");

    await until(async () => (await level(machineLocation, mysteryId)) === 14, "facket är fyllt");
    expect(await level(central, mysteryId)).toBe(0);
    expect(await level(central, partA)).toBe(8);
    expect(await level(central, partB)).toBe(6);
  });

  it("Mystery-kortet räknar om: facket har 14 pack och 3 säljs om dagen", async () => {
    const page = await ownerPage();
    await visit(page, "/vart-lager/mystery");
    const text = await plain(card(page));
    // 14 pack och 3 om dagen: tom om 5 dagar, alltså inom veckan.
    expect(text).toMatch(
      new RegExp(`Packa 1 omgång före \\S+dag\\. ${machineCode} är tom om ca 5 dagar\\.`),
    );
    expect(text).not.toMatch(/packa \d+ st/i);
    await shot(page, "r2-t1-mystery-packa-fore");

    // Delägaren ser samma sak på engelska.
    const partner = await partnerPage();
    await visit(partner, "/vart-lager/mystery");
    expect(await plain(card(partner))).toMatch(
      new RegExp(`Pack 1 batch before \\S+day\\. ${machineCode} is empty in about 5 days\\.`),
    );
    await expectNoSideScroll(partner);
    await shot(partner, "r2-t1-mystery-packa-fore-en");
  });
});

describe("Påfyllaren ångrar sin egen packning", () => {
  it("packar, laddar om sidan och kan fortfarande trycka Ångra", async () => {
    const page = await refillerPage();
    await visit(page, `/vart-lager/mystery/${mysteryId}`);
    await page.getByRole("button", { name: "Packa 1 omgång", exact: true }).click();
    await until(async () => (await level(central, mysteryId)) === 14, "packningen är sparad");
    expect(await level(central, partA)).toBe(0);

    await page.reload();
    const recent = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Senast packat" }),
    });
    await recent.waitFor();
    const text = await plain(recent);
    expect(text).toMatch(/1 omgång · 14\sst/);
    // Inga belopp för påfyllaren.
    expect(text).not.toMatch(/kr/);
    await expectNoSideScroll(page);
    await expectTapTargets(page, "section");
    await shot(page, "r2-t1-angra-efter-omladdning");
    await recent.getByRole("button", { name: "Ångra", exact: true }).click();
    await until(async () => (await level(central, mysteryId)) === 0, "packningen är ångrad");
    expect(await level(central, partA)).toBe(8);
    expect(await level(central, partB)).toBe(6);
  });
});

describe("Awish fick inte antalen", () => {
  it("raden syns på automaten och försvinner när ett nytt försök går igenom", async () => {
    // En sändning som inte gick fram (som servern sparar den).
    await sql`insert into public.automation_log (organization_id, kind, machine_id, units)
              values (${orgId}::uuid, 'awish_push_failed', ${machineId}::uuid, 0)`;
    const page = await ownerPage();
    await visit(page, "/fyll-pa");
    const line = page.getByText(`Awish fick inte antalen för ${machineCode}.`);
    await line.waitFor();
    await page.getByRole("button", { name: /^(Försök igen|Skickar…)$/ }).waitFor();
    // Rutan står före automaterna, inte under kortet (som oftast ligger sist i listan).
    expect(
      await page.evaluate(() => {
        const box = Array.from(document.querySelectorAll('[role="status"]')).find((el) =>
          (el.textContent ?? "").includes("Awish fick inte antalen"),
        );
        const first = document.querySelector("ul[aria-label] > li");
        return (
          box !== undefined &&
          first !== null &&
          (box.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        );
      }),
    ).toBe(true);
    await expectNoSideScroll(page);
    await shot(page, "r2-t1-awish-fick-inte-antalen");
    // Utan Awish-koppling finns inget att skicka: appens eget försök (eller ett tryck)
    // avslutar väntan och raden försvinner.
    const retry = page.getByRole("button", { name: "Försök igen", exact: true });
    if (await retry.isVisible()) await retry.click({ force: true }).catch(() => {});
    await line.waitFor({ state: "hidden" });
    await until(async () => (await logKinds()).at(-1) !== "awish_push_failed", "väntan är över");
  });

  it("två automater väntar: en rad med båda koderna och ett Försök igen för alla", async () => {
    const page = await ownerPage();
    await visit(page, "/fyll-pa");
    await page.locator("ul[aria-label] > li").first().waitFor();
    // En automat till som står i listan (seeden har flera; annars finns inget att visa här).
    const listed = (await page.locator("ul[aria-label] > li").allInnerTexts())
      .map((text) => /BL-\d+/.exec(text)?.[0])
      .filter((code): code is string => code !== undefined && code !== machineCode);
    const [other] = listed.length
      ? await sql<{ id: string; code: string }[]>`
          select id, code from public.machines
          where organization_id = ${orgId}::uuid and code = ${listed[0]!}`
      : [];
    if (!other) return;
    // Appens eget försök (3 s efter att sidan öppnats) hålls tillbaka tills raden är kontrollerad.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Playwrights route finns på sidan men inte i den smala typen i ./support/browser.
    const routable = page as unknown as {
      route(
        url: string,
        handler: (route: {
          request(): { method(): string };
          continue(): Promise<void>;
        }) => Promise<void>,
      ): Promise<void>;
      unroute(url: string): Promise<void>;
    };
    await routable.route("**/fyll-pa**", async (route) => {
      if (route.request().method() === "POST") await gate;
      // En förfrågan som avbröts av omladdningen finns inte kvar att släppa.
      await route.continue().catch(() => {});
    });
    try {
      for (const id of [machineId, other.id]) {
        await sql`insert into public.automation_log (organization_id, kind, machine_id, units)
                  values (${orgId}::uuid, 'awish_push_failed', ${id}::uuid, 0)`;
      }
      await page.reload();
      const codes = [machineCode, other.code].sort((a, b) =>
        a.localeCompare(b, "sv", { numeric: true }),
      );
      const line = page.getByText(`Awish fick inte antalen för ${codes[0]} och ${codes[1]}.`);
      await line.waitFor();
      // En ruta för alla, inte en per automat.
      expect(await page.getByText(/^Awish fick inte antalen för/).count()).toBe(1);
      expect(await page.getByRole("button", { name: /^(Försök igen|Skickar…)$/ }).count()).toBe(1);
      await expectNoSideScroll(page);
      await expectTapTargets(page, "[role=status]");
      await shot(page, "r2-t1-awish-flera-vantar");
      // Utan Awish-koppling finns inget att skicka: ett försök avslutar väntan för båda.
      release();
      const retry = page.getByRole("button", { name: "Försök igen", exact: true });
      if (await retry.isVisible()) await retry.click({ force: true }).catch(() => {});
      await line.waitFor({ state: "hidden" });
      await until(
        async () =>
          (
            await sql<{ kind: string }[]>`
              select distinct on (machine_id) kind from public.automation_log
              where organization_id = ${orgId}::uuid and machine_id is not null
              order by machine_id, occurred_at desc, created_at desc, id desc`
          ).every((r) => r.kind !== "awish_push_failed"),
        "ingen automat väntar",
      );
    } finally {
      release();
      await routable.unroute("**/fyll-pa**");
    }
  });

  it.skipIf(!withFakeAwish)(
    "hela vägen mot en låtsas-Awish: nere vid Klar, raden på två språk, Försök igen",
    async () => {
      // Koppla organisationen till "Awish" (låtsas-servern) med push påslagen.
      const sourceId = await asOwner(async (tx) => {
        const [found] = await tx<{ id: string }[]>`
          select id from public.data_sources
          where organization_id = ${orgId}::uuid and provider = 'awish_grpc' and archived_at is null
          limit 1`;
        const id =
          found?.id ??
          (
            await tx<{ id: string }[]>`
              insert into public.data_sources (organization_id, provider, name, source_timezone)
              values (${orgId}::uuid, 'awish_grpc', 'Awish API (e2e)', 'Europe/Stockholm')
              returning id`
          )[0]!.id;
        await tx`select public.awish_save_credentials(${orgId}::uuid, ${id}::uuid, 'app', 'secret', 'key')`;
        await tx`select public.awish_save_web_credentials(${orgId}::uuid, ${id}::uuid,
                   'e2e@example.se', 'e2e-losenord')`;
        await tx`select public.awish_set_web_push(${orgId}::uuid, ${id}::uuid, true)`;
        return id;
      });
      await sql`
        insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
        values (${orgId}::uuid, ${sourceId}::uuid, '1001', 'E2E', ${machineId}::uuid)
        on conflict (organization_id, data_source_id, external_id)
        do update set machine_id = ${machineId}::uuid`;
      let fake: Awaited<ReturnType<typeof startFakeAwishWeb>> | null = null;
      try {
        // Den vanliga titeln har 5 av 10 i automaten: förslaget är 5 pack.
        await count(machineLocation, plainId, 5);
        await sql`
          update public.stock_locations
          set awish_synced_at = now(),
              awish_fill = ${sql.json([
                { title_id: mysteryId, units: 14, capacity: 20, channels: 1, empty: 0 },
                { title_id: plainId, units: 5, capacity: 10, channels: 1, empty: 0 },
              ])}
          where id = ${machineLocation}::uuid`;
        // Awish är nere (ingen lyssnar på porten): Klar sparar, men sändningen går inte fram.
        const page = await ownerPage();
        await openMachine(page);
        const before = await level(machineLocation, plainId);
        await page.getByRole("button", { name: /^Klar/ }).click();
        await page.getByRole("button", { name: "Ja, jag har fyllt på", exact: true }).click();
        await page.getByText(/Klart! \d+\spack påfyllda/).waitFor();
        const line = page.getByText(`Awish fick inte antalen för ${machineCode}.`);
        await line.waitFor();
        const after = await level(machineLocation, plainId);
        expect(after).toBeGreaterThan(before);
        expect((await logKinds()).at(-1)).toBe("awish_push_failed");
        await expectNoSideScroll(page);
        await shot(page, "r2-t1-awish-nere-efter-klar");

        // Delägaren ser samma rad på engelska, utan ordet Awish.
        const partner = await partnerPage();
        await visit(partner, "/fyll-pa");
        await partner.getByText(`${machineCode} did not get the new numbers.`).waitFor();
        await partner.getByRole("button", { name: /^(Try again|Sending…)$/ }).waitFor();
        expect(await plain(partner.locator("main, body").first())).not.toMatch(/awish/i);
        await expectNoSideScroll(partner);
        await shot(partner, "r2-t1-awish-nere-en");

        // Awish svarar igen: Försök igen skickar antalet och raden försvinner.
        fake = await startFakeAwishWeb(
          {
            email: "e2e@example.se",
            password: "e2e-losenord",
            products: {
              "1001": [
                {
                  id: 21,
                  goodId: 7,
                  goodName: PLAIN,
                  status: true,
                  currentInventory: before,
                  capacity: 10,
                  channelName: "A1",
                },
              ],
            },
          },
          { port: FAKE_PORT },
        );
        await visit(page, "/fyll-pa");
        await line.waitFor();
        const retry = page.getByRole("button", { name: "Försök igen", exact: true });
        if (await retry.isVisible()) await retry.click({ force: true }).catch(() => {});
        await line.waitFor({ state: "hidden" });
        await until(
          async () => fake!.state.products["1001"]![0]!.currentInventory === after,
          "Awish har fått antalet",
        );
        expect((await logKinds()).at(-1)).toBe("awish_push");
        await shot(page, "r2-t1-awish-skickat");
      } finally {
        await fake?.stop();
        // Lämna aldrig en Awish-koppling kvar i e2e-databasen.
        await asOwner(
          (tx) => tx`select public.awish_set_web_push(${orgId}::uuid, ${sourceId}::uuid, false)`,
        );
        await sql`update public.data_sources set archived_at = now() where id = ${sourceId}::uuid`;
      }
    },
  );
});
