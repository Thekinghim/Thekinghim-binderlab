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

interface Problem {
  readonly kind: "sidled" | "utanför" | "liten";
  readonly what: string;
}

/** Körs i sidan: allt som är fel med layouten på den här skärmen. */
function inspect(): Problem[] {
  const MIN = 44;
  const problems: Problem[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth) {
    problems.push({
      kind: "sidled",
      what: `sidan är ${doc.scrollWidth} px bred på en ${window.innerWidth} px skärm`,
    });
  }
  const main = document.querySelector("main") ?? document.body;

  function describeEl(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const label =
      el.getAttribute("aria-label") ??
      (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
    return `${tag}${cls ? `.${cls}` : ""} "${label}"`;
  }

  function hidden(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") return true;
    // Skärmläsartext (sr-only) klipps till 1 px.
    if (s.clipPath === "inset(50%)" || (s.position === "absolute" && r.width <= 1)) return true;
    return el.closest("[aria-hidden='true'], [inert]") !== null;
  }

  // 2. Element som sticker ut ur sin förälder.
  const scrolls = (s: CSSStyleDeclaration) =>
    s.overflowX === "auto" ||
    s.overflowX === "scroll" ||
    s.overflowX === "hidden" ||
    s.overflowX === "clip";
  for (const el of Array.from(main.querySelectorAll("*"))) {
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const parent = el.parentElement;
    if (!parent || hidden(el)) continue;
    const s = getComputedStyle(el);
    if (s.position === "absolute" || s.position === "fixed") continue;
    const ps = getComputedStyle(parent);
    if (scrolls(ps) || ps.display === "contents") continue;
    // Tabellceller mäts mot sin tabell (raden kan vara smalare i vissa motorer).
    if (s.display.startsWith("table") && s.display !== "table") continue;
    const r = el.getBoundingClientRect();
    // En skrollruta som går ut i sidans marginal (kant till kant på mobilen) är med flit, så
    // länge den håller sig på skärmen.
    if (scrolls(s) && r.left >= -0.5 && r.right <= window.innerWidth + 0.5) continue;
    const p = parent.getBoundingClientRect();
    const over = Math.max(r.right - p.right, p.left - r.left);
    if (over > 1.5) {
      problems.push({
        kind: "utanför",
        what: `${describeEl(el)} sticker ut ${Math.round(over)} px ur ${describeEl(parent)}`,
      });
    }
  }

  // 3. Små tryckytor.
  const targets = main.querySelectorAll<HTMLElement>(
    "a[href], button, summary, select, textarea, input:not([type='hidden']), [role='button'], [role='tab'], [role='radio'], [role='switch'], [role='checkbox']",
  );
  const seen = new Set<Element>();

  function pseudoBox(el: Element, which: "::before" | "::after", base: DOMRect) {
    const s = getComputedStyle(el, which);
    if (s.content === "none" || s.content === "normal" || s.position !== "absolute") return null;
    const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : NaN);
    const [t, b, l, rr] = [px(s.top), px(s.bottom), px(s.left), px(s.right)];
    const h = Number.isFinite(t) && Number.isFinite(b) ? base.height - t - b : px(s.height);
    const w = Number.isFinite(l) && Number.isFinite(rr) ? base.width - l - rr : px(s.width);
    return { w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 };
  }

  function inlineInText(el: HTMLElement): boolean {
    if (el.tagName !== "A") return false;
    if (getComputedStyle(el).display !== "inline") return false;
    const parent = el.parentElement;
    if (!parent) return false;
    // Löptext: föräldern har egen text utöver länken.
    return Array.from(parent.childNodes).some(
      (n) => n !== el && n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 1,
    );
  }

  for (const raw of Array.from(targets)) {
    let el: HTMLElement = raw;
    // En kryssruta eller radioknapp trycks via sin etikett.
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      const label =
        el.closest("label") ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      if (label instanceof HTMLElement) el = label;
    }
    // Ett element inne i en annan tryckyta (t.ex. en etikett runt en kryssruta) mäts en gång.
    if (seen.has(el)) continue;
    seen.add(el);
    if (hidden(el) || inlineInText(el)) continue;
    if (el instanceof HTMLButtonElement && el.closest("a[href]")) continue;
    if (el.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    let w = r.width;
    let h = r.height;
    for (const which of ["::before", "::after"] as const) {
      const box = pseudoBox(el, which, r);
      if (box) {
        w = Math.max(w, box.w);
        h = Math.max(h, box.h);
      }
    }
    if (w + 0.5 < MIN || h + 0.5 < MIN) {
      problems.push({
        kind: "liten",
        what: `${describeEl(el)} är ${Math.round(w)} × ${Math.round(h)} px`,
      });
    }
  }
  return problems;
}

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
