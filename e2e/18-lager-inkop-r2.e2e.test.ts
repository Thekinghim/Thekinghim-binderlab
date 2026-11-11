/**
 * Runda 2, spår T3 (Lager och inköp), iPhone SE 375 px. Ägaren på svenska och delägaren i
 * den enkla vyn på engelska:
 *
 * - Inköpslistan: delägaren trycker "Ordered" (antalet förifyllt), raden blir "On the way:
 *   56 packs, expected …". Ägaren ser samma rad på Inköp ("På väg: 56 st, väntas …") och
 *   trycker "Kom fram": 30 av 56 med nytt pris. 30 pack läggs i lagret, priset sparas från
 *   i dag och appen säger "Du planerade 56, fick 30. Vi ber dig köpa 26 till."
 * - Prisvakt: Enter på en titel som har pris sparar "från i dag" och det gamla priset är
 *   orört; ett pris långt från det förra ger en fråga och ett extra tryck.
 * - Leverans med pris: delägarens leveransformulär och ägarens "+ Inköp" visar raden om
 *   nytt pris innan man sparar.
 * - Delarna som mystery packs äter upp: titeln är en del i ett mystery pack som säljer, och
 *   köpraden säger hur många av packen som går dit, på engelska och svenska.
 *
 * Förberedelse (E2E_DATABASE_URL): en egen titel per körning med försäljning i en automat
 * (så att inköpslistan ber om den), inköpspris 112,50 kr sedan 1 jan. och ingen leverantör;
 * ett eget mystery pack per körning (10 per omgång, bara den titeln) som säljer 1 om dagen;
 * en delägare (ägarroll) med Enkel vy och engelska.
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

const DEVICE_375 = "iPhone SE (3rd gen)";
const PARTNER = "delagare-r2t3@binderlab.local";
const PARTNER_PASSWORD = "r2t3-e2e-losenord";

let browser: Browser;
let sql: postgres.Sql;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];
let orgId: string;
let titleId: string;
let title: string;
let mystery: string;
let central: string;

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

async function newPage(locale: string): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, {
    device: DEVICE_375,
    theme: "dark",
    locale,
  });
  contexts.push(opened.context);
  errors.push(opened.errors);
  return opened.page;
}

async function ownerPage(path: string): Promise<Page> {
  const page = await newPage("sv-SE");
  await login(page, e2e().users.owner);
  await page.goto(path);
  return page;
}

async function partnerPage(path: string): Promise<Page> {
  const page = await newPage("en-GB");
  await page.goto("/logga-in");
  await page.getByLabel("Email").fill(PARTNER);
  await page.getByLabel("Password").fill(PARTNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto(path);
  return page;
}

const level = async () =>
  (
    await sql<{ q: number }[]>`
      select quantity::int as q from public.stock_levels
      where location_id = ${central}::uuid and title_id = ${titleId}::uuid`
  )[0]?.q ?? 0;

const prices = () => sql<{ ore: number; day: string }[]>`
  select unit_cost_ore::int as ore, valid_from::text as day from public.purchase_prices
  where organization_id = ${orgId}::uuid and title_id = ${titleId}::uuid order by valid_from`;

async function settled(page: Page): Promise<void> {
  // Bara arkets egna, ändliga animationer: sidan bakom kan ha en som aldrig tar slut.
  await until(
    () =>
      page.evaluate(() =>
        document.getAnimations().every((a) => {
          if (a.playState !== "running" || a.effect === null) return true;
          const timing = a.effect.getComputedTiming();
          if (timing.iterations === Infinity) return true;
          const target = (a.effect as KeyframeEffect).target;
          const open = document.querySelector("dialog[open]");
          return open !== null && target !== null && !open.contains(target);
        }),
      ),
    "animationerna är klara",
  );
}

/**
 * Ingen sidledes scroll och tryckytor på minst 44 px inom `scope`. Mäts som e2e/11: dolda
 * element räknas inte, och en yta som förstoras med ::before/::after mäts med den.
 */
