/**
 * "Ny version av appen finns" på en iPhone SE (375 px) och en iPhone 15: påfyllaren har
 * appen öppen när en ny version driftsätts.
 *
 * En ny driftsättning låtsas med kakan binderlab-test-build (src/lib/build-id.ts): next dev
 * svarar då med det id:t från /api/version och i nya sidor. Kakan läses aldrig i drift.
 *
 * 1. Fyll på: rutan "Ny version av appen finns" visas överst (inom skärmen, 44 px knappar),
 *    service workern får veta det nya bygget och glömmer sidorna från det gamla. Uppdatera
 *    laddar om och rutan försvinner.
 * 2. Mitt i en påfyllning (ändrat antal): appen öppnas igen men laddar INTE om; rutan visas
 *    och skymmer inte Klar nedtill.
 * 3. Appen öppnas igen utan något ifyllt: den laddar om av sig själv till den nya versionen.
 * 4. Mer → Uppdatera appen laddar om även utan ny version.
 * 5. Fyll på fungerar sedan fortfarande utan nät (workern har sparat sidan igen).
 * 6. Nätet försvinner precis när workern hör om ett nytt bygge och Uppdatera trycks: de
 *    sparade sidorna finns kvar och Fyll på öppnas utan nät.
 */

import { afterEach, describe, expect, it } from "vitest";

import { TEST_BUILD_COOKIE } from "@/lib/build-id";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  screenshot,
  until,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { e2e, login } from "./support/session";

const DEVICES = ["iPhone SE (3rd gen)", "iPhone 15"] as const;

/**
 * Utan nät misslyckas det som går till nätet, och det är väntat: versionen, dev-serverns
 * filer och dev-serverns omladdningsuttag (HMR-websocketen, som försöker koppla upp igen).
 */
const OFFLINE_ERRORS =
  /Failed to load resource: net::ERR_(FAILED|INTERNET_DISCONNECTED)|WebSocket connection to '[^']*\/_next\/(webpack-)?hmr[^']*' failed: .*net::ERR_INTERNET_DISCONNECTED/;

let errors: Error[] = [];
afterEach(() => expectNoPageErrors(errors));

/** Låtsas att bygget `id` har driftsatts. */
async function deploy(context: BrowserContext, id: string): Promise<void> {
  await context.addCookies([{ name: TEST_BUILD_COOKIE, value: id, url: e2e().baseUrl }]);
}

/** Versionskontrollens resultat ("ok" eller "ny"), se src/components/pwa/app-update.tsx. */
async function versionState(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.appVersion).catch(() => undefined);
}

async function waitForState(page: Page, state: "ok" | "ny"): Promise<void> {
  await until(async () => (await versionState(page)) === state, `versionen ${state}`);
}

/** Bygget som service workern senast hörde att servern kör. */
async function workerBuild(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      const res = await (await caches.open("binderlab-meta")).match("/__build");
      return res ? res.text() : null;
    })
    .catch(() => null);
}

/** Har service workern sparat Fyll på (för läget utan nät)? */
async function savedFillPage(page: Page): Promise<boolean> {
  return page
    .evaluate(async () => {
      for (const key of await caches.keys()) {
        if (key.includes(":sidor:") && (await (await caches.open(key)).match("/fyll-pa"))) {
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

/** Markerar sidan; markeringen försvinner när sidan laddas om. */
async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __fore?: boolean }).__fore = true;
  });
}

async function reloaded(page: Page): Promise<boolean> {
  return page
    .evaluate(() => !(window as unknown as { __fore?: boolean }).__fore)
    .catch(() => false);
}

/** Appen kommer tillbaka: vanlig kontroll (persisted false) eller öppnad igen ur bfcache. */
async function pageshow(page: Page, persisted: boolean): Promise<void> {
  await page.evaluate(
    (p) => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: p })),
    persisted,
  );
}

