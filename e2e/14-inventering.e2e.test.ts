/**
 * Inventering på iPhone SE (375 px): räkna ett helt eget lager.
 *
 * 1. Ägaren (svenska): Vårt lager → Inventera → välj Hemma → en produkt i taget ("Appen
 *    tror", Stämmer, Hoppa över) och som lista. Appen stängs mitt i (fliken stängs och en
 *    ny öppnas): utkastet finns kvar ("Fortsätt · 3 räknade"). Skillnaderna visas
 *    ("162 → 0") och "Spara inventeringen" sparar allt på en gång: saldona, händelserna
 *    ("Inventering, Hemma") och raden i stock_counts kontrolleras i databasen. Det som
 *    hoppades över är orört. Lagret visar sedan "Inventerat i dag".
 * 2. Delägaren (Enkel vy, engelska): Stock → Count stock → Kontoret, samma flöde på
 *    engelska, utan svenska ord, utan sidledes scroll och med tryckytor på minst 44 px.
 * 3. Att göra: ett lager som inte inventerats på 30 dagar ger punkten "Inventera Garaget",
 *    som öppnar räkningen av just det lagret.
 *
 * Förberedelse (E2E_DATABASE_URL): en delägare med Enkel vy och engelska, lagren Kontoret
 * och Garaget, och kända saldon hemma för tre titlar. Testet går att köra flera gånger.
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
/**
 * Samma delägare som e2e/13 (ingen ny person i teamet: andra tester räknar med hur många
 * som finns). Lösenordet, vyn och språket sätts här och återställs efteråt.
 */
const PARTNER = "delagare-enkel@binderlab.local";
const PARTNER_PASSWORD = "inventering-e2e-losenord";

let browser: Browser;
let sql: postgres.Sql;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];

interface Title {
  id: string;
  name: string;
}
interface Target {
  orgId: string;
  hemma: string;
  kontoret: string;
  garaget: string;
  /** Alla aktiva titlar i sidans ordning är inte kända här: tre med kända saldon hemma. */
  a: Title;
  b: Title;
  c: Title;
  titles: number;
}
let target: Target;

async function level(location: string, titleId: string): Promise<number> {
  const [r] = await sql<{ q: number }[]>`
    select quantity::int as q from public.stock_levels
    where location_id = ${location}::uuid and title_id = ${titleId}::uuid`;
  return r?.q ?? 0;
}

async function open(locale: string): Promise<{ page: Page; context: BrowserContext }> {
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark", locale });
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened;
}

/** En ny flik i samma webbläsare (samma lagring), med samma felkontroll. */
async function reopen(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 60_000));
  const list: Error[] = [];
  errors.push(list);
  page.on("pageerror", (error) => list.push(error));
  return page;
}

/** Tryckytor på minst 44 × 44 px inom `scope` (knappar, länkar och fält som syns). */
async function expectTapTargets(page: Page, scope: string): Promise<void> {
  const small = await page.evaluate(
    (sel: string) =>
      Array.from(document.querySelectorAll(sel)).flatMap((root) =>
        Array.from(root.querySelectorAll("a, button, input, select, [role=radio]"))
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

/** Ingen sidledes scroll och stora tryckytor i sidan. */
async function expectPhonePage(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expectTapTargets(page, "main");
}

/** Talet som det skrivs på svenska ("1 234"), med valfritt (hårt) mellanslag. */
function numberPattern(n: number): string {
  return new Intl.NumberFormat("sv-SE").format(n).replace(/\s/g, "\\s?").replace("−", "[−-]");
}

/** Raden i listläget för en titel (namnet exakt). */
function listField(page: Page, name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) })
    .locator("input");
}

async function draftInStorage(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? "";
      if (key.startsWith("binderlab:inventering:")) return localStorage.getItem(key);
    }
    return null;
  });
}