async function expectPhoneFit(page: Page, scope: string): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= Math.min(window.innerWidth, window.screen.width),
    ),
  ).toBe(true);
  const small = await page.evaluate((sel: string) => {
    const hidden = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return true;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.opacity === "0") return true;
      if (st.clipPath === "inset(50%)" || (st.position === "absolute" && r.width <= 1)) return true;
      return el.closest("[aria-hidden='true'], [inert]") !== null;
    };
    const pseudo = (el: Element, which: "::before" | "::after", base: DOMRect) => {
      const st = getComputedStyle(el, which);
      if (st.content === "none" || st.content === "normal" || st.position !== "absolute") {
        return null;
      }
      const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : NaN);
      const [t, b, l, r] = [px(st.top), px(st.bottom), px(st.left), px(st.right)];
      const h = Number.isFinite(t) && Number.isFinite(b) ? base.height - t - b : px(st.height);
      const w = Number.isFinite(l) && Number.isFinite(r) ? base.width - l - r : px(st.width);
      return { w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 };
    };
    return Array.from(document.querySelectorAll(sel)).flatMap((root) =>
      Array.from(root.querySelectorAll("a[href], button, input, select, [role=radio]"))
        .filter((el) => !hidden(el))
        .map((el) => {
          const r = el.getBoundingClientRect();
          let w = r.width;
          let h = r.height;
          for (const which of ["::before", "::after"] as const) {
            const box = pseudo(el, which, r);
            if (box) {
              w = Math.max(w, box.w);
              h = Math.max(h, box.h);
            }
          }
          const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
          return { label, w: Math.round(w), h: Math.round(h) };
        })
        .filter((x) => x.h < 44 || x.w < 44),
    );
  }, scope);
  expect(small, JSON.stringify(small)).toEqual([]);
}

