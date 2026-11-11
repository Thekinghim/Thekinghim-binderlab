/**
 * Automat-ranking och Bästa sortiment på iPhone SE (3:e generationen, 375 px).
 *
 * Flottan (tio automater, e2e/support/ranking-fixture.ts):
 * - Hem har en rad om vem som tjänar mest och vem som går dåligt, som leder till Automater.
 * - Automater rangordnar alla tio efter vinst per dag, med "Bäst", "Tjänar bra", "Går dåligt:
 *   överväg att flytta" och "För ny". "Visa butikernas andel" sänker vinsten per dag.
 * - Automaten som går dåligt: Bästa sortiment föreslår "Byt ut White Flair … Prova 30th
 *   Celebration …". Med 7 dagar sägs att det är för lite data.
 * En ensam automat: jämförs med sin förra period, Hem har ingen rad, och det som står still
 * visas utan något att prova i stället.
 *
 * På varje skärm: ingen sidledes scroll och tryckytor på minst 44 px i de nya avsnitten.
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
import { prepareRankingFixture, type RankingFixture } from "./support/ranking-fixture";
import { e2e, login } from "./support/session";

const DEVICE = "iPhone SE (3rd gen)";

let browser: Browser;
let sql: postgres.Sql;
let fx: RankingFixture;
const contexts: BrowserContext[] = [];
const errors: Error[][] = [];

const text = (s: string) => s.replace(/[ ⁠]/g, " ");

async function signedIn(email: string): Promise<Page> {
  const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark" });
  contexts.push(opened.context);
  errors.push(opened.errors);
  await login(opened.page, email);
  return opened.page;
}

async function sectionText(page: Page, selector: string): Promise<string> {
  // Den synliga: medan sidan strömmas in kan avsnittet ligga dolt i väntan på sin plats
  // (en kallstartad dev-server), och då finns det en kort stund två gånger.
  const shown = page.locator(`${selector} >> visible=true`);
  await shown.first().waitFor();
  // Vänta tills den dolda kopian är borta, så att `${selector} ol > li` räknar en lista.
  await expect.poll(() => page.locator(selector).count(), { timeout: 15_000 }).toBe(1);
  return text(await shown.innerText());
}

/** Ingen sidledes scroll, inget som sticker ut ur avsnittet, och tryckytor på minst 44 px. */
async function expectFits(page: Page, selector: string): Promise<void> {
  const problems = await page.evaluate((sel: string) => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > Math.min(window.innerWidth, window.screen.width))
      out.push(`sidan är ${doc.scrollWidth} px bred`);
    const root = document.querySelector(sel);
    if (!root) return [`${sel} saknas`];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (
        r.width > 0 &&
        (r.right > Math.min(window.innerWidth, window.screen.width) + 1 || r.left < -1)
      ) {
        out.push(`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 30)}" utanför skärmen`);
      }
    }
    for (const el of Array.from(root.querySelectorAll("a[href], button"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.height < 44 || r.width < 44)) {
        out.push(
          `liten tryckyta ${Math.round(r.width)}×${Math.round(r.height)}: "${(el.textContent ?? "").trim().slice(0, 30)}"`,
        );
      }
    }
    return out;
  }, selector);
  expect(problems, problems.join("\n")).toEqual([]);
}

/** Avsnittet överst på skärmen och animationerna klara, före en skärmbild. */
async function shot(page: Page, selector: string, name: string): Promise<void> {
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
  }, selector);
  await until(
    () =>
      // Oändliga animationer (statuspricken som pulserar) räknas inte.
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
  await screenshot(page, name);
}

/** Första talet i en text som "412 kr/dag". */
function kronor(s: string): number {
  const m = /(-?−?[\d ]+) kr\/dag/.exec(text(s));
  if (!m) throw new Error(`Inget belopp i "${s}"`);
  return Number(m[1]!.replace(/ /g, "").replace("−", "-"));
}

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  fx = await prepareRankingFixture(sql, e2e().runId, e2e().password);
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

