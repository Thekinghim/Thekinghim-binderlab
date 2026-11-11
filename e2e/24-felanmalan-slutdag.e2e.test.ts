/**
 * Runda 2, spår T4, på en iPhone SE (375 px), som ägaren:
 *
 * 1. Butikens felanmälan: ärendet i Inkorgen (dit notisen leder) har en knapp som ringer
 *    butiken (tel:-länk, minst 44 px hög, ingen skroll i sidled). Utan nummer står det hur
 *    man lägger in det.
 * 2. Att göra: påfyllningspunkterna säger en dag ("Tar slut … – fyll på …"), aldrig den gamla
 *    texten "Väntas ta slut".
 *
 * Själva notisen (vem som får den och vad den säger) testas mot databasen i
 * test/db/felanmalan-push.test.ts och test/db/slut-direkt.test.ts.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const DEVICE = "iPhone SE (3rd gen)";
const PHONE = "040-12 34 56";

let browser: Browser;
let sql: postgres.Sql;
let context: BrowserContext;
let page: Page;
let errors: Error[];
let incidentId: string;
let store: { id: string; name: string; phone: string | null };

async function noSidewaysScroll(p: Page): Promise<void> {
  expect(
    await p.evaluate(
      () =>
        document.documentElement.scrollWidth <= Math.min(window.innerWidth, window.screen.width),
    ),
  ).toBe(true);
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const orgId = e2e().organizationId;
  // En automat som står i en butik i dag, och butikens nummer.
  const [placed] = await sql<
    { machine_id: string; store_id: string; name: string; phone: string | null }[]
  >`
    select p.machine_id, st.id as store_id, st.name, st.phone
    from public.machine_placements p
    join public.stores st on st.organization_id = p.organization_id and st.id = p.store_id
    join public.machines m on m.organization_id = p.organization_id and m.id = p.machine_id
    where p.organization_id = ${orgId}::uuid and p.valid_from <= current_date
      and (p.valid_to is null or p.valid_to >= current_date) and m.archived_at is null
    order by m.code limit 1`;
  if (!placed) throw new Error("Seeden har ingen automat i en butik.");
  store = { id: placed.store_id, name: placed.name, phone: placed.phone };
  await sql`update public.stores set phone = ${PHONE} where id = ${store.id}::uuid`;
  // Felanmälan som portalen skapar den (portal_report_fault): kind store_*, nu.
  const [incident] = await sql<{ id: string }[]>`
    insert into public.incidents (organization_id, machine_id, kind, started_at, description)
    values (${orgId}::uuid, ${placed.machine_id}::uuid, 'store_payment', now(),
            'E2E: kortläsaren svarar inte')
    returning id`;
  incidentId = incident!.id;

  browser = await launchBrowser();
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark" });
  ({ page, context, errors } = opened);
  await login(page, e2e().users.owner);
}, 180_000);

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close();
  if (store) {
    await sql`update public.stores set phone = ${store.phone} where id = ${store.id}::uuid`;
  }
  // Ärendet löses, så att det inte ligger kvar som öppet för andra tester.
  if (incidentId) {
    await sql`update public.incidents
              set status = 'resolved', ended_at = now(), action_taken = 'E2E: städat'
              where id = ${incidentId}::uuid`.catch(() => {});
  }
  await sql?.end();
});

describe("runda 2, T4: felanmälan och slutdag i telefonen", () => {
  it("ärendet från butiken har en knapp som ringer butiken", async () => {
    await page.goto(`/inkorg/${incidentId}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    // Butikens namn kan ha parenteser ("… (exempel)"): matcha som text, inte som mönster.
    const call = page.getByRole("link", { name: `Ring ${store.name}` });
    await call.waitFor();
    expect(await call.getAttribute("href")).toBe("tel:040123456");
    expect(await call.textContent()).toContain(PHONE);
    const box = await call.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await page.getByText("Butiken ser i sin portal när ärendet är Pågår eller Löst.").waitFor();
    await noSidewaysScroll(page);
    await screenshot(page, "r2-t4-inkorg-ring-butiken");
  });

  it("utan telefonnummer: texten säger var numret läggs in", async () => {
    await sql`update public.stores set phone = null where id = ${store.id}::uuid`;
    await page.goto(`/inkorg/${incidentId}`);
    await page.getByText(`${store.name} har inget telefonnummer.`).waitFor();
    const add = page.getByRole("link", { name: "Lägg in numret under Butiker" });
    expect(await add.getAttribute("href")).toBe(`/butiker/${store.id}`);
    expect(await page.getByRole("link", { name: /^Ring / }).count()).toBe(0);
    await noSidewaysScroll(page);
    await screenshot(page, "r2-t4-inkorg-utan-nummer");
    await sql`update public.stores set phone = ${PHONE} where id = ${store.id}::uuid`;
  });

  it("Att göra säger en dag, inte 'Väntas ta slut'", async () => {
    await page.goto("/att-gora");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const text = (await page.locator("main").textContent()) ?? "";
    expect(text).not.toContain("Väntas ta slut");
    await noSidewaysScroll(page);
    await screenshot(page, "r2-t4-att-gora");
  });

  it("inga fel i sidorna", () => {
    expectNoPageErrors(errors);
  });
});
