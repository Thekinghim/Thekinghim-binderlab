/**
 * Rapportsidor: varje ark i varje rapport får plats på sitt A4-ark. Testet lägger in
 * rapporter med långa tabeller och listor (delägarrapport för en månad, en kort period, 366
 * dagar och med många ägare, automater och händelser; butiksrapporten med detaljer, den korta
 * (ett ark för en vanlig butik, också med vinstdelning, hyra och tre automater) och den korta
 * med många automater; bokföringsunderlag för
 * en månad och tio månader) direkt i databasen, öppnar utskriftssidan i utskriftsläge och
 * kontrollerar att inget element går utanför sitt ark eller nedanför arkets brödyta. Sedan
 * hämtas PDF:en (samma väg som knappen PDF) och antalet sidor jämförs med antalet ark.
 *
 * Ögonblicksbilderna byggs med appens egen kod (e2e/support/report-snapshots.ts).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DB_KIND } from "@/server/reports/kinds";
import type { ReportSnapshot } from "@/server/reports/snapshot";

import {
  expectNoPageErrors,
  launchBrowser,
  openPage,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/browser";
import { accountantSnapshot, partnerSnapshot, storeSnapshot } from "./support/report-snapshots";
import { e2e, login } from "./support/session";

const CASES: {
  name: string;
  snapshot: () => ReportSnapshot;
  minSheets: number;
  /** Högsta antal ark (den korta butiksrapporten ska få plats på ett). */
  maxSheets?: number;
  /**
   * Kontrollera också att ingen text går ut i sidmarginalen (den korta butiksrapporten, som
   * har smala spalter). De andra rapporternas diagram har axeltexter som går någon pixel
   * utanför brödytan; de ändras inte här.
   */
  textInside?: boolean;
}[] = [
  {
    name: "delagare-manad",
    snapshot: () =>
      partnerSnapshot({ name: "månad", month: "2026-10", machines: 6, titles: 20, owners: 3 }),
    minSheets: 3,
  },
  {
    name: "delagare-kort-period",
    snapshot: () =>
      partnerSnapshot({
        name: "kort",
        month: "2026-10",
        period: { start: "2026-10-20", end: "2026-10-26" },
        machines: 6,
        titles: 20,
        owners: 3,
      }),
    minSheets: 3,
  },
  {
    name: "delagare-366-dagar",
    snapshot: () =>
      partnerSnapshot({
        name: "366",
        month: "2025-11",
        period: { start: "2025-11-01", end: "2026-11-01" },
        machines: 12,
        titles: 24,
        owners: 4,
      }),
    minSheets: 3,
  },
  {
    name: "delagare-manga",
    snapshot: () =>
      partnerSnapshot({
        name: "många",
        month: "2026-10",
        machines: 40,
        titles: 40,
        owners: 30,
        extraEvents: 12,
      }),
    minSheets: 5,
  },
  // Butiksrapporten med "Visa detaljer i rapporten": titlar och service, flera ark.
  {
    name: "butik-manad",
    snapshot: () => storeSnapshot("2026-10", 30, true),
    minSheets: 2,
  },
  // Den korta butiksrapporten (standard) för en vanlig butik: en automat, ett ark.
  {
    name: "butik-kort",
    snapshot: () => storeSnapshot("2026-10", 3),
    minSheets: 1,
    maxSheets: 1,
    textInside: true,
  },
  // Den längsta uträkningen (vinstdelning med hyra och VMB-moms: åtta rader) ska också få
  // plats på ett ark: med tre automater bredvid veckorna, och med en hälsning på tre rader.
  {
    name: "butik-kort-vinstdelning-tre-automater",
    snapshot: () => storeSnapshot("2026-10", 9, false, { split: true }),
    minSheets: 1,
    maxSheets: 1,
    textInside: true,
  },
  {
    name: "butik-kort-vinstdelning-lang-halsning",
    snapshot: () =>
      storeSnapshot("2026-10", 3, false, {
        split: true,
        greeting:
          "Tack för ett bra samarbete! Hör av er om ni vill flytta någon automat.\nVi fyller på inför höstlovet och ses i butiken vecka 44.\nHälsningar, Binderlab",
      }),
    minSheets: 1,
    maxSheets: 1,
    textInside: true,
  },
  // Den korta rapporten med tio automater: tabellen får delas, inget går utanför arket.
  {
    name: "butik-kort-manga-automater",
    snapshot: () => storeSnapshot("2026-10", 30),
    minSheets: 1,
    textInside: true,
  },
  { name: "bokforing-manad", snapshot: () => accountantSnapshot("2026-10", null), minSheets: 3 },
  {
    name: "bokforing-tio-manader",
    snapshot: () => accountantSnapshot("2026-01", { start: "2026-01-01", end: "2026-10-31" }),
    minSheets: 9,
  },
];

let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];
let sql: postgres.Sql;
const outDir = path.resolve(process.env.E2E_SCREENSHOT_DIR ?? path.join(".data", "e2e"));

beforeAll(async () => {
  sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  browser = await launchBrowser();
  ({ page, context, errors } = await openPage(browser, e2e().baseUrl));
  await login(page, e2e().users.owner);
  mkdirSync(outDir, { recursive: true });
});