describe("Automat-ranking med tio automater (iPhone SE)", () => {
  it("Hem: en rad om bäst och sämst som leder till rangordningen", async () => {
    const page = await signedIn(fx.fleetOwner);
    await page.goto("/");
    const line = await sectionText(page, "[data-home-ranking]");
    expect(line).toMatch(
      /^BL-001 tjänar mest: [\d ]+ kr\/dag\. BL-009 tjänar dåligt: överväg att flytta den\./,
    );
    await expectFits(page, "[data-home-ranking]");
    await shot(page, "[data-home-ranking]", "rank-01-hem-rad");
    await page.locator("[data-home-ranking]").click();
    await page.waitForURL((url) => url.pathname === "/automater" && url.hash === "#rangordning");
    await page.locator('[data-ranking="fleet"]').waitFor();
  });

  it("Automater: tio automater rangordnade med omdöme, och vyknappen drar butikernas andel", async () => {
    const page = await signedIn(fx.fleetOwner);
    await page.goto("/automater");
    const section = '[data-ranking="fleet"]';
    const body = await sectionText(page, section);
    expect(body).toMatch(/RANGORDNING · VINST PER DAG · 29 D/i);
    expect(body).toMatch(/BL-001 tjänar mest: [\d ]+ kr\/dag\./);
    expect(body).toContain("BL-009 tjänar dåligt: överväg att flytta den.");
    expect(body).toContain("Vinst före butikernas andel.");

    const rows = page.locator(`${section} ol > li`);
    expect(await rows.count()).toBe(10);
    const first = text(await rows.nth(0).innerText());
    expect(first).toMatch(/BL-001 ICA Maxi Barkarby/);
    expect(first).toMatch(/Bäst/i);
    expect(first).toMatch(/Säljer [\d ]+ kr\/dag · 14,0 pack\/dag/);
    expect(first).toMatch(/29 dagar · [\d ]+ kr\/dag mer än en vanlig automat/);
    expect(text(await rows.nth(1).innerText())).toMatch(/Tjänar bra/i);
    const weak = page.locator(`${section} a[data-verdict="weak"]`);
    expect(await weak.count()).toBe(1);
    expect(text(await weak.innerText())).toMatch(/BL-009[\s\S]*Tjänar dåligt: överväg att flytta/i);
    expect(text(await page.locator(`${section} a[data-verdict="new"]`).innerText())).toMatch(
      /BL-010[\s\S]*För ny: 6 dagar/i,
    );
    expect(await page.locator(`${section} a[data-verdict="good"]`).count()).toBe(7);
    await expectFits(page, section);
    await shot(page, section, "rank-02-automater-rangordning");
    await shot(page, `${section} a[data-verdict="weak"]`, "rank-03-automater-gar-daligt");

    // Vinsten är före butikernas andel; med vyknappen dras den (20 % provision).
    const before = kronor(await rows.nth(0).innerText());
    await page.getByRole("button", { name: "Visa butikernas andel" }).first().click();
    await until(
      async () => (await sectionText(page, section)).includes("Vinst efter butikernas andel."),
      "vinsten efter butikernas andel",
    );
    const after = kronor(await page.locator(`${section} ol > li`).nth(0).innerText());
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    await shot(page, section, "rank-04-automater-efter-andel");
    await page.getByRole("button", { name: "Visa butikernas andel" }).first().click();
    await until(
      async () => (await sectionText(page, section)).includes("Vinst före butikernas andel."),
      "vinsten före butikernas andel igen",
    );
  });

  it("Automaten som går dåligt: Bästa sortiment föreslår ett byte", async () => {
    const page = await signedIn(fx.fleetOwner);
    await page.goto("/automater");
    await page.locator('[data-ranking="fleet"] a[data-verdict="weak"]').click();
    await page.waitForURL((url) => url.pathname === "/automater/bl-009");
    const section = "[data-assortment]";
    const body = await sectionText(page, section);
    expect(body).toMatch(/BÄSTA SORTIMENT · 29 D/i);
    expect(body).toContain("säljer bäst här.");
    expect(body).toContain(
      "Byt ut White Flair: säljer 0,1/dag. Prova 30th Celebration: säljer 3,6/dag i 8 andra automater.",
    );
    expect(body).toMatch(/Står still/i);
    expect(body).toMatch(
      /Pokémon 151[\s\S]*1\/dag[\s\S]*Vinst [\d ]+ kr\/dag[\s\S]*29 dagar i lager · 29 pack/,
    );
    expect(body).toContain("Vinst före butikernas andel.");
    expect(await page.locator(`${section} [data-assortment-suggestions] li`).count()).toBe(1);
    await expectFits(page, section);
    await shot(page, section, "rank-05-basta-sortiment-forslag");

    // För kort period: sägs rakt ut, inga förslag.
    await page.goto("/automater/bl-009?period=7d");
    const short = await sectionText(page, section);
    expect(short).toContain("För lite data: 6 dagar.");
    expect(short).toContain("Välj minst 14 dagar för att få förslag.");
    expect(short).not.toContain("Byt ut");
    await expectFits(page, section);
    await shot(page, section, "rank-06-basta-sortiment-for-lite-data");
  });
});

