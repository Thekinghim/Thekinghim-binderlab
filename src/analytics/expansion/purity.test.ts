/**
 * Expansion, scenarier, mål och effekt ska vara rena och oberoende av processens tidszon.
 *
 * 1. Statisk kontroll: ingen källfil använder Date, slump, miljövariabler eller
 *    flyttalsformatering, och importer går bara till src/domain, src/lib/format,
 *    src/analytics/todos (underlag och text), src/analytics/days (dagregeln) och de egna
 *    mapparna.
 * 2. Samma beräkningar körs med TZ = UTC, Europe/Stockholm och Asia/Shanghai i samma
 *    process och ska ge identiska resultat.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { binderlabEffect } from "../effect";
import { goalProgress } from "../goals";
import { newMachineScenario, priceChangeScenario } from "../scenarios";
import { compareUnitEconomics, expansionPipeline } from ".";
import { dailyOrders, INVESTMENT, OCTOBER, octoberSources, STORES } from "./test-fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOLDERS = ["expansion", "scenarios", "goals", "effect", "days"];

function sourceFiles(): string[] {
  return FOLDERS.flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.endsWith(".test.ts") &&
          !f.includes(".config.") &&
          f !== "test-fixtures.ts",
      )
      .map((f) => `${d}/${f}`),
  );
}

describe("rena funktioner", () => {
  it.each(sourceFiles())("%s använder inte Date, slump eller miljön", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\b/, "Date"],
      [/Math\.random/, "Math.random"],
      [/process\./, "process"],
      [/parseFloat|toFixed|toPrecision/, "flyttalsformatering"],
      [
        /from\s+["'](?!\.\/|\.\.\/(todos|expansion)\/|\.\.\/days["']|@\/domain["']|@\/lib\/format["'])/,
        "import utanför tillåtna moduler",
      ],
    ];
    for (const [re, what] of forbidden) {
      expect(re.test(src), `${file} använder ${what}`).toBe(false);
    }
  });
});

describe("oberoende av processens tidszon", () => {
  const original = process.env.TZ;
  afterAll(() => {
    process.env.TZ = original;
  });

  function snapshot(): string {
    const src = octoberSources();
    return JSON.stringify([
      newMachineScenario({
        sources: src,
        stores: STORES,
        likeStoreId: "s-1",
        investment: INVESTMENT,
      }),
      expansionPipeline({
        leads: [
          {
            id: "l",
            name: "Lead",
            storeType: "livs",
            city: "Malmö",
            openHoursPerWeek: 90,
            areaSqm: 300,
          },
        ],
        stores: STORES,
        sources: src,
        period: OCTOBER,
        defaultInvestment: INVESTMENT,
      }),
      compareUnitEconomics({ ...src, investments: [] }),
      priceChangeScenario({ ...src, titleId: "t-a", deltaOre: 1000, elasticityHundredths: -150 }),
      goalProgress({
        ...src,
        orders: [...src.orders, ...dailyOrders("m-1", "2026-11-01", 10)],
        goals: [
          { id: "g", month: "2026-11", metric: "revenue", target: 100_000, scope: "organization" },
          {
            id: "h",
            month: "2026-11",
            metric: "active_machines",
            target: 4,
            scope: "organization",
          },
        ],
        asOf: "2026-11-10",
      }),
      binderlabEffect({
        ...src,
        baselines: [
          {
            id: "b",
            metric: "profit_per_machine_month",
            value: 50_000,
            unit: "ore",
            scope: "organization",
          },
        ],
        months: ["2026-10", "2026-11"],
        asOf: "2026-11-10",
      }),
    ]);
  }

  it("samma resultat i UTC, Europe/Stockholm och Asia/Shanghai", () => {
    const results = ["UTC", "Europe/Stockholm", "Asia/Shanghai"].map((tz) => {
      process.env.TZ = tz;
      return snapshot();
    });
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });
});
