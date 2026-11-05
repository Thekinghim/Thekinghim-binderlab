/**
 * Abonnemang: Binderlab (plattformsoperatören) sätter en kunds plan på /plattform på datorn,
 * öppnar fakturaunderlaget och laddar ner CSV:n. Kunden ser sin plan och sitt underlag under
 * Inställningar på en iPhone 15, och får 404 på /plattform. Databasen kontrolleras direkt.
 *
 * Förberedelse (E2E_DATABASE_URL, som databasägare): seedens organisation (Binderlab) görs
 * till plattformsoperatör, och kunden "E2E Kund AB" (ägare kund-e2e@binderlab.local med
 * körningens lösenord och två automater) skapas om den saknas. Kundens planer från en
 * tidigare körning tas bort, så att testet går att köra flera gånger.
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

const CUSTOMER_EMAIL = "kund-e2e@binderlab.local";
const CUSTOMER_SLUG = "e2e-kund-abonnemang";
const CUSTOMER_NAME = "E2E Kund AB";

let browser: Browser;
let sql: postgres.Sql;
let customerOrg = "";

async function planPrice(): Promise<number | null> {
  const [r] = await sql<{ p: string }[]>`
    select price_per_machine_ore::text as p from private.subscription_plans
    where organization_id = ${customerOrg}::uuid and valid_to is null`;
  return r ? Number(r.p) : null;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  await sql`
    insert into private.platform_operators (organization_id, note)
    values (${e2e().organizationId}::uuid, 'E2E')
    on conflict (organization_id) do nothing`;
  const hash = await hashPassword(e2e().password);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${CUSTOMER_EMAIL}, ${hash}, ${sql.json({ full_name: "Kund E2E" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  const [existing] = await sql<{ id: string }[]>`
    select id from public.organizations where slug = ${CUSTOMER_SLUG}`;
  if (existing) {
    customerOrg = existing.id;
  } else {
    const [org] = await sql<{ id: string }[]>`
      insert into public.organizations (name, slug, created_by)
      values (${CUSTOMER_NAME}, ${CUSTOMER_SLUG}, ${user!.id}) returning id`;
    customerOrg = org!.id;
    await sql`
      insert into public.machines (organization_id, code, name, active_from)
      values (${customerOrg}::uuid, 'K-1', 'Kundautomat 1', '2026-01-01'),
             (${customerOrg}::uuid, 'K-2', 'Kundautomat 2', '2026-01-01')`;
  }
  await sql`
    insert into public.memberships (organization_id, user_id, role)
    values (${customerOrg}::uuid, ${user!.id}, 'owner')
    on conflict (organization_id, user_id) do nothing`;
  await sql`delete from private.subscription_plans where organization_id = ${customerOrg}::uuid`;
  await sql`delete from private.subscription_customers where organization_id = ${customerOrg}::uuid`;
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await sql?.end();
});

describe("Plattformen på datorn (Binderlabs ägare)", () => {
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

  it("Inställningar länkar till Plattform", async () => {
    await page.goto("/installningar");
    await page.getByText("Ni driver plattformen.").waitFor();
    await page.getByRole("link", { name: "Öppna Plattform →" }).click();
    await page.waitForURL((url) => url.pathname === "/plattform");
    await page.getByRole("heading", { level: 1, name: /MRR/ }).waitFor();
  });

  it("sätter kundens plan: 499 kr per automat", async () => {
    const row = page.locator(`li[data-kund="${CUSTOMER_SLUG}"]`);
    await row.getByText("Ingen plan", { exact: true }).first().waitFor();
    await row.getByText("Mer och ändra plan").click();
    const form = row.getByRole("form", { name: `Plan för ${CUSTOMER_NAME}` });
    await form.getByLabel("Pris per automat och månad").fill("499");
    await form.getByLabel("Gäller från").fill("2026-10-01");
    await screenshot(page, "09-plan-desktop");
    await form.getByRole("button", { name: "Spara plan" }).click();
    await until(async () => (await planPrice()) === 49_900, "planen finns i databasen");
    await row.getByText(/MRR/).first().waitFor();
    await until(
      async () => (await row.innerText()).includes("998"),
      "MRR 998 kr (2 automater × 499 kr) visas",
    );
    await screenshot(page, "09-plattform-desktop");
  });

  it("fakturaunderlaget och CSV:n", async () => {
    await page.goto(`/plattform/underlag?manad=2026-10&kund=${customerOrg}`);
    const sheet = page.getByRole("article", { name: `Underlag ${CUSTOMER_NAME}` });
    await sheet.waitFor();
    // Oktober: 2 automater hela månaden = 998 kr exkl. moms, 249,50 moms, 1 247,50 att betala.
    const text = (await sheet.innerText()).replace(/\s/g, " ");
    expect(text).toContain("998,00 kr");
    expect(text).toContain("249,50 kr");
    expect(text).toContain("1 247,50 kr");
    await screenshot(page, "09-underlag-desktop");
    const res = await context.request.get(
      `/plattform/underlag/csv?manad=2026-10&kund=${customerOrg}`,
    );
    expect(res.status()).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("Att fakturera");
    expect(csv).toContain(
      `${CUSTOMER_NAME};${CUSTOMER_SLUG};SE;;Svensk moms 25 %;SEK;2;62;31;998,00;25;249,50;1247,50`,
    );
  });
});

describe("Kunden på iPhone 15", () => {
  let context: BrowserContext;
  let page: Page;
  let errors: Error[];

  beforeAll(async () => {
    ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { device: "iPhone 15" }));
    await login(page, CUSTOMER_EMAIL);
  });
  afterAll(async () => {
    await context?.close();
  });
  afterEach(() => expectNoPageErrors(errors));

  it("ser sin plan och sitt underlag under Inställningar", async () => {
    await page.goto("/installningar");
    await page.getByText("Abonnemang: 499 kr per automat och månad.").waitFor();
    await page.getByRole("button", { name: /Visa underlag/ }).click();
    await page.getByText("oktober 2026").first().waitFor();
    await noHorizontalScroll(page);
    await screenshot(page, "09-installningar-iphone");
  });

  it("får 404 på /plattform och CSV:n", async () => {
    const res = (await page.goto("/plattform")) as { status(): number } | null;
    expect(res?.status()).toBe(404);
    const csv = await context.request.get("/plattform/underlag/csv?manad=2026-10");
    expect(csv.status()).toBe(404);
  });
});

describe("Plattformen på iPhone 15 (Binderlabs ägare)", () => {
  let context: BrowserContext;
  let page: Page;
  let errors: Error[];

  beforeAll(async () => {
    ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { device: "iPhone 15" }));
    await login(page, e2e().users.owner);
  });
  afterAll(async () => {
    await context?.close();
  });
  afterEach(() => expectNoPageErrors(errors));

  it("kunder och underlag utan sidledsrullning", async () => {
    await page.goto("/plattform");
    await page.locator(`li[data-kund="${CUSTOMER_SLUG}"]`).waitFor();
    await noHorizontalScroll(page);
    await screenshot(page, "09-plattform-iphone");
    await page.goto(`/plattform/underlag?manad=2026-10&kund=${customerOrg}`);
    await page.getByRole("article", { name: `Underlag ${CUSTOMER_NAME}` }).waitFor();
    await noHorizontalScroll(page);
    await screenshot(page, "09-underlag-iphone");
  });
});
