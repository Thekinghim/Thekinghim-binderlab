/**
 * Butiksägare: skapa en ägare, koppla butiker och filtrera statistiken på ägaren, på dator
 * (1 280 px) och iPhone (375 px).
 *
 * En egen organisation med tre påhittade butiker (Butik Alfa, Butik Beta, Butik Gamma), en
 * automat i var och en med order de senaste 20 dagarna (Alfa 3 per dag, Beta 2, Gamma 1,
 * 79 kr styck) och 20 % provision.
 *
 * 1. Butiker → Butiksägare: "Ny butiksägare". Fel kontrollsiffra ger felet i dialogen;
 *    rättat nummer och förslaget på momsreg.nr sparas normaliserat.
 * 2. Butik Alfa och Beta får ägaren på butikens sida (Kontakt och rapport → Ägare). Gamma
 *    får en egen ägare med "Ny ägare …". Butikens huvud visar namn och org.nr.
 * 3. Filtret Butik har ägaren först ("Godisbolaget Väst AB (2 butiker)"); valet ger
 *    ?agare= och Hem visar Alfa + Beta (sålt för exakt summan av deras order).
 * 4. Samma vyer på 375 px utan sidledes scroll.
 *
 * Skärmbilderna hamnar i E2E_SCREENSHOT_DIR.
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

const OWNER_NAME = "Godisbolaget Väst AB";
const OWN_COMPANY = "Gamma Handel AB";

let browser: Browser;
let sql: postgres.Sql;
let owner = "";
let orgId = "";
const storeIds = new Map<string, string>();
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];

const text = (s: string) => s.replace(/[  ⁠]/g, " ");

async function signedIn(viewport: "desktop" | "mobile"): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, { viewport, theme: "dark" });
  contexts.push(opened.context);
  errors.push(opened.errors);
  await login(opened.page, owner);
  return opened.page;
}

async function expectNoSideScroll(page: Page): Promise<void> {
  const wide = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > Math.min(window.innerWidth, window.screen.width) ? doc.scrollWidth : 0;
  });
  expect(wide, `sidan är ${wide} px bred`).toBe(0);
}

async function ownerId(name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from public.store_owners where organization_id = ${orgId}::uuid and legal_name = ${name}`;
  return row!.id;
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const runId = e2e().runId;
  const id = runId.toLowerCase();
  owner = `butiksagare-${id}@binderlab.local`;
  const hash = await hashPassword(e2e().password);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${owner}, ${hash}, ${sql.json({ full_name: "E2E Butiksägare" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: user!.id,
      email: owner,
      role: "authenticated",
    })}, true), set_config('role', 'authenticated', true)`;
    const [org] = await tx<{ id: string }[]>`
      select public.create_organization(${`E2E Butiksägare ${runId}`}, ${`e2e-agare-${id}`}) as id`;
    orgId = org!.id;
    const [title] = await tx<{ id: string }[]>`
      insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Pokémon 151')
      returning id`;
    await tx`
      insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
      values (${orgId}::uuid, ${title!.id}::uuid, 4500, current_date - 200)`;
    const [source] = await tx<{ id: string }[]>`
      insert into public.data_sources (organization_id, provider, name)
      values (${orgId}::uuid, 'awish_csv', 'E2E Butiksägare') returning id`;
    const specs: Array<[string, string, number]> = [
      ["Butik Alfa", "BL-001", 3],
      ["Butik Beta", "BL-002", 2],
      ["Butik Gamma", "BL-003", 1],
    ];
    for (const [name, code, perDay] of specs) {
      const [store] = await tx<{ id: string }[]>`
        insert into public.stores (organization_id, name) values (${orgId}::uuid, ${name})
        returning id`;
      storeIds.set(name, store!.id);
      await tx`
        insert into public.store_agreements (organization_id, store_id, valid_from, commission_bp)
        values (${orgId}::uuid, ${store!.id}::uuid, current_date - 200, 2000)`;
      const [machine] = await tx<{ id: string }[]>`
        insert into public.machines (organization_id, code, name, active_from)
        values (${orgId}::uuid, ${code}, ${name}, current_date - 60) returning id`;
      await tx`
        insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
        values (${orgId}::uuid, ${machine!.id}::uuid, ${store!.id}::uuid, current_date - 60)`;
      await tx`
        insert into public.orders (organization_id, data_source_id, machine_id, payment_method,
                                   external_id, raw_title, title_id, ordered_at, amount_ore, source_hash)
        select ${orgId}::uuid, ${source!.id}::uuid, ${machine!.id}::uuid, 'card',
               ${code} || '-' || ago || '-' || k, 'Pokémon 151', ${title!.id}::uuid,
               ((current_date - ago) + time '09:00' + k * interval '20 minutes')
                 at time zone 'Europe/Stockholm',
               7900, md5(${id} || ${code} || ago || '-' || k)
        from generate_series(1, 20) as ago, generate_series(1, ${perDay}::int) as k`;
    }
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

describe("Butiksägare (dator)", () => {
  it("Ny butiksägare: kontrollsiffran prövas, uppgifterna sparas normaliserade", async () => {
    const page = await signedIn("desktop");
    await page.goto("/butiker?vy=agare");
    await page.getByText("Inga butiksägare än.").waitFor();
    await page.getByRole("button", { name: "Ny butiksägare", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bolagets namn").fill(OWNER_NAME);
    await dialog.getByLabel("Organisationsnummer").fill("5599001237");
    await dialog.getByRole("button", { name: "Lägg till", exact: true }).click();
    await dialog.getByText("Organisationsnumret stämmer inte. Kontrollera siffrorna.").waitFor();

    await dialog.getByLabel("Organisationsnummer").fill("5599001236");
    // Förslaget på momsreg.nr ur numret, bara när man trycker på det.
    await dialog.getByRole("button", { name: "Använd SE559900123601", exact: true }).click();
    expect(await dialog.getByLabel("Momsreg.nr (valfritt)").inputValue()).toBe("SE559900123601");
    await dialog.getByLabel("Godkänd för F-skatt").check();
    await dialog.getByLabel("Postnummer").fill("44130");
    await dialog.getByLabel("Ort").fill("Testby");
    await dialog.getByLabel("Fakturor till (e-post)").fill("faktura@example.se");
    await dialog.getByRole("button", { name: "Lägg till", exact: true }).click();
    await page.getByText(`${OWNER_NAME} är tillagd`).waitFor();

    const card = page.locator(`[data-owner="${OWNER_NAME}"]`);
    await card.waitFor();
    const cardText = text(await card.innerText());
    expect(cardText).toContain("559900-1236 · 0 butiker");
    expect(cardText).toContain("SE559900123601");
    expect(cardText).toContain("441 30 Testby");
    expect(cardText).toContain("faktura@example.se");
    const [row] = await sql<{ org_number: string; f_tax: boolean; postal_code: string }[]>`
      select org_number, f_tax, postal_code from public.store_owners
      where organization_id = ${orgId}::uuid and legal_name = ${OWNER_NAME}`;
    expect(row).toEqual({ org_number: "559900-1236", f_tax: true, postal_code: "441 30" });
  });

  it("butikerna får ägaren på sin sida, och en butik får en egen ny ägare", async () => {
    const page = await signedIn("desktop");
    for (const name of ["Butik Alfa", "Butik Beta"]) {
      await page.goto(`/butiker/${storeIds.get(name)!}?vy=kontakt`);
      const select = page.getByLabel("Ägare", { exact: true });
      await select.selectOption({ label: `${OWNER_NAME} (559900-1236)` });
      await page.getByRole("button", { name: "Spara ägare", exact: true }).click();
      await page.getByText(`${name} har ägaren ${OWNER_NAME}`).waitFor();
      await page.locator("[data-store-owner]").getByText(OWNER_NAME).waitFor();
    }
    expect(text(await page.locator("[data-store-owner]").innerText())).toBe(
      `${OWNER_NAME} 559900-1236`,
    );
    await page.locator("#agare").scrollIntoViewIfNeeded();
    await screenshot(page, "agare-02-butik-med-agare-1280");

    // Gamma: "Ny ägare …" skapar ägaren och kopplar butiken i ett steg.
    await page.goto(`/butiker/${storeIds.get("Butik Gamma")!}?vy=kontakt`);
    await page.getByLabel("Ägare", { exact: true }).selectOption({ label: "Ny ägare …" });
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bolagets namn").fill(OWN_COMPANY);
    await dialog.getByLabel("Organisationsnummer").fill("802400-0013");
    await dialog.getByRole("button", { name: "Lägg till", exact: true }).click();
    await page.getByText(`${OWN_COMPANY} är tillagd`).waitFor();
    await page.locator("[data-store-owner]").getByText(OWN_COMPANY).waitFor();

    const linked = await sql<{ name: string; legal_name: string }[]>`
      select s.name, o.legal_name from public.stores s
      join public.store_owners o on o.id = s.owner_id
      where s.organization_id = ${orgId}::uuid order by s.name`;
    expect(linked).toEqual([
      { name: "Butik Alfa", legal_name: OWNER_NAME },
      { name: "Butik Beta", legal_name: OWNER_NAME },
      { name: "Butik Gamma", legal_name: OWN_COMPANY },
    ]);

    await page.goto("/butiker?vy=agare");
    await page.getByText("2 butiksägare.").waitFor();
    const card = page.locator(`[data-owner="${OWNER_NAME}"]`);
    expect(text(await card.innerText())).toContain("559900-1236 · 2 butiker");
    await screenshot(page, "agare-01-butiksagare-1280");

    // Butikens huvud: ägarens namn och org.nr.
    await page.goto(`/butiker/${storeIds.get("Butik Alfa")!}`);
    await page.locator("[data-store-owner]").getByText(OWNER_NAME).waitFor();
    await screenshot(page, "agare-02-butik-huvud-1280");
  });

  it("filtret har ägaren med flera butiker; Hem visar ägarens butiker tillsammans", async () => {
    const page = await signedIn("desktop");
    // V2: Hem har ingen filterrad; filtret står kvar på de äldre sidorna (Lönsamhet) och
    // följer med i adressen (?agare=), som Hem läser.
    await page.goto("/lonsamhet?period=30d");
    // Filtret Butik i kontextraden (den synliga; mobilens ligger i en egen ruta).
    const select = page
      .locator('select:has(option:text-is("Alla butiker")) >> visible=true')
      .first();
    // Bara ägaren med två butiker står i filtret (Gamma Handel har en butik).
    const labels = (await select.locator("option").allInnerTexts()).map(text);
    expect(labels).toContain(`${OWNER_NAME} (2 butiker)`);
    expect(labels.some((l) => l.startsWith(OWN_COMPANY))).toBe(false);
    await select.selectOption({ label: `${OWNER_NAME} (2 butiker)` });
    const id = await ownerId(OWNER_NAME);
    await page.waitForURL((url) => url.searchParams.get("agare") === id);
    await page.goto(`/?period=30d&agare=${id}`);

    // Försäljningen i perioden: Alfa 3 + Beta 2 order per dag i 20 dagar à 79 kr.
    const [facit] = await sql<{ ore: string }[]>`
      select coalesce(sum(o.amount_ore), 0)::bigint as ore from public.orders o
      join public.machine_placements p on p.machine_id = o.machine_id
      where o.organization_id = ${orgId}::uuid and p.store_id = any(${[
        storeIds.get("Butik Alfa")!,
        storeIds.get("Butik Beta")!,
      ]}::uuid[])`;
    expect(Number(facit!.ore)).toBe(5 * 20 * 7900);
    // Hem räknar bara ägarens två butiker: intäkten i nyckeltalen är facit (7 900 kr).
    const band = page.getByRole("group", { name: "Nyckeltal för perioden" });
    await band.waitFor();
    // Talen räknar upp: vänta tills animationen är klar.
    await new Promise((r) => setTimeout(r, 1500));
    expect(text(await band.innerText())).toMatch(/Intäkt\s*7\s900\s*kr/);
    await screenshot(page, "agare-03-hem-agare-1280");
  });
});

describe("Butiksägare (375 px)", () => {
  it("listan, butikens ägare och Hem med ägarfiltret får plats", async () => {
    const page = await signedIn("mobile");
    await page.goto("/butiker?vy=agare");
    await page.locator(`[data-owner="${OWNER_NAME}"]`).waitFor();
    await expectNoSideScroll(page);
    await screenshot(page, "agare-01-butiksagare-375");

    await page.goto(`/butiker/${storeIds.get("Butik Alfa")!}?vy=kontakt`);
    await page.locator("[data-store-owner] >> visible=true").first().waitFor();
    await page.locator("#agare").scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await screenshot(page, "agare-02-butik-med-agare-375");

    await page.goto(`/?period=30d&agare=${await ownerId(OWNER_NAME)}`);
    await page.getByRole("group", { name: "Nyckeltal för perioden" }).waitFor();
    await expectNoSideScroll(page);
    await new Promise((r) => setTimeout(r, 1500));
    await screenshot(page, "agare-03-hem-agare-375");
  });
});
