/**
 * Marknadsanalyserna (pricing, releases, assortment) ska vara rena och oberoende av
 * processens tidszon.
 *
 * 1. Statisk kontroll: ingen källfil använder Date, slump, miljövariabler eller
 *    flyttalsformatering, och importer går bara till src/domain, src/lib/format, underlag och
 *    text i src/analytics/todos, bråk i src/analytics/expansion/common och de egna mapparna.
 * 2. Samma beräkningar körs med TZ = UTC, Europe/Stockholm och Asia/Shanghai i samma process
 *    och ska ge identiska resultat.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assortmentFollowUp, recommendAssortment } from "../assortment";
import { releaseOutcome, suggestReleasePurchase } from "../releases";
import {
  detectPriceChanges,
  flagPurchaseAnomalies,
  priceChangeEffect,
  proposePriceTests,
  purchasePriceTrends,
} from ".";
import { daily, MACHINES, sources } from "./test-fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOLDERS = ["pricing", "releases", "assortment"];

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
      [/\.toLocaleString\(|Intl\./, "lokal formatering"],
      [
        /from\s+["'](?!\.\/|\.\.\/(pricing|releases|assortment)\/|\.\.\/todos\/(common|text|types)["']|\.\.\/expansion\/common["']|@\/domain["']|@\/lib\/format["'])/,
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
    const src = sources({ "t-a": 2_000, "t-b": 1_500 });
    const orders = [
      ...daily("a1", "t-a", "m-1", "2026-06-01", 150, 2),
      ...daily(
        "a2",
        "t-a",
        "m-2",
        "2026-06-01",
        150,
        (d) => (d % 3 === 0 ? 2 : 1),
        (d) => (d >= 120 ? 5_400 : 4_900),
      ),
      ...daily("b1", "t-b", "m-1", "2026-06-01", 150, 1),
      ...daily("b2", "t-b", "m-2", "2026-06-01", 150, 2),
    ];
    const purchases = [2_800, 2_900, 3_000, 2_800, 3_000, 3_600].map((v, i) => ({
      id: `p${i}`,
      titleId: "t-a",
      supplierId: i % 2 === 0 ? "s-a" : "s-b",
      date: `2026-0${i + 1}-15`,
      unitCostOre: v,
      quantity: 12,
    }));
    const assignments = [
      { machineId: "m-1", titleId: "t-a", slots: 2, from: "2026-01-01", to: null },
      { machineId: "m-1", titleId: "t-b", slots: 1, from: "2026-01-01", to: null },
      { machineId: "m-2", titleId: "t-a", slots: 1, from: "2026-01-01", to: null },
      { machineId: "m-2", titleId: "t-b", slots: 2, from: "2026-01-01", to: null },
    ];
    const suggestion = suggestReleasePurchase({
      orders,
      releases: [{ titleId: "t-a", releaseDate: "2026-06-01" }, { titleId: "t-b" }],
      machines: MACHINES,
      asOf: "2026-10-28",
      newRelease: { titleId: "t-n", releaseDate: "2026-11-07" },
    });
    return JSON.stringify(
      [
        purchasePriceTrends({ purchases }),
        flagPurchaseAnomalies({ purchases }),
        detectPriceChanges(orders),
        priceChangeEffect({
          ...src,
          orders,
          titleId: "t-a",
          changeDate: "2026-09-28",
          asOf: "2026-10-28",
        }),
        proposePriceTests({ ...src, orders, asOf: "2026-10-28", quietDays: 0 }),
        suggestion,
        releaseOutcome({
          orders,
          titleId: "t-n",
          releaseDate: "2026-11-07",
          asOf: "2026-11-20",
          allocations: suggestion.allocations,
          curveCumulativeBp: suggestion.curve?.cumulativeBp,
        }),
        recommendAssortment({
          ...src,
          orders,
          machines: MACHINES,
          assignments,
          period: { start: "2026-10-01", end: "2026-10-28" },
        }),
        assortmentFollowUp({
          ...src,
          orders,
          machineId: "m-1",
          implementedOn: "2026-10-01",
          asOf: "2026-10-28",
        }),
      ],
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    );
  }

  it("samma resultat i UTC, Europe/Stockholm och Asia/Shanghai", () => {
    const results = ["UTC", "Europe/Stockholm", "Asia/Shanghai"].map((tz) => {
      process.env.TZ = tz;
      return snapshot();
    });
    expect(results[0]!.length).toBeGreaterThan(1_000);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });
});
