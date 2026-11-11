/**
 * Enkla vyn hämtar siffrorna på nytt av sig själv (iPhone SE, 375 px): delägaren har appen
 * på hemskärmen och tar fram den efter en stund. Samma regler som i hela appen
 * (use-auto-refresh): mer än en minut i bakgrunden ger en ny hämtning när appen kommer
 * tillbaka, och aldrig medan ett ark (menyn) är öppet.
 *
 * Klockan flyttas i sidan (Date.now) i stället för att vänta, och hämtningarna räknas på
 * sidans fetch med RSC-huvudet (det router.refresh skickar).
 *
 * Förberedelse i databasen (E2E_DATABASE_URL): fixturens delägare får Enkel vy under
 * testet och sätts tillbaka efteråt.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  until,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const DEVICE = "iPhone SE (3rd gen)";

let browser: Browser;
let context: BrowserContext;
let sql: postgres.Sql;

async function setView(mode: "simple" | "full"): Promise<void> {
  await sql`
    update public.memberships m set view_mode = ${mode}
    from auth.users u
    where u.id = m.user_id and u.email = ${e2e().users.partner}
      and m.organization_id = ${e2e().organizationId}::uuid`;
}

/** Räknar sidans hämtningar av serverdata (router.refresh) från och med nu. */
async function countRefetches(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __refetch?: number; __fetch?: typeof fetch };
    w.__refetch = 0;
    if (w.__fetch) return;
    w.__fetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (headers.has("rsc") && method.toUpperCase() === "GET")
        w.__refetch = (w.__refetch ?? 0) + 1;
      return w.__fetch!(input, init);
    };
  });
}

const refetches = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __refetch?: number }).__refetch ?? 0);

/** Flyttar sidans klocka framåt och låter appen "komma tillbaka" (fokus). */
async function comeBackAfter(page: Page, minutes: number): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as unknown as { __skew?: number; __now?: () => number };
    if (!w.__now) {
      w.__now = Date.now.bind(Date);
      Date.now = () => w.__now!() + (w.__skew ?? 0);
    }
    w.__skew = (w.__skew ?? 0) + ms;
    window.dispatchEvent(new Event("focus"));
  }, minutes * 60_000);
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  await setView("simple");
  browser = await launchBrowser();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await setView("full");
  await sql.end();
});

describe("Enkla vyn uppdaterar sig själv", () => {
  it("hämtar om när appen kommer tillbaka, inte medan menyn är öppen", async () => {
    const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark" });
    context = opened.context;
    const { page, errors } = opened;
    await login(page, e2e().users.partner);
    // Delägaren landar på Försäljning i enkla vyn (fyra stora flikar nedtill, ingen sidomeny).
    await page.getByRole("button", { name: "Mer", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    await countRefetches(page);

    // Strax tillbaka (under en minut): ingen ny hämtning.
    await comeBackAfter(page, 0.5);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await refetches(page)).toBe(0);

    // Tillbaka efter 10 minuter: siffrorna hämtas om utan ett tryck.
    await comeBackAfter(page, 10);
    await until(async () => (await refetches(page)) === 1, "en ny hämtning efter 10 minuter");

    // Menyn (ett ark) är öppen: ingen hämtning, så att arket inte störs.
    await page.getByRole("button", { name: "Mer", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await comeBackAfter(page, 10);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await refetches(page)).toBe(1);

    // Arket stängt: nästa gång appen kommer fram hämtas siffrorna.
    await page.getByRole("button", { name: "Stäng" }).first().click();
    await page
      .locator("dialog[open]")
      .waitFor({ state: "detached" })
      .catch(() => {});
    await until(async () => (await page.locator("dialog[open]").count()) === 0, "arket är stängt");
    await comeBackAfter(page, 2);
    await until(async () => (await refetches(page)) === 2, "en ny hämtning när arket är stängt");

    const width = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(width).toBeLessThanOrEqual(0);
    expectNoPageErrors(errors);
  });
});
