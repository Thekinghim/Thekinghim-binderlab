/**
 * Mobillayout: ägaren går igenom appens sidor på en iPhone SE (3:e generationen, 375 px)
 * och en iPhone 15 (393 px) och testet kontrollerar på varje sida att
 *
 * 1. sidan inte går att skrolla i sidled (dokumentet är inte bredare än skärmen),
 * 2. inget element i innehållet sticker ut ur sin förälder (utom i en behållare som
 *    skrollar eller klipper i sidled med flit, t.ex. en bred tabell i en skrollruta, och en
 *    sådan skrollruta som går kant till kant på skärmen),
 * 3. knappar, länkar, flikar, fält och fällbara rubriker i innehållet är minst 44 × 44 px
 *    att trycka på. En knapp får räkna sin osynliga träffyta (::before/::after, se
 *    Button). Undantag: länkar mitt i löptext (WCAG 2.5.8) och dolda element.
 *
 * Alla fel samlas och skrivs ut tillsammans (sida, enhet, element, mått), så att en körning
 * visar allt som behöver rättas. Detaljsidorna (en automat, en butik, ett ärende) hittas via
 * listsidornas första länk.
 *
 * E2E_MOBIL_EMAIL kör testet som en annan ägare med samma lösenord, t.ex. demons
 * demo@binderlab.local (docs/demo.md) för sidor med mer data.
 */

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
import { inspect } from "./support/layout";
import { e2e, login } from "./support/session";

const DEVICES = ["iPhone SE (3rd gen)", "iPhone 15"] as const;

/** Sidorna i appen (ägaren ser alla). Detaljsidor läggs till via DETAILS. */
const ROUTES = [
  "/",
  "/att-gora",
  "/lonsamhet",
  "/lonsamhet?visa=utveckling",
  "/lonsamhet?visa=rytm",
  "/order",
  "/lager",
  "/vart-lager",
  "/vart-lager/inventering",
  "/vart-lager/mystery",
  "/veckan",
  "/automater",
  "/automater/enhetsekonomi",
  "/butiker",
  "/inkopspriser",
  "/rapporter",
  "/rapporter?vy=arkiv",
  "/rapporter?vy=mottagare",
  "/prognos",
  "/expansion",
  "/expansion?vy=pipeline",
  "/expansion?vy=scenarier",
  "/expansion?vy=mal",
  "/drift",
  "/drift/besok",
  "/drift/pafyllning",
  "/drift/larm",
  "/inkorg",
  "/inkorg/nytt",
  "/ekonomi",
  "/ekonomi?vy=kassaflode",
  "/ekonomi?vy=fasta",
  "/ekonomi?vy=bokforing",
  "/avtal",
  "/avtal?vy=intakt",
  "/effekt",
  "/varde",
  "/kampanjer",
  "/marknad",
  "/assistent",
  "/datakallor",
  "/datakallor/fortnox",
  "/installningar",
  "/fyll-pa",
] as const;

/** Detaljsidor: första länken på listsidan som matchar mönstret. */
const DETAILS: { from: string; link: RegExp }[] = [
  { from: "/automater", link: /^\/automater\/(?!enhetsekonomi)[^/?#]+$/ },
  { from: "/butiker", link: /^\/butiker\/[0-9a-f-]{36}$/ },
  { from: "/inkorg", link: /^\/inkorg\/[0-9a-f-]{36}$/ },
  { from: "/drift", link: /^\/drift\/automat\/[^/?#]+$/ },
  { from: "/fyll-pa", link: /^\/fyll-pa\/[^/?#]+$/ },
];

let browser: Browser;

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
});

/**
 * Kör igen om servern inte svarar: dev-servern startar om sig själv när den har kompilerat
 * många sidor (Nexts minnesgräns), och är då borta några sekunder.
 */
async function retryWhileRestarting<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const restarting = /ERR_CONNECTION_(REFUSED|RESET)|ERR_EMPTY_RESPONSE/.test(String(error));
      if (!restarting || attempt >= 5) throw error;
      await until(
        () =>
          fetch(new URL("/logga-in", e2e().baseUrl))
            .then((r) => r.status === 200)
            .catch(() => false),
        "servern svarar igen",
      );
    }
  }
}

/** Laddar sidan och väntar tills innehållet har ritats (inga laddningsskelett kvar). */
async function visit(page: Page, path: string): Promise<void> {
  await retryWhileRestarting(() => page.goto(path, { waitUntil: "load" }));
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(
      () => !document.querySelector("[aria-busy='true'], [data-loading]"),
      undefined,
      {
        timeout: 20_000,
      },
    )
    .catch(() => {});
}

const DEV_HMR_ROUTER_ERROR =
  /^Internal Next\.js error: Router action dispatched before initialization\.$/;

describe.each(DEVICES)("Mobillayout på %s", (device) => {
  let context: BrowserContext;
  let page: Page;
  let errors: Error[];

  beforeAll(async () => {
    ({ page, context, errors } = await openPage(browser, e2e().baseUrl, { device }));
    await retryWhileRestarting(() => login(page, process.env.E2E_MOBIL_EMAIL ?? e2e().users.owner));
  });

  afterAll(async () => {
    await context?.close();
  });

  async function check(path: string): Promise<void> {
    await visit(page, path);
    const problems = await page.evaluate(inspect);
    const report = problems.map((p) => `${path} · ${p.kind}: ${p.what}`);
    // Dev-serverns HMR (hmrRefresh när webpack lägger till en dynamisk sida) kan hinna före
    // routerns start när testet går direkt till en detaljsida. Finns bara i next dev.
    errors.splice(0, errors.length, ...errors.filter((e) => !DEV_HMR_ROUTER_ERROR.test(e.message)));
    expectNoPageErrors(errors);
    expect(report, `${device} ${path}:\n${report.join("\n")}`).toEqual([]);
  }

  it.each(ROUTES)("%s", async (path) => {
    await check(path);
  });

  it.for(DETAILS)("detaljsida från $from", async ({ from, link }, ctx) => {
    await visit(page, from);
    const hrefs = await page.evaluate(() =>
      Array.from((document.querySelector("main") ?? document.body).querySelectorAll("a[href]")).map(
        (a) => new URL((a as HTMLAnchorElement).href).pathname,
      ),
    );
    const found = hrefs.find((h) => link.test(h));
    // Seeden saknar t.ex. kundärenden: då finns ingen detaljsida att öppna.
    if (!found) return ctx.skip(`ingen länk som matchar ${link} på ${from}`);
    await check(found);
  });
});
