/**
 * Prognos, förlorad försäljning och inköp ska vara rena och oberoende av processens tidszon.
 *
 * 1. Statisk kontroll: ingen källfil använder Date, slump, miljövariabler eller
 *    flyttalsformatering, och importer går bara till src/domain, src/lib/format, underlag,
 *    text och tidstolkning i src/analytics/todos och de egna mapparna.
 * 2. Samma beräkningar körs med TZ = UTC, Europe/Stockholm och Asia/Shanghai i samma process
 *    och ska ge identiska resultat.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/domain";
import { lostSales } from "../lost-sales";
import { demandFromForecast, inventoryValuation, purchasePlan } from "../purchasing";
import { forecastSales } from ".";
import { dailyOrders, ev, NO_TAX, saleEvents } from "./test-fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOLDERS = ["forecast", "lost-sales", "purchasing"];

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
  it("hittar källfilerna", () => {
    expect(sourceFiles().length).toBeGreaterThanOrEqual(12);
  });

  it.each(sourceFiles())("%s använder inte Date, slump eller miljön", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\b/, "Date"],
      [/Math\.random/, "Math.random"],
      [/process\./, "process"],
      [/parseFloat|toFixed|toPrecision|Math\.sqrt|Math\.pow|\*\*/, "flyttal"],
      [/\.toLocaleString\(|Intl\./, "lokal formatering"],
      [
        /from\s+["'](?!\.\/|\.\.\/(forecast|lost-sales|purchasing)(\/|["'])|\.\.\/todos\/(common|text|types|time)["']|@\/domain["']|@\/lib\/format["'])/,
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
    const asOf = "2026-10-31";
    const start = addDays(asOf, -139);
    const orders = [
      ...dailyOrders("a", "t-a", "m-1", start, 140, (d) => (d % 7 === 5 ? 5 : d % 3)),
      ...dailyOrders("b", "t-b", "m-1", start, 140, (d) => (d > 120 && d < 127 ? 0 : 2), 5_900),
      ...dailyOrders("c", "t-a", "m-2", start, 140, (d) => (d % 2) + Math.floor(d / 40)),
    ];
    const events = [
      ev("r1", "m-1", "t-b", "refill", 200, start, {
        occurredAt: `${start}T08:00:00+02:00`,
        seq: 1,
      }),
      ev("c1", "m-1", "t-b", "count", 0, addDays(start, 120), {
        occurredAt: `${addDays(start, 120)}T23:30:00+02:00`,
      }),
      ev("r2", "m-1", "t-b", "refill", 60, addDays(start, 127), {
        occurredAt: `${addDays(start, 127)}T00:30:00+01:00`,
      }),
      ev("w1", null, "t-a", "receipt", 40, addDays(start, 100)),
      ...saleEvents(orders),
    ];
    const ls = lostSales({
      orders,
      stockEvents: events,
      period: { start: "2026-09-01", end: asOf },
      settings: NO_TAX,
    });
    const forecast = forecastSales({
      orders,
      asOf,
      settings: NO_TAX,
      unavailable: ls.stockoutDays,
    });
    const pInput = {
      today: "2026-11-01",
      suppliers: [{ id: "s-1", name: "Leverantör", defaultLeadTimeDays: 10 }],
      supplierItems: [
        {
          id: "i1",
          supplierId: "s-1",
          titleId: "t-a",
          packSize: 12,
          minOrderQty: 24,
          leadTimeDays: null,
          unitCostOre: 2_000,
        },
        {
          id: "i2",
          supplierId: "s-1",
          titleId: "t-b",
          packSize: 6,
          minOrderQty: 0,
          leadTimeDays: 5,
          unitCostOre: 2_500,
        },
      ],
      warehouseStock: [{ titleId: "t-a", onHand: 30 }],
      machineStock: [{ machineId: "m-1", titleId: "t-b", onHand: 12 }],
      openPurchaseOrders: [],
      prices: [{ titleId: "t-a", unitCostOre: 1_900, validFrom: "2026-01-01" }],
      demand: demandFromForecast(forecast),
    };
    return JSON.stringify([ls, forecast, purchasePlan(pInput), inventoryValuation(pInput)]);
  }

  it("samma resultat i UTC, Europe/Stockholm och Asia/Shanghai", () => {
    const results = ["UTC", "Europe/Stockholm", "Asia/Shanghai"].map((tz) => {
      process.env.TZ = tz;
      return snapshot();
    });
    expect(results[0]!.length).toBeGreaterThan(10_000);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });
});
