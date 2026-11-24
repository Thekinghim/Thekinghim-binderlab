/**
 * Bottenraden på iPhone (hemskärmsappen): raden ska alltid ligga i skärmens nederkant, även
 * när WebKit lämnar kvar en för kort vy efter tangentbordet (då ritas `position: fixed`
 * mitt på skärmen). Chromium har inte felet, så testet låtsas vara hemskärmsapp
 * (display-mode: standalone) och krymper vyn som WebKit gör; ViewportPin
 * (src/components/v2/shell/viewport-pin-mount.tsx) ska då flytta ner raden.
 *
 * Kollar även att filterchipsen på Automater och Butiker syns hela (inte avklippta), att
 * sidorna inte går att skrolla i sidled och att tryck på aktiv flik går till toppen.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
  type Browser,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

let browser: Browser;
const errors: Error[][] = [];

beforeAll(async () => {
  browser = await launchBrowser();
});

afterEach(() => {
  for (const list of errors) expectNoPageErrors(list);
  errors.length = 0;
});

afterAll(async () => {
  await browser?.close();
});

/** Som hemskärmsappen på iPhone: matchMedia("(display-mode: standalone)") matchar. */
const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (/display-mode:\\s*standalone/.test(q)) {
      return {
        matches: true, media: q, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
        dispatchEvent() { return false; },
      };
    }
    return real(q);
  };
  try { Object.defineProperty(navigator, "standalone", { get: () => true }); } catch {}
})();`;

async function ownerOnIphone(): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, { device: "iPhone 15", theme: "light" });
  errors.push(opened.errors);
  await opened.context.addInitScript(STANDALONE);
  await login(opened.page, e2e().users.owner);
  return opened.page;
}

type Bar = { bottom: number; inner: number; shift: string; scrollW: number };

function bar(page: Page): Promise<Bar> {
  return page.evaluate((): Bar => {
    const el = document.querySelector(".v2-tabs");
    return {
      bottom: el ? Math.round(el.getBoundingClientRect().bottom) : -1,
      inner: window.innerHeight,
      shift: document.documentElement.style.getPropertyValue("--v2-vp-shift"),
      scrollW: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function barAtBottom(page: Page, bottom: number): Promise<Bar> {
  return until(
    async () => {
      const b = await bar(page);
      return Math.abs(b.bottom - bottom) <= 1 ? b : undefined;
    },
    `bottenraden ligger inte vid ${bottom}px`,
    10_000,
  );
}

/** Varje chip ligger helt inne i sin rad (raden klipper inte chipsens nederkant). */
async function chipsWhole(page: Page): Promise<string[]> {
  return page.evaluate((): string[] => {
    const bad: string[] = [];
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(".v2-chips"))) {
      if (row.offsetParent === null) continue;
      const r = row.getBoundingClientRect();
      for (const b of Array.from(row.querySelectorAll<HTMLElement>("button"))) {
        const c = b.getBoundingClientRect();
        if (c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5) {
          bad.push(`${b.textContent?.trim()}: ${c.top}-${c.bottom} i raden ${r.top}-${r.bottom}`);
        }
      }
    }
    return bad;
  });
}

describe("bottenraden på iPhone 15 (hemskärmsapp)", () => {
  it("ligger i nederkanten efter skroll, tangentbord och en fastnad vy", async () => {
    const page = await ownerOnIphone();
    await page.goto("/automater");
    await page.locator(".v2-tabs").waitFor();
    const { inner } = await bar(page);
    await barAtBottom(page, inner);

    // Skrolla ner: raden står kvar längst ner.
    await page.evaluate(() => window.scrollTo(0, 400));
    await barAtBottom(page, inner);

    // Skriv i sökfältet och lämna det.
    const search = page.locator(".v2-auto .v2-search input").first();
    await search.click();
    await search.fill("a");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await barAtBottom(page, inner);
    await search.fill("");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // WebKits fel: vyn fastnar 300 px för kort efter tangentbordet (även visualViewport).
    await page.setViewportSize({ width: 393, height: inner - 300 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new FocusEvent("focusout"));
    });
    const stuck = await barAtBottom(page, inner);
    expect(stuck.shift).toBe("300px");
    await screenshot(page, "34-bottenrad-fastnad-vy");

    // Vyn blir hel igen: flytten tas bort.
    await page.setViewportSize({ width: 393, height: inner });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    const healed = await barAtBottom(page, inner);
    expect(healed.shift).toBe("");
    expect(healed.scrollW).toBeLessThanOrEqual(0);
  });

  it("tryck på aktiv flik går till toppen", async () => {
    const page = await ownerOnIphone();
    await page.goto("/automater");
    await page.locator(".v2-tabs").waitFor();
    await page.evaluate(() => window.scrollTo(0, 600));
    await until(
      async () => (await page.evaluate(() => window.scrollY)) > 0,
      "sidan gick inte att skrolla",
    );
    await page.locator('.v2-tabs a[aria-current="page"]').click();
    await until(
      async () => (await page.evaluate(() => window.scrollY)) === 0,
      "aktiv flik skrollade inte till toppen",
      5_000,
    );
  });

  it.each(["/automater", "/butiker", "/", "/vart-lager", "/pengar"])(
    "%s: hela chips och ingen sidledsrullning",
    async (path) => {
      const page = await ownerOnIphone();
      await page.goto(path);
      await page.locator(".v2-tabs").waitFor();
      await page.locator("h1").first().waitFor();
      expect(await chipsWhole(page)).toEqual([]);
      const b = await bar(page);
      expect(b.scrollW).toBeLessThanOrEqual(0);
      expect(Math.abs(b.bottom - b.inner)).toBeLessThanOrEqual(1);
    },
  );
});