async function ensurePlace(orgId: string, name: string): Promise<string> {
  const [found] = await sql<{ id: string }[]>`
    select id from public.stock_locations
    where organization_id = ${orgId}::uuid and kind = 'warehouse' and name = ${name}`;
  if (found) {
    await sql`update public.stock_locations set archived_at = null where id = ${found.id}::uuid`;
    return found.id;
  }
  const [made] = await sql<{ id: string }[]>`
    insert into public.stock_locations (organization_id, kind, name)
    values (${orgId}::uuid, 'warehouse', ${name}) returning id`;
  return made!.id;
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const orgId = e2e().organizationId;

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

  const [central] = await sql<{ id: string }[]>`
    select id from public.stock_locations
    where organization_id = ${orgId}::uuid and is_central and archived_at is null`;
  if (!central) throw new Error("Seeden saknar ett eget lager.");
  const kontoret = await ensurePlace(orgId, "Kontoret");
  const garaget = await ensurePlace(orgId, "Garaget");
  // Garaget är 31 dagar gammalt (created_at skyddas av en trigger: av bara för den raden).
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update public.stock_locations set created_at = now() - interval '31 days'
             where id = ${garaget}::uuid`;
  });

  const titles = await sql<Title[]>`
    select id, name from public.titles
    where organization_id = ${orgId}::uuid and archived_at is null and merged_into_id is null
      and not own_product
    order by name limit 3`;
  if (titles.length < 3) throw new Error("Seeden saknar titlar.");
  const a = titles[0]!;
  const b = titles[1]!;
  const c = titles[2]!;
  // Det appen tror hemma: 162, 40 och 12.
  for (const [t, n] of [
    [a, 162],
    [b, 40],
    [c, 12],
  ] as const) {
    await sql`
      insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${central.id}::uuid, ${t.id}::uuid, 'count', ${n}, now(),
              'E2E: Inventering')`;
  }
  const [counted] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.titles
    where organization_id = ${orgId}::uuid and archived_at is null and merged_into_id is null`;
  target = { orgId, hemma: central.id, kontoret, garaget, a, b, c, titles: counted!.n };
  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
});

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  // Garaget bort igen (arkiverat), så att Att göra i andra tester inte får punkten, och
  // delägaren tillbaka till full vy och svenska (som e2e/13 lämnar henne).
  if (target) {
    await sql`update public.stock_locations set archived_at = now()
              where id = ${target.garaget}::uuid`;
    await sql`
      update public.memberships m set view_mode = 'full'
      from auth.users u where u.id = m.user_id and u.email = ${PARTNER}
        and m.organization_id = ${target.orgId}::uuid`;
    await sql`
      update public.profiles p set locale = 'sv'
      from auth.users u where u.id = p.user_id and u.email = ${PARTNER}
        and p.organization_id = ${target.orgId}::uuid`;
  }
  await sql?.end();
});

