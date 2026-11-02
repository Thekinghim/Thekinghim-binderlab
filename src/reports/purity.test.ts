/**
 * Rapportunderlagen ska vara rena och oberoende av processens tidszon.
 *
 * 1. Statisk kontroll: ingen källfil i src/reports (utom excel.ts, som sätter arbetsbokens
 *    datum från periodens slut i UTC) använder Date, slump, miljön eller flyttalsformatering,
 *    och ingen importerar databas eller nätverk.
 * 2. Samma rapporter byggs med TZ = UTC, Europe/Stockholm och Asia/Shanghai i samma
 *    process och ska ge identiska resultat, även SIE-filen.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Period } from "@/domain";
import { randomScenario } from "@/domain/testing/fixtures";
import {
  buildAccountantReport,
  buildPartnerReport,
  buildStoreReport,
  buildSie4Text,
  type ReportSources,
} from "./index";

const DIR = fileURLToPath(new URL(".", import.meta.url));

describe("rena funktioner", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  it.each(files)("%s använder inte Date, slump, miljön eller I/O", (file) => {
    const src = readFileSync(join(DIR, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden: Array<[RegExp, string]> = [
      [/Math\.random/, "Math.random"],
      [/process\./, "process"],
      [/parseFloat|toFixed|toPrecision|toLocale/, "flyttals- eller lokalformatering"],
      [/from\s+["'](?:node:|fs|path|http|postgres|drizzle|@supabase|@\/db)/, "I/O eller databas"],
      [/\bfetch\(/, "nätverk"],
    ];
    if (file !== "excel.ts") forbidden.push([/\bDate\b/, "Date"]);
    for (const [re, what] of forbidden)
      expect(re.test(src), `${file} använder ${what}`).toBe(false);
  });
});

function withNames(input: ReturnType<typeof randomScenario>): ReportSources & { period: Period } {
  const ids = (xs: readonly string[]) => [...new Set(xs)].map((id) => ({ id, name: `Namn ${id}` }));
  return {
    ...input,
    stores: ids(input.placements.map((p) => p.storeId)),
    machines: ids(input.placements.map((p) => p.machineId)),
    titles: ids(input.orders.map((o) => o.titleId)),
  };
}

describe("oberoende av processens tidszon", () => {
  const original = process.env.TZ;
  afterAll(() => {
    process.env.TZ = original;
  });

  function snapshot(): string {
    const parts: unknown[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const input = withNames(randomScenario(seed));
      const month = input.period.start.slice(0, 7);
      const acc = buildAccountantReport(input, input.period);
      parts.push(acc);
      parts.push(
        buildSie4Text(acc, {
          company: "Bolaget AB",
          ledgerAccounts: [
            { key: "settlement", account: "1580", name: "Avräkning" },
            { key: "sales", account: "3001", name: "Försäljning" },
            { key: "vat_out", account: "2611", name: "Moms" },
            { key: "card_fees", account: "6570", name: "Avgifter" },
          ],
          fiscalYear: { start: "2020-01-01", end: "2030-12-31" },
          verificationSeries: "A",
        }),
      );
      parts.push(
        buildPartnerReport(input, month, { owners: [{ id: "a", name: "A", shareBp: 10_000 }] }),
      );
      for (const s of input.stores) parts.push(buildStoreReport(input, s.id, month));
    }
    return JSON.stringify(parts);
  }

  it("ger identiska rapporter i UTC, Europe/Stockholm och Asia/Shanghai", () => {
    const results: Record<string, string> = {};
    const offsets: Record<string, number> = {};
    for (const tz of ["UTC", "Europe/Stockholm", "Asia/Shanghai"]) {
      process.env.TZ = tz;
      offsets[tz] = new Date(Date.UTC(2026, 6, 1, 12)).getTimezoneOffset();
      results[tz] = snapshot();
    }
    expect(offsets).toEqual({ UTC: 0, "Europe/Stockholm": -120, "Asia/Shanghai": -480 });
    expect(results["Europe/Stockholm"]).toBe(results.UTC);
    expect(results["Asia/Shanghai"]).toBe(results.UTC);
  });

  it("resultatet beror inte på orderordningen", () => {
    const input = withNames(randomScenario(7));
    const reversed = { ...input, orders: [...input.orders].reverse() };
    expect(JSON.stringify(buildAccountantReport(reversed, input.period))).toBe(
      JSON.stringify(buildAccountantReport(input, input.period)),
    );
  });
});