afterEach(() => expectNoPageErrors(errors));

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await sql?.end();
});

/** Lägger in rapporten (som systemet; rapporter tas aldrig bort) och ger dess id. */
async function insertReport(snapshot: ReportSnapshot): Promise<string> {
  const id = randomUUID();
  const org = e2e().organizationId;
  // PDF:en har en fast sökväg (filen finns inte än; den skapas vid första hämtningen).
  const storagePath = `${org}/${snapshot.period.start.slice(0, 7)}/${id}.pdf`;
  const [row] = await sql<{ id: string }[]>`
    insert into public.reports
      (id, organization_id, storage_path, kind, period_start, period_end, store_id, generated_at,
       data_snapshot, calc_version)
    values (
      ${id}, ${org}, ${storagePath}, ${DB_KIND[snapshot.type]}, ${snapshot.period.start},
      ${snapshot.period.end}, null, ${snapshot.generatedAt},
      ${sql.json(JSON.parse(JSON.stringify(snapshot)))}, ${snapshot.calcVersion}
    )
    returning id`;
  return row!.id;
}

interface SheetCheck {
  sheets: number;
  problems: string[];
}

/** Körs i sidan: allt i varje ark ligger inom arket, och brödytans innehåll ovanför sidfoten. */
function checkSheets(textInside: boolean): SheetCheck {
  const problems: string[] = [];
  const sheets = Array.from(document.querySelectorAll<HTMLElement>(".bl-report .bl-sheet"));
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
  sheets.forEach((sheet, i) => {
    const s = sheet.getBoundingClientRect();
    const body = sheet.querySelector<HTMLElement>(".bl-page-body");
    if (!body) {
      problems.push(`ark ${i + 1}: saknar brödyta`);
      return;
    }
    if (sheet.hasAttribute("data-overflow")) {
      problems.push(`ark ${i + 1}: ${sheet.getAttribute("data-overflow")} px för högt`);
    }
    const b = body.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    const bodyBottom = b.bottom - Number.parseFloat(bodyStyle.paddingBottom) + 1;
    // Texten håller sig inom brödytans bredd (inte bara inom arket): en rad som är för lång
    // för sin spalt sticker annars ut i marginalen utan att elementets ruta gör det.
    const textLeft = b.left + Number.parseFloat(bodyStyle.paddingLeft) - 1;
    const textRight = b.right - Number.parseFloat(bodyStyle.paddingRight) + 1;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = textInside ? walker.nextNode() : null; node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || parent.closest(".sr-only, [data-print='hide']"))
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < textLeft || r.right > textRight) {
          problems.push(
            `ark ${i + 1}: texten "${node.textContent.trim().slice(0, 40)}" går utanför brödytan (${Math.round(Math.max(textLeft - r.left, r.right - textRight))} px i sidled)`,
          );
          break;
        }
      }
    }
    sheet.querySelectorAll("*").forEach((el) => {
      if (el === body || el.closest(".sr-only, [data-print='hide']")) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const bottom = body.contains(el) ? bodyBottom : s.bottom + 1;
      if (r.bottom > bottom || r.top < s.top - 1 || r.left < s.left - 1 || r.right > s.right + 1) {
        problems.push(
          `ark ${i + 1}: ${describe(el)} går utanför (${Math.round(r.bottom - bottom)} px nedåt)`,
        );
      }
    });
  });
  return { sheets: sheets.length, problems: problems.slice(0, 20) };
}

/** Antal sidor i en PDF från Chromium (sidobjekten). */
function pdfPages(bytes: Buffer): number {
  return bytes.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

describe("rapportsidor", () => {
  for (const c of CASES) {
    it(`${c.name}: varje ark får plats, och PDF:en har lika många sidor`, async () => {
      const id = await insertReport(c.snapshot());

      await page.emulateMedia({ media: "print" });
      await page.goto(`/rapport/${id}`);
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".bl-report").length > 0 &&
          Array.from(document.querySelectorAll(".bl-report")).every((r) =>
            r.hasAttribute("data-paginated"),
          ),
      );
      const check = await page.evaluate(checkSheets, c.textInside === true);
      expect(check.problems).toEqual([]);
      expect(check.sheets).toBeGreaterThanOrEqual(c.minSheets);
      if (c.maxSheets !== undefined) expect(check.sheets).toBeLessThanOrEqual(c.maxSheets);
      // En sektion som fortsätter på nästa ark upprepar bara "forts."-raden, inte rubriken.
      const headings = await page.locator(".bl-sheet h2").allInnerTexts();
      expect(headings.length).toBe(new Set(headings).size);
      // Numreringen följer arken.
      const footers = await page.locator(".bl-sheet footer").allInnerTexts();
      expect(footers.at(-1)).toContain(`Sida ${check.sheets} av ${check.sheets}`);

      await page.emulateMedia({ media: null });
      const res = await context.request.get(`/rapport/${id}/fil/pdf`, { maxRedirects: 0 });
      expect(res.status(), "PDF:en skapades (annars skickas man till utskriftssidan)").toBe(200);
      const pdf = Buffer.from(await res.body());
      writeFileSync(path.join(outDir, `rapportsidor-${c.name}.pdf`), pdf);
      expect(pdfPages(pdf)).toBe(check.sheets);
    });
  }
});