const SWEDISH = /Vårt lager|Inköp|Beställt|På väg|Kom fram|Räkna|Sparat|Leverantör|Awish|VMB/;

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  orgId = e2e().organizationId;
  title = `R2T3 Pack ${e2e().runId}`.slice(0, 60);

  const hash = await hashPassword(PARTNER_PASSWORD);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${PARTNER}, ${hash}, ${sql.json({ full_name: "Delägare R2T3" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  await sql`
    insert into public.memberships (organization_id, user_id, role, view_mode)
    values (${orgId}::uuid, ${user!.id}::uuid, 'owner', 'simple')
    on conflict (organization_id, user_id) do update set view_mode = 'simple'`;
  await sql`
    insert into public.profiles (organization_id, user_id, display_name, locale)
    values (${orgId}::uuid, ${user!.id}::uuid, 'Delägare R2T3', 'en')
    on conflict (organization_id, user_id) do update set locale = 'en'`;

  const [machine] = await sql<{ id: string }[]>`
    select m.id from public.machines m
    join public.machine_placements p on p.organization_id = m.organization_id
      and p.machine_id = m.id and p.valid_from <= current_date - 30
      and (p.valid_to is null or p.valid_to >= current_date)
    where m.organization_id = ${orgId}::uuid and m.archived_at is null
    order by m.code limit 1`;
  if (!machine) throw new Error("Seeden saknar en automat med placering.");
  const [source] = await sql<{ id: string }[]>`
    select id from public.data_sources where organization_id = ${orgId}::uuid
    order by created_at limit 1`;
  const [c] = await sql<{ id: string }[]>`
    select id from public.stock_locations
    where organization_id = ${orgId}::uuid and is_central and archived_at is null`;
  central = c!.id;
  const [t] = await sql<{ id: string }[]>`
    insert into public.titles (organization_id, name) values (${orgId}::uuid, ${title})
    returning id`;
  titleId = t!.id;
  await sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    values (${orgId}::uuid, ${titleId}::uuid, 11250, '2026-01-01')`;
  // Fyra pack om dagen i 30 dagar t.o.m. i går, 149 kr styck.
  await sql`
    insert into public.orders
      (organization_id, data_source_id, external_id, raw_title, title_id, machine_id,
       ordered_at, amount_ore, source_hash)
    select ${orgId}::uuid, ${source!.id}::uuid, ${"r2t3-" + e2e().runId + "-"} || d || '-' || k,
           ${title}, ${titleId}::uuid, ${machine.id}::uuid,
           now() - make_interval(days => d) + make_interval(mins => k), 14900,
           ${"r2t3-" + e2e().runId + "-"} || d || '-' || k
    from generate_series(1, 30) d, generate_series(1, 4) k`;
  // Ett mystery pack som säljer 1 om dagen och bara innehåller titeln (10 per omgång).
  mystery = `R2T3 Mystery ${e2e().runId}`.slice(0, 60);
  const [m] = await sql<{ id: string }[]>`
    insert into public.titles (organization_id, name, own_product)
    values (${orgId}::uuid, ${mystery}, true) returning id`;
  await asOwner(
    (tx) => tx`select public.save_mystery_recipe(${orgId}::uuid, ${m!.id}::uuid, 10,
      ${tx.json([{ titleId, quantity: 10, hit: false }])})`,
  );
  await sql`
    insert into public.orders
      (organization_id, data_source_id, external_id, raw_title, title_id, machine_id,
       ordered_at, amount_ore, source_hash)
    select ${orgId}::uuid, ${source!.id}::uuid, ${"r2t3m-" + e2e().runId + "-"} || d,
           ${mystery}, ${m!.id}::uuid, ${machine.id}::uuid,
           now() - make_interval(days => d), 19900, ${"r2t3m-" + e2e().runId + "-"} || d
    from generate_series(1, 30) d`;
  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
});

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  await sql?.end();
});

describe("Runda 2, T3: lager och inköp (iPhone SE 375 px)", () => {
  it("delägaren trycker Ordered på inköpslistan: raden blir On the way", async () => {
    const page = await partnerPage("/prognos");
    const item = page
      .getByRole("list", { name: "Buy list" })
      .getByRole("listitem")
      .filter({ hasText: title });
    await item.waitFor();
    expect(await item.innerText()).toMatch(/Buy \d+\spacks/);
    // Titeln är en del i ett mystery pack: raden säger hur många av packen som går dit.
    expect(await item.innerText()).toContain(`of them go into ${mystery}.`);
    await expectPhoneFit(page, "main");
    expect(await page.locator("main").innerText()).not.toMatch(SWEDISH);
    await item.scrollIntoViewIfNeeded();
    await screenshot(page, "18-t3-buy-list-iphonese");

    await item.getByRole("button", { name: `Ordered, ${title}` }).click();
    const sheet = page.getByRole("dialog");
    const qty = sheet.getByLabel("Number of packs");
    await qty.waitFor();
    // Antalet är förifyllt med listans antal.
    expect(Number(await qty.inputValue())).toBeGreaterThan(56);
    await sheet.getByText("Comes in about 7 days. The list stops asking for them.").waitFor();
    await qty.fill("56");
    await settled(page);
    await expectPhoneFit(page, "dialog[open]");
    await screenshot(page, "18-t3-ordered-sheet-iphonese");
    await sheet.getByRole("button", { name: "Save as ordered" }).click();
    await page.getByText(`Ordered: 56 packs ${title}.`).first().waitFor();
    await page.getByText(/^On the way: 56\spacks, expected /).waitFor();
    await until(async () => {
      const [r] = await sql<{ n: number }[]>`
        select l.quantity::int as n from public.purchase_order_lines l
        join public.purchase_orders po on po.id = l.purchase_order_id and po.status = 'ordered'
        join public.suppliers s on s.id = po.supplier_id and s.name = 'Eget inköp'
        where l.organization_id = ${orgId}::uuid and l.title_id = ${titleId}::uuid`;
      return r?.n === 56;
    }, "beställningen finns hos Eget inköp");
    await expectPhoneFit(page, "main");
    expect(await page.locator("main").innerText()).not.toMatch(SWEDISH);
    await screenshot(page, "18-t3-on-the-way-iphonese");
  });

  it("ägaren ser På väg och trycker Kom fram: 30 av 56 med nytt pris", async () => {
    const page = await ownerPage("/prognos");
    const way = page.getByRole("listitem").filter({ hasText: /^.*På väg: 56\sst, väntas / });
    await way.filter({ hasText: title }).waitFor();
    // Köpraden säger hur många av packen som går till mystery packet.
    await page
      .getByRole("listitem")
      .filter({ hasText: `Köp ca` })
      .filter({ hasText: title })
      .getByText(new RegExp(`^(\\d+ av dem|Alla) går till ${mystery}\\.$`))
      .scrollIntoViewIfNeeded();
    await screenshot(page, "18-t3-inkop-kop-rad-iphonese");
    await expectPhoneFit(page, "main");
    await screenshot(page, "18-t3-inkop-pa-vag-iphonese");
    await page.getByRole("button", { name: `Kom fram, ${title}` }).click();
    const sheet = page.getByRole("dialog");
    const qty = sheet.getByLabel("Antal pack");
    await qty.waitFor();
    expect(await qty.inputValue()).toBe("56");
    const price = sheet.getByLabel("Pris per pack");
    expect(await price.inputValue()).toBe("112,50");
    await qty.fill("30");
    await price.fill("118");
    // Raden innan man sparar.
    await sheet.getByText(/^Nytt pris 118\skr \(var 112,50\skr\)\./).waitFor();
    // Och vad som blir kvar per pack med det nya priset (149 kr − 118 kr).
    await sheet.getByText(/Kvar per pack blir 31\skr\./).waitFor();
    await settled(page);
    await expectPhoneFit(page, "dialog[open]");
    await screenshot(page, "18-t3-kom-fram-ark-iphonese");
    await sheet.getByRole("button", { name: "Lägg in i lagret" }).click();
    await page
      .getByText("Du planerade 56, fick 30. Vi ber dig köpa 26 till.", { exact: false })
      .first()
      .waitFor();
    await until(async () => (await level()) === 30, "30 pack i lagret");
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(
      new Date(),
    );
    expect(await prices()).toEqual([
      { ore: 11250, day: "2026-01-01" },
      { ore: 11800, day: today },
    ]);
    // Ordern är avslutad och raden På väg är borta; listan ber om titeln igen.
    await until(async () => {
      const [r] = await sql<{ status: string }[]>`
        select po.status::text as status from public.purchase_orders po
        join public.purchase_order_lines l on l.purchase_order_id = po.id
        where l.title_id = ${titleId}::uuid`;
      return r?.status === "received";
    }, "ordern är avslutad");
    await page.reload();
    await page.getByRole("button", { name: `Beställt, ${title}` }).waitFor();
    expect(await page.getByText(/På väg: 56/).count()).toBe(0);
    await expectPhoneFit(page, "main");
    await screenshot(page, "18-t3-inkop-efter-iphonese");
  });

  it("prisvakt: Enter sparar från i dag, och ett konstigt pris ger en fråga", async () => {
    const page = await partnerPage("/inkopspriser");
    await page.getByRole("button", { name: `Change the purchase price of ${title}` }).click();
    const sheet = page.getByRole("dialog");
    const field = sheet.getByLabel("New price per pack");
    await field.waitFor();
    // Huvudknappen är "New price from today"; att rätta gammalt är det lilla valet.
    await sheet.getByRole("button", { name: /^New price from today/ }).waitFor();
    await sheet.getByRole("button", { name: /^Fix the old price/ }).waitFor();
    await settled(page);
    await expectPhoneFit(page, "dialog[open]");
    await screenshot(page, "18-t3-price-sheet-iphonese");
    await field.fill("1190");
    await field.press("Enter");
    await sheet
      .getByText(/1,190\skr is much more than the last price 118\skr\. Is that right\?/)
      .waitFor();
    await settled(page);
    await expectPhoneFit(page, "dialog[open]");
    await screenshot(page, "18-t3-price-doubt-iphonese");
    // Inget är sparat än.
    expect((await prices()).at(-1)?.ore).toBe(11800);
    await sheet.getByRole("button", { name: "Change the price" }).click();
    await field.fill("119");
    await field.press("Enter");
    await page.getByText("New purchase price saved").first().waitFor();
    await until(async () => (await prices()).at(-1)?.ore === 11900, "priset från i dag är sparat");
    // Gammal försäljning behåller sitt pris: raden från 1 jan. är orörd.
    expect((await prices())[0]).toEqual({ ore: 11250, day: "2026-01-01" });
    expect(await prices()).toHaveLength(2);
  });

  it("delägarens leverans frågar vad packen kostade (engelska)", async () => {
    const page = await partnerPage("/vart-lager");
    await page.getByRole("button", { name: `Change the stock of ${title}` }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Number of packs").fill("5");
    const price = sheet.getByLabel("Price per pack");
    expect(await price.inputValue()).toBe("119");
    await price.fill("121");
    await sheet.getByText(/^New price 121\skr \(was 119\skr\)\./).waitFor();
    await settled(page);
    await expectPhoneFit(page, "dialog[open]");
    expect(await sheet.innerText()).not.toMatch(SWEDISH);
    await screenshot(page, "18-t3-delivery-price-iphonese");
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await page
      .getByText(/^5\spacks added at /)
      .first()
      .waitFor();
    await page
      .getByText(/New price 121\skr from today\./)
      .first()
      .waitFor();
    await until(async () => (await level()) === 35, "leveransen är i lagret");
    expect((await prices()).at(-1)?.ore).toBe(12100);
  });

  it("ägarens + Inköp på Vårt lager: pris med fråga vid konstigt pris", async () => {
    const page = await ownerPage("/vart-lager");
    const row = page.locator(`#rad-${titleId}:visible`);
    await row.waitFor();
    await screenshot(page, "18-t3-vart-lager-iphonese");
    // Mobil: ett tryck på titeln visar knapparna.
    await row.getByRole("button", { name: `Fler uppgifter, ${title}` }).click();
    await row.getByRole("button", { name: `Inköp, ${title}` }).click();
    await row.getByLabel(`Antal köpta pack, ${title}`).fill("2");
    const price = row.getByLabel(`Pris per pack, ${title}`);
    expect(await price.inputValue()).toBe("121");
    await price.fill("12");
    await row.getByRole("button", { name: `Lägg till inköp, ${title}` }).click();
    await row.getByText(/är mycket mindre än förra priset 121\skr\. Stämmer det\?/).waitFor();
    expect(await level()).toBe(35);
    await expectPhoneFit(page, `#rad-${titleId}`);
    await screenshot(page, "18-t3-inkop-fraga-iphonese");
    // Rätta priset i fältet: frågan försvinner och raden om nytt pris visas.
    await price.fill("122");
    await row.getByText(/^Nytt pris 122\skr \(var 121\skr\)\./).waitFor();
    await screenshot(page, "18-t3-inkop-nytt-pris-iphonese");
    await row.getByRole("button", { name: `Lägg till inköp, ${title}` }).click();
    await page
      .getByText(/Nytt pris 122\skr från i dag\./)
      .first()
      .waitFor();
    await until(async () => (await level()) === 37, "inköpet är i lagret");
    expect((await prices()).at(-1)?.ore).toBe(12200);
  });
});