describe.each(DEVICES)("Uppdatera appen på %s", (device) => {
  it("rutan, Uppdatera, skyddet för osparade antal, automatisk omladdning och Mer", async () => {
    const browser = await launchBrowser();
    const opened = await openPage(browser, e2e().baseUrl, { device, theme: "dark" });
    const { page, context } = opened;
    errors = opened.errors;
    const tag = device.startsWith("iPhone SE") ? "se" : "15";
    const run = `${Date.now().toString(36)}-${tag}`;
    try {
      await login(page, e2e().users.refiller);
      await page.goto("/fyll-pa");
      const cards = page.getByRole("list", { name: "Automater" }).getByRole("link");
      await cards.first().waitFor();
      await waitForState(page, "ok");
      const banner = page.getByRole("status", { name: "Ny version av appen" });
      expect(await banner.count()).toBe(0);

      // 1. En ny version driftsätts medan appen är öppen.
      const b = `e2e-b-${run}`;
      await deploy(context, b);
      await pageshow(page, false);
      await banner.waitFor();
      expect(await banner.innerText()).toContain("Ny version av appen finns");
      await waitForState(page, "ny");
      const width = await page.evaluate(() => window.innerWidth);
      const box = await banner.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      for (const name of ["Uppdatera", "Senare"]) {
        const b = await banner.getByRole("button", { name, exact: true }).boundingBox();
        expect(Math.round(b!.height), name).toBeGreaterThanOrEqual(44);
        expect(Math.round(b!.width), name).toBeGreaterThanOrEqual(44);
        expect(b!.x + b!.width, name).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      // Service workern vet nu att servern kör det nya bygget (och har glömt de gamla sidorna).
      await until(async () => (await workerBuild(page)) === b, "service workern får bygget");
      await screenshot(page, `12-uppdatera-ruta-${tag}`);

      await mark(page);
      await banner.getByRole("button", { name: "Uppdatera", exact: true }).click();
      await until(() => reloaded(page), "sidan laddas om efter Uppdatera");
      await cards.first().waitFor();
      await waitForState(page, "ok");
      expect(await banner.count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe("/fyll-pa");

      // 2. Mitt i en påfyllning: ändrat antal, appen öppnas igen. Ingen omladdning.
      await cards.first().click();
      await page.waitForURL((url) => /^\/fyll-pa\/[0-9a-f-]{36}$/.test(url.pathname));
      // Första knappen som går att trycka på: ett fack som redan står på 0 (t.ex. en titel
      // som en annan testfil lagt i automaten) har knappen avstängd.
      const fewer = page.locator('button[aria-label^="En mindre "]:not([disabled])').first();
      await fewer.waitFor();
      await fewer.click();
      const c = `e2e-c-${run}`;
      await deploy(context, c);
      await mark(page);
      await pageshow(page, true);
      await banner.waitFor();
      await waitForState(page, "ny");
      expect(await reloaded(page)).toBe(false);
      // Rutan ligger överst och skymmer inte Klar nedtill.
      const klar = await page.getByRole("button", { name: /^Klar/ }).last().boundingBox();
      const top = await banner.boundingBox();
      expect(top!.y + top!.height).toBeLessThanOrEqual(klar!.y);
      await screenshot(page, `12-uppdatera-fyll-pa-${tag}`);
      await banner.getByRole("button", { name: "Senare", exact: true }).click();
      await banner.waitFor({ state: "detached" });

      // 3. Utan något ifyllt: appen öppnas igen och laddar om själv till den nya versionen.
      await page.goto("/drift");
      await waitForState(page, "ok");
      const d = `e2e-d-${run}`;
      await deploy(context, d);
      await mark(page);
      await pageshow(page, true);
      await until(() => reloaded(page), "appen laddar om själv");
      await waitForState(page, "ok");
      expect(await banner.count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe("/drift");
      await until(async () => (await workerBuild(page)) === d, "service workern får bygget");

      // 4. Mer → Uppdatera appen, även utan ny version.
      await mark(page);
      await page.getByRole("navigation", { name: "Snabbmeny" }).getByRole("button").click();
      const sheet = page.getByRole("dialog", { name: "Mer" });
      await sheet.waitFor();
      const row = sheet.getByRole("button", { name: /Uppdatera appen/ });
      expect(await row.innerText()).toContain("Om något ser gammalt ut");
      expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
      await screenshot(page, `12-uppdatera-mer-${tag}`);
      await row.click();
      await until(() => reloaded(page), "sidan laddas om efter Uppdatera appen");
      await waitForState(page, "ok");
      expect(new URL(page.url()).pathname).toBe("/drift");
      expect(await banner.count()).toBe(0);

      // 5. Fyll på fungerar fortfarande utan nät: workern har sparat sidan igen.
      await until(() => savedFillPage(page), "Fyll på sparas igen");
      await context.setOffline(true);
      try {
        await page.goto("/fyll-pa");
        await cards.first().waitFor();
        expect(await banner.count()).toBe(0);
      } finally {
        await context.setOffline(false);
      }
      // Utan nät misslyckas anropen som går till nätet: väntat (OFFLINE_ERRORS).
      errors.splice(0, errors.length, ...errors.filter((e) => !OFFLINE_ERRORS.test(e.message)));
    } finally {
      await context.close();
      await browser.close();
    }
  });
});

describe("Uppdatera när nätet försvinner (iPhone SE)", () => {
  it("en ny version och Uppdatera utan nät glömmer inte de sparade sidorna", async () => {
    const browser = await launchBrowser();
    const opened = await openPage(browser, e2e().baseUrl, {
      device: "iPhone SE (3rd gen)",
      theme: "dark",
    });
    const { page, context } = opened;
    errors = opened.errors;
    try {
      await login(page, e2e().users.refiller);
      await page.goto("/fyll-pa");
      const cards = page.getByRole("list", { name: "Automater" }).getByRole("link");
      await cards.first().waitFor();
      await waitForState(page, "ok");
      await until(() => savedFillPage(page), "Fyll på sparas");

      // Nätet försvinner precis när workern får höra om ett nytt bygge och när någon trycker
      // Uppdatera (telefonen tror att den har nät, men inget svar kommer fram).
      await context.setOffline(true);
      const x = `e2e-x-${Date.now().toString(36)}`;
      await page.evaluate(async (build) => {
        const reg = await navigator.serviceWorker.ready;
        reg.active!.postMessage({ type: "build", build });
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve();
          reg.active!.postMessage({ type: "refresh-pages" }, [channel.port2]);
          setTimeout(resolve, 5000);
        });
      }, x);
      await until(async () => (await workerBuild(page)) === x, "service workern får bygget");
      // Workern hinner försöka hämta sidorna (utan nät).
      await new Promise((r) => setTimeout(r, 1500));
      expect(await savedFillPage(page)).toBe(true);
      await page.goto("/fyll-pa");
      await cards.first().waitFor();
      await context.setOffline(false);
      errors.splice(0, errors.length, ...errors.filter((e) => !OFFLINE_ERRORS.test(e.message)));
    } finally {
      await context.close();
      await browser.close();
    }
  });
});

describe("/api/version", () => {
  it("svarar utan inloggning, utan cache", async () => {
    const res = await fetch(new URL("/api/version", e2e().baseUrl), { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { buildId?: string };
    expect(body.buildId).toMatch(/^[A-Za-z0-9._-]{1,80}$/);
  });
});
