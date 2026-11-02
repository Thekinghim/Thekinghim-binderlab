/**
 * Ekonomiområdet (avstämning, kassaflöde, avtal) ska vara rent och oberoende av processens
 * tidszon.
 *
 * 1. Statisk kontroll: ingen källfil använder Date, Intl, slump, miljövariabler eller
 *    flyttalsformatering direkt. (Tidszonsomräkning sker bara i src/analytics/todos/time.ts,
 *    som alltid anger tidszonen uttryckligen.)
 * 2. Samma beräkningar körs med olika TZ i samma process och ska ge identiska resultat.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cashflow } from "../cashflow/cashflow";
import { contractReminders } from "../contracts/contracts";
import { reconcilePayouts } from "./reconcile";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["reconciliation", "cashflow", "contracts"];

function sourceFiles(): string[] {
  return DIRS.flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".config.ts"))
      .map((f) => join(d, f)),
  );
}

describe("rena funktioner", () => {
  it.each(sourceFiles())("%s använder inte Date, Intl, slump eller miljön", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\b/, "Date"],
      [/\bIntl\b/, "Intl"],
      [/Math\.random/, "Math.random"],
      [/process\./, "process"],
      [/parseFloat|toFixed|toPrecision/, "flyttalsformatering"],
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
    const orders = [
      // 31 okt. 17:30 svensk tid = 1 nov. 00:30 i Shanghai.
      {
        id: "a",
        externalId: "1",
        titleId: "t",
        machineId: "m1",
        businessDate: "2026-10-31",
        amountOre: 4900,
        orderedAt: "2026-10-31T16:30:00Z",
      },
      {
        id: "b",
        externalId: "2",
        titleId: "t",
        machineId: "m1",
        businessDate: "2026-11-01",
        amountOre: 5900,
        orderedAt: "2026-10-31T23:30:00Z",
      },
    ];
    const settings = { vatRateBp: 0, cardFeeBp: 0 };
    const rec = reconcilePayouts({
      orders,
      payouts: [
        { reference: "OKT", period: "2026-10", amountOre: 0, feesOre: 0 },
        { reference: "NOV", period: "2026-11", amountOre: 10_800, feesOre: 0 },
      ],
      settings,
      options: { providerTimeZone: "Asia/Shanghai" },
    });
    const cash = cashflow({
      orders,
      prices: [],
      agreements: [],
      placements: [],
      settings,
      payouts: [{ reference: "OKT", period: "2026-10", amountOre: 0, feesOre: 0 }],
      purchases: [],
      fixedCosts: [
        { id: "f", name: "F", amountOre: 100, interval: "month", start: "2026-01-31", end: null },
      ],
      asOf: "2026-11-02",
      range: { start: "2026-10-01", end: "2026-12-31" },
      granularity: "week",
    });
    const con = contractReminders({
      asOf: "2026-11-02",
      contracts: [
        { id: "c", storeId: "s", validFrom: "2026-01-01", validTo: "2027-03-31", noticeMonths: 3 },
      ],
    });
    return JSON.stringify([rec, cash, con]);
  }

  it("UTC, Europe/Stockholm, Asia/Shanghai och America/Los_Angeles ger samma resultat", () => {
    const results = ["UTC", "Europe/Stockholm", "Asia/Shanghai", "America/Los_Angeles"].map(
      (tz) => {
        process.env.TZ = tz;
        return snapshot();
      },
    );
    for (const r of results) expect(r).toBe(results[0]);
  });
});