describe("Talen stämmer med resten av appen", () => {
  it("vinst per dag är räknad för hand och samma som Enhetsekonomi och Lönsamhet", async () => {
    const page = await signedIn(fx.fleetOwner);
    await page.goto("/automater");
    const section = '[data-ranking="fleet"]';
    // Blocket strömmas in: medan det byts in finns det två i DOM:en (ett dolt). sectionText
    // väntar på det synliga och på att det dolda är borta.
    await sectionText(page, section);
    const profitOf = async (code: string) =>
      kronor(await page.locator(`${section} ol > li`).filter({ hasText: code }).innerText());
    // 79 kr per pack − 45 kr inköp = 34 kr, före butikens andel (ingen moms i organisationen).
    // BL-001: 14 pack per dag × 34 = 476. BL-002: 12 × 34 = 408.
    // BL-009: (3 × 29 + 2 White Flair) × 34 / 29 = 104,3.
    expect(await profitOf("BL-001")).toBe(476);
    expect(await profitOf("BL-002")).toBe(408);
    expect(await profitOf("BL-009")).toBe(104);
    // Nio automater med nog många dagar: 476, 408, 306, 272, 238, 204, 170, 136, 104.
    // Den mittersta är 238 kr/dag: BL-001 ligger 238 över, BL-009 134 under.
    const row = async (code: string) =>
      text(await page.locator(`${section} ol > li`).filter({ hasText: code }).innerText());
    expect(await row("BL-001")).toContain("238 kr/dag mer än en vanlig automat");
    expect(await row("BL-009")).toContain("134 kr/dag mindre än en vanlig automat");
    expect(await row("BL-005")).toContain("som en vanlig automat");

    // Enhetsekonomi visar samma vinst per dag.
    await page.goto("/automater/enhetsekonomi");
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const unit = text(await page.locator("main").innerText());
    expect(unit).toMatch(/476 kr/);
    expect(unit).toMatch(/104 kr/);

    // Lönsamhet för BL-009 i samma period: 89 pack × 34 kr = 3 026 kr, alltså 104 kr × 29 dagar.
    await page.goto(`/lonsamhet?automat=${fx.weakMachineId}`);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await until(
      async () => text(await page.locator("main").innerText()).includes("3 026 kr"),
      "Lönsamhet visar 3 026 kr för BL-009",
    );
  });
});