describe("Inventering (iPhone SE)", () => {
  it("ägaren räknar Hemma: en i taget, lista, utkastet överlever en stängd app, sparar", async () => {
    const { page, context } = await open("sv-SE");
    await login(page, e2e().users.owner);
    await page.goto("/vart-lager");
    const entry = page.getByRole("link", { name: "Inventera", exact: true });
    await entry.waitFor();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const box = await entry.boundingBox();
    expect(box && box.height >= 44 && box.width >= 44).toBe(true);
    await screenshot(page, "14-inventering-0-vart-lager");
    await entry.click();
    await page.waitForURL((url) => url.pathname === "/vart-lager/inventering");

    // 1. Välj lager.
    await page.getByRole("heading", { name: "Vilket lager räknar du?" }).waitFor();
    const hemma = page.getByRole("button", { name: /^Hemma/ });
    await hemma.waitFor();
    expect(await hemma.innerText()).toContain("Inte inventerat än");
    await page.getByRole("button", { name: /^Kontoret/ }).waitFor();
    await expectPhonePage(page);
    await screenshot(page, "14-inventering-1-valj-lager");
    await hemma.click();

    // 2. En i taget: första produkten, det appen tror står där.
    await page.getByRole("heading", { name: "Räkna hemma." }).waitFor();
    await page.getByText(`0 av ${target.titles} räknade`).waitFor();
    await page.getByText(`Produkt 1 av ${target.titles}`).waitFor();
    const firstName = (await page.locator("main h2").first().innerText()).trim();
    const [first] = await sql<Title[]>`
      select id, name from public.titles
      where organization_id = ${target.orgId}::uuid and name = ${firstName}`;
    if (!first) throw new Error(`Okänd första produkt: ${firstName}`);
    const firstLevel = await level(target.hemma, first.id);
    await page.getByText(new RegExp(`Appen tror: ${numberPattern(firstLevel)}`)).waitFor();
    await expectPhonePage(page);
    await screenshot(page, "14-inventering-2-en-i-taget");
    // Skriver ett antal (stämmer med appen) och går vidare; nästa hoppas över.
    // "Stämmer" fyller i det appen tror.
    const field = page.getByLabel(`Antal ${firstName}`);
    await page.getByRole("button", { name: "Stämmer", exact: true }).click();
    expect(await field.inputValue()).toBe(String(Math.max(0, firstLevel)));
    await page.getByText(`1 av ${target.titles} räknade`).waitFor();
    await screenshot(page, "14-inventering-3-en-i-taget-ifylld");
    await page.getByRole("button", { name: "Nästa" }).click();
    await page.getByText(`Produkt 2 av ${target.titles}`).waitFor();
    await page.getByRole("button", { name: "Hoppa över" }).click();
    await page.getByText(`Produkt 3 av ${target.titles}`).waitFor();

    // 3. Listan: stora fält, två titlar till. A: 162 → 0. B: 40 → 41.
    await page.getByRole("radio", { name: "Lista" }).click();
    const pool = [target.a, target.b, target.c].filter((t) => t.id !== first.id);
    const [x, y] = pool as [Title, Title];
    const xBefore = await level(target.hemma, x.id);
    const yBefore = await level(target.hemma, y.id);
    await listField(page, x.name).fill("0");
    await listField(page, y.name).fill(String(yBefore + 1));
    await page.getByText(`3 av ${target.titles} räknade`).waitFor();
    await listField(page, x.name).scrollIntoViewIfNeeded();
    await expectPhonePage(page);
    await screenshot(page, "14-inventering-4-lista");
    // Ingenting är sparat i databasen än, men utkastet ligger på telefonen.
    expect(await level(target.hemma, x.id)).toBe(xBefore);
    await until(async () => (await draftInStorage(page)) !== null, "utkastet är sparat lokalt");

    // 4. Appen stängs mitt i: fliken stängs och en ny öppnas. Utkastet finns kvar.
    // Medan appen är stängd kommer en leverans av den första produkten (+5 hemma).
    await page.close();
    await sql`
      insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${target.orgId}::uuid, ${target.hemma}::uuid, ${first.id}::uuid, 'receipt', 5,
              now(), 'E2E: leverans under inventeringen')`;
    const firstNow = await level(target.hemma, first.id);
    expect(firstNow).toBe(firstLevel + 5);
    const again = await reopen(context);
    await again.goto("/vart-lager/inventering");
    const resume = again.getByRole("button", { name: /^Hemma/ });
    await again.getByText("Fortsätt · 3 räknade").waitFor();
    expect(await resume.innerText()).toContain("Fortsätt · 3 räknade");
    await screenshot(again, "14-inventering-5-fortsatt-utkast");
    await resume.click();
    await again.getByRole("heading", { name: "Räkna hemma." }).waitFor();
    // Samma läge (listan) och samma antal som före.
    expect(await again.getByRole("radio", { name: "Lista" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(await listField(again, x.name).inputValue()).toBe("0");
    expect(await listField(again, y.name).inputValue()).toBe(String(yBefore + 1));
    expect(await listField(again, first.name).inputValue()).toBe(String(Math.max(0, firstLevel)));

    // 5. Skillnaderna. Lagret ändrades medan man räknade: raden pekas ut, och den räknas om.
    await again.getByRole("button", { name: "Visa skillnader (3 räknade)" }).click();
    await again.getByRole("heading", { name: "3 produkter ändras." }).waitFor();
    await again.getByText("Lagret ändrades medan du räknade.").waitFor();
    await again
      .getByText(
        new RegExp(
          `appen trodde ${numberPattern(firstLevel)} när du räknade\\. Nu tror den ${numberPattern(firstNow)}\\.`,
        ),
      )
      .waitFor();
    await expectPhonePage(again);
    await screenshot(again, "14-inventering-6a-lagret-andrades");
    await again.getByRole("button", { name: "Tillbaka och ändra" }).click();
    await listField(again, first.name).fill(String(firstNow));
    await again.getByRole("button", { name: "Visa skillnader (3 räknade)" }).click();
    await again.getByRole("heading", { name: "2 produkter ändras." }).waitFor();
    const diffs = again.getByRole("listitem");
    expect(
      await diffs.filter({ has: again.getByText(x.name, { exact: true }) }).innerText(),
    ).toMatch(new RegExp(`${numberPattern(xBefore)} → 0`));
    expect(
      await diffs.filter({ has: again.getByText(y.name, { exact: true }) }).innerText(),
    ).toMatch(new RegExp(`${numberPattern(yBefore)} → ${numberPattern(yBefore + 1)}`));
    await again
      .getByText(`1 stämmer · ${target.titles - 3} hoppades över och ändras inte`)
      .waitFor();
    await expectPhonePage(again);
    await screenshot(again, "14-inventering-6-skillnader");
    expect(await level(target.hemma, x.id)).toBe(xBefore);

    // 6. Spara: allt på en gång.
    const skipped = pool[2];
    const skippedBefore = skipped ? await level(target.hemma, skipped.id) : null;
    await again.getByRole("button", { name: "Spara inventeringen" }).click();
    await again.getByRole("heading", { name: "Inventeringen är sparad." }).waitFor();
    await again.getByText("3 produkter räknade hemma.").waitFor();
    await until(async () => (await level(target.hemma, x.id)) === 0, "antalet är sparat");
    expect(await level(target.hemma, y.id)).toBe(yBefore + 1);
    expect(await level(target.hemma, first.id)).toBe(firstNow);
    if (skipped) expect(await level(target.hemma, skipped.id)).toBe(skippedBefore);
    const [saved] = await sql<
      { line_count: number; changed_count: number; email: string; notes: string[] }[]
    >`
      select c.line_count, c.changed_count, u.email,
             (select array_agg(distinct e.note) from public.stock_events e
               where e.id in (select (l ->> 'eventId')::uuid from jsonb_array_elements(c.lines) l)
             ) as notes
      from public.stock_counts c join auth.users u on u.id = c.counted_by
      where c.organization_id = ${target.orgId}::uuid and c.location_id = ${target.hemma}::uuid
      order by c.counted_at desc limit 1`;
    expect(saved).toMatchObject({
      line_count: 3,
      changed_count: 2,
      email: e2e().users.owner,
      notes: ["Inventering, Hemma"],
    });
    // Utkastet är borta från telefonen.
    await until(async () => (await draftInStorage(again)) === null, "utkastet är borttaget");
    await expectPhonePage(again);
    await screenshot(again, "14-inventering-7-sparat");

    // 7. Lagret visar att det är inventerat i dag.
    await again.getByRole("button", { name: "Räkna ett lager till" }).click();
    await again.getByRole("heading", { name: "Vilket lager räknar du?" }).waitFor();
    await until(
      async () =>
        (await again.getByRole("button", { name: /^Hemma/ }).innerText()).includes(
          "Inventerat i dag",
        ),
      "Hemma visar Inventerat i dag",
    );
    await screenshot(again, "14-inventering-8-inventerat-i-dag");
  });

  it("delägaren (Enkel vy, engelska) räknar Kontoret under Stock", async () => {
    const { page, context } = await open("en-GB");
    await page.goto("/logga-in");
    await page.getByLabel("Email").fill(PARTNER);
    await page.getByLabel("Password").fill(PARTNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    // Bara exakt inventeringssidan är öppen i den enkla vyn, inget under den.
    expect(
      (await context.request.get("/vart-lager/inventering", { maxRedirects: 0 })).status(),
    ).toBe(200);
    expect(
      (await context.request.get("/vart-lager/inventering/x", { maxRedirects: 0 })).status(),
    ).not.toBe(200);
    expect((await context.request.get("/vart-lager", { maxRedirects: 0 })).status()).toBe(200);

    const nav = page.getByRole("navigation", { name: "Menu" });
    await nav.getByRole("link", { name: "Stock" }).click();
    await page.waitForURL((url) => url.pathname === "/vart-lager");
    const countLink = page.getByRole("link", { name: /^Count stock/ });
    await countLink.waitFor();
    await countLink.scrollIntoViewIfNeeded();
    // Rubrikens siffra räknar upp: vänta tills den står still före skärmbilden.
    const headline = page.getByRole("heading", { level: 1 });
    let last = "";
    await until(async () => {
      const now = await headline.innerText();
      const same = now === last;
      last = now;
      return same;
    }, "rubrikens siffra står still");
    await screenshot(page, "14-inventering-en-1-stock");
    await countLink.click();
    await page.waitForURL((url) => url.pathname === "/vart-lager/inventering");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");

    const noSwedish = async () => {
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(
        /Vårt lager|Inköp|Lager|Räkna|Inventer|Beställ|Sparat|Ändra|Saknar|Butik|Awish|Hoppa|Stämmer|Appen|Hemma\b/,
      );
      await expectPhonePage(page);
      await expectTapTargets(page, 'nav[aria-label="Menu"]');
    };

    await page.getByRole("heading", { name: "Which place are you counting?" }).waitFor();
    // Hemma heter Home och inventerades nyss av ägaren.
    const home = page.getByRole("button", { name: /^Home/ });
    await home.waitFor();
    expect(await home.innerText()).toContain("Counted today");
    expect(await page.getByRole("button", { name: /^Kontoret/ }).innerText()).toContain(
      "Not counted yet",
    );
    // Stock-fliken nedtill är markerad.
    expect(await nav.getByRole("link", { name: "Stock" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await noSwedish();
    await screenshot(page, "14-inventering-en-2-pick-place");

    await page.getByRole("button", { name: /^Kontoret/ }).click();
    await page.getByRole("heading", { name: "Count at Kontoret." }).waitFor();
    await page.getByText(`Product 1 of ${target.titles}`).waitFor();
    const firstName = (await page.locator("main h2").first().innerText()).trim();
    const [first] = await sql<Title[]>`
      select id, name from public.titles
      where organization_id = ${target.orgId}::uuid and name = ${firstName}`;
    const before = await level(target.kontoret, first!.id);
    await page.getByText(`The app thinks: ${before}`).waitFor();
    await page.getByLabel(`Count of ${firstName}`).fill(String(before + 7));
    await page.getByText(`1 of ${target.titles} counted`).waitFor();
    await noSwedish();
    await screenshot(page, "14-inventering-en-3-one-at-a-time");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText(`Product 2 of ${target.titles}`).waitFor();
    await page.getByRole("button", { name: "Skip" }).waitFor();

    await page.getByRole("radio", { name: "List" }).click();
    await page.getByRole("list", { name: "Count stock" }).waitFor();
    await noSwedish();
    await screenshot(page, "14-inventering-en-4-list");

    await page.getByRole("button", { name: "See the differences (1 counted)" }).click();
    await page.getByRole("heading", { name: "1 product will change." }).waitFor();
    await page.getByText(`${target.titles - 1} skipped, not changed`).waitFor();
    await noSwedish();
    await screenshot(page, "14-inventering-en-5-differences");
    await page.getByRole("button", { name: "Save the count" }).click();
    await page.getByRole("heading", { name: "The count is saved." }).waitFor();
    await page.getByText("1 product counted at Kontoret.").waitFor();
    await until(
      async () => (await level(target.kontoret, first!.id)) === before + 7,
      "delägarens inventering är sparad",
    );
    const [saved] = await sql<{ email: string; note: string }[]>`
      select u.email, e.note
      from public.stock_counts c
      join auth.users u on u.id = c.counted_by
      join public.stock_events e on e.id = (c.lines -> 0 ->> 'eventId')::uuid
      where c.organization_id = ${target.orgId}::uuid and c.location_id = ${target.kontoret}::uuid
      order by c.counted_at desc limit 1`;
    expect(saved).toEqual({ email: PARTNER, note: "Inventering, Kontoret" });
    await noSwedish();
    await screenshot(page, "14-inventering-en-6-saved");
    await page.getByRole("link", { name: "Back to stock" }).last().click();
    await page.waitForURL((url) => url.pathname === "/vart-lager");
  });

  it("Att göra: ett lager som inte inventerats på 30 dagar, och länken öppnar räkningen", async () => {
    const { page } = await open("sv-SE");
    await login(page, e2e().users.owner);
    await page.goto("/att-gora");
    // Mild påminnelse: punkten ligger under "Senare", som är hopfälld på mobilen.
    const item = page.getByText(/^Inventera Garaget\.?$/).first();
    await item.waitFor({ state: "attached" });
    expect(await item.isVisible()).toBe(false);
    await page.getByRole("button", { name: /^Visa · \d+$/ }).click();
    await item.waitFor();
    // Listans intoning ska vara klar före skärmbilden (pulserande prickar går för evigt).
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
    await item.scrollIntoViewIfNeeded();
    expect(
      await page.getByText(/Inte inventerat än\. Räkna packen så stämmer lagret\./).count(),
    ).toBe(1);
    // Hemma och Kontoret är nyss inventerade: ingen punkt för dem.
    expect(await page.getByText(/^Inventera Hemma\.?$/).count()).toBe(0);
    expect(await page.getByText(/^Inventera Kontoret\.?$/).count()).toBe(0);
    await screenshot(page, "14-inventering-9-att-gora");
    await page.getByRole("link", { name: "Inventera", exact: true }).first().click();
    await page.waitForURL(
      (url) =>
        url.pathname === "/vart-lager/inventering" &&
        url.searchParams.get("lager") === target.garaget,
    );
    await page.getByRole("heading", { name: "Räkna i Garaget." }).waitFor();
    await page.getByRole("button", { name: "Byt lager" }).waitFor();
    await expectPhonePage(page);
    await screenshot(page, "14-inventering-10-fran-att-gora");
  });
});