describe("Behörighet: bara de som får se ekonomin", () => {
  it("delägaren i Enkel vy ser varken rangordning, raden på Hem eller Bästa sortiment", async () => {
    const page = await signedIn(fx.fleetPartner);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(await page.locator("[data-home-ranking]").count()).toBe(0);
    await screenshot(page, "rank-09-enkel-vy-hem");
    for (const path of ["/automater", "/automater/bl-009", "/automater/enhetsekonomi"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).pathname, path).not.toMatch(/^\/automater/);
      expect(await page.locator("[data-ranking], [data-assortment]").count(), path).toBe(0);
      const body = text(await page.locator("body").innerText());
      expect(body, path).not.toMatch(/Rangordning|Bästa sortiment|överväg att flytta|Byt ut/i);
    }
    await screenshot(page, "rank-10-enkel-vy-automater-stangd");
  });

  it("påfyllaren ser ingen vinst per dag och inget sortimentsförslag", async () => {
    const page = await signedIn(fx.fleetRefiller);
    for (const path of ["/", "/automater", "/automater/bl-009"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(
        await page.locator("[data-ranking], [data-assortment], [data-home-ranking]").count(),
        path,
      ).toBe(0);
      const body = text(await page.locator("body").innerText());
      expect(body, path).not.toMatch(/kr\/dag|Bästa sortiment|Byt ut/i);
    }
  });

  it("utloggad: Automater leder till inloggningen", async () => {
    const opened = await openPage(browser, e2e().baseUrl, { device: DEVICE, theme: "dark" });
    contexts.push(opened.context);
    for (const path of ["/automater", "/automater/bl-009"]) {
      await opened.page.goto(path);
      await opened.page.waitForURL((url) => url.pathname.startsWith("/logga-in"));
      expect(await opened.page.locator("[data-ranking], [data-assortment]").count()).toBe(0);
    }
  });
});

describe("En ensam automat (iPhone SE)", () => {
  it("jämförs med sin förra period, och Hem har ingen rad", async () => {
    const page = await signedIn(fx.soloOwner);
    await page.goto("/automater");
    const section = '[data-ranking="single"]';
    const body = await sectionText(page, section);
    expect(body).toMatch(/BL-001 tjänar [\d ]+ kr\/dag\./);
    expect(body).toMatch(/Går bättre än förra perioden \(\+\d+ %\)\./);
    expect(body).toMatch(/29 dagar · förra perioden [\d ]+ kr\/dag \(\+\d+ %\)/);
    expect(await page.locator(`${section} ol > li`).count()).toBe(1);
    await expectFits(page, section);
    await shot(page, section, "rank-07-en-automat-forra-perioden");

    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    // Raden strömmas in: sidan är klar när menyn och rubriken finns, och raden kommer aldrig.
    await page.waitForLoadState("networkidle");
    expect(await page.locator("[data-home-ranking]").count()).toBe(0);
  });

  it("Bästa sortiment: det som står still visas, men inget att prova i stället", async () => {
    const page = await signedIn(fx.soloOwner);
    await page.goto("/automater/bl-001");
    const section = "[data-assortment]";
    const body = await sectionText(page, section);
    expect(body).toContain("Pokémon 151 säljer bäst här.");
    expect(body).toContain("Byt ut White Flair: säljer under 0,1/dag.");
    expect(body).not.toContain("Prova");
    expect(body).toContain(
      "Inget att prova i stället än: ingen annan automat har sålt i 14 dagar.",
    );
    // Mystery-packets etikett är appens längsta: den ska radbrytas, inte göra sidan bredare
    // än telefonen (expectFits mäter mot skärmens bredd, 375 px).
    expect(body).toMatch(/Mystery pack: fylls bara när facket är tomt \(14 st\)/i);
    const tag = page
      .locator(`${section} li`)
      .filter({ hasText: "Mystery Pack Premium" })
      .getByText(/fylls bara när facket är tomt/i);
    const box = await tag.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
    await expectFits(page, section);
    await shot(page, section, "rank-08-en-automat-sortiment");
  });
});
