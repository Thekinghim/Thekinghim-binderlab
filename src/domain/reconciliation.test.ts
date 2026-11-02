/**
 * Avstämning: 200 slumpade men deterministiska (seedade) scenarier.
 *
 * För varje scenario och varje gruppering kontrolleras att
 * - raderna (inklusive 'unallocated' och övriga särskilda rader) summerar exakt till totalen i varje fält,
 * - totalen är identisk mellan alla grupperingar,
 * - totalen stämmer med en fristående referensberäkning (testing/oracle.ts),
 * - de inbyggda identiteterna håller per rad (betalt = moms + netto, vinst = intäkt − kostnader …),
 * - resultatet inte beror på i vilken ordning indata kommer.
 */

import { describe, expect, it } from "vitest";
import { profitability, profitabilityViews, type ProfitabilityRow } from "./profitability";
import { randomScenario, rng } from "./testing/fixtures";
import { oracleTotals } from "./testing/oracle";
import type { GroupBy, ProfitabilityInput } from "./types";

const GROUPS: GroupBy[] = ["title", "machine", "store", "day", "week", "month"];
const ITERATIONS = 200;

const NUMERIC_FIELDS = [
  "orders",
  "pricedOrders",
  "unpricedOrders",
  "grossOre",
  "vatOre",
  "revenueOre",
  "costOre",
  "feesOre",
  "commissionOre",
  "rentOre",
  "compensationOre",
  "profitOre",
  "unallocatedRentOre",
  "unpricedRevenueOre",
  "unpricedVatOre",
  "unpricedFeesOre",
  "unpricedCommissionOre",
  "unpricedRentOre",
  "unpricedCompensationOre",
] as const satisfies ReadonlyArray<keyof ProfitabilityRow>;

function totalsOnly(row: ProfitabilityRow) {
  const out: Record<string, number | null> = { marginBp: row.marginBp };
  for (const f of NUMERIC_FIELDS) out[f] = row[f];
  return out;
}

function checkRowIdentities(row: ProfitabilityRow, ctx: string): void {
  const fail = (what: string) => {
    throw new Error(`${ctx}, rad ${row.key}: ${what}`);
  };
  if (row.pricedOrders + row.unpricedOrders !== row.orders) fail("antal order går inte ihop");
  if (row.vatOre + row.revenueOre + row.unpricedVatOre + row.unpricedRevenueOre !== row.grossOre) {
    fail("betalt ≠ moms + netto");
  }
  if (row.commissionOre + row.rentOre !== row.compensationOre)
    fail("ersättning ≠ provision + hyra");
  if (row.unpricedCommissionOre + row.unpricedRentOre !== row.unpricedCompensationOre) {
    fail("oprissatt ersättning går inte ihop");
  }
  if (row.revenueOre - row.costOre - row.feesOre - row.compensationOre !== row.profitOre) {
    fail("vinst ≠ intäkt − inköp − avgifter − ersättning");
  }
  if (row.unallocatedRentOre > row.rentOre) fail("ej fördelad hyra större än hyran");
  for (const f of NUMERIC_FIELDS) {
    if (!Number.isSafeInteger(row[f])) fail(`${f} är inte ett heltal`);
    if (f !== "profitOre" && row[f] < 0) fail(`${f} är negativt`);
  }
}

function shuffled(input: ProfitabilityInput, seed: number): ProfitabilityInput {
  const r = rng(seed);
  return {
    ...input,
    orders: r.shuffle(input.orders),
    prices: r.shuffle(input.prices),
    agreements: r.shuffle(input.agreements),
    placements: r.shuffle(input.placements),
  };
}

describe("avstämning mellan vyer (200 seedade scenarier)", () => {
  it("alla grupperingar ger samma totaler och raderna summerar exakt", () => {
    let rowsChecked = 0;
    let ordersChecked = 0;
    let withUnallocated = 0;
    let withUnpriced = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const input = randomScenario(seed);
      const views = profitabilityViews(input, GROUPS);
      const reference = totalsOnly(views.title.totals);
      const oracle = oracleTotals(input);

      // Totalen mot referensberäkningen.
      for (const f of NUMERIC_FIELDS) {
        if (f === "compensationOre" || f === "unpricedCompensationOre") continue;
        if (reference[f] !== oracle[f as keyof typeof oracle]) {
          throw new Error(
            `seed ${seed}: ${f} = ${reference[f]}, referens ${oracle[f as keyof typeof oracle]}`,
          );
        }
      }
      // All hyra dras från vinsten, även den som fördelats på order utan pris.
      expect(views.title.totals.rentOre).toBe(oracle.totalRentOre);
      expect(views.title.totals.unpricedRentOre).toBeLessThanOrEqual(
        views.title.totals.unallocatedRentOre,
      );
      expect(views.title.storeMonthRent.reduce((a, s) => a + s.rentOre, 0)).toBe(
        oracle.totalRentOre,
      );

      for (const g of GROUPS) {
        const r = views[g];
        const ctx = `seed ${seed}, ${g}`;
        // Totaler identiska mellan vyerna.
        expect(totalsOnly(r.totals), ctx).toEqual(reference);
        checkRowIdentities(r.totals, ctx);
        // Raderna summerar exakt.
        const sums: Record<string, number> = {};
        for (const f of NUMERIC_FIELDS) sums[f] = 0;
        const keys = new Set<string>();
        for (const row of r.rows) {
          if (keys.has(row.key))
            throw new Error(`${ctx}: nyckeln ${row.key} förekommer två gånger`);
          keys.add(row.key);
          checkRowIdentities(row, ctx);
          for (const f of NUMERIC_FIELDS) sums[f]! += row[f];
          rowsChecked++;
        }
        for (const f of NUMERIC_FIELDS) {
          if (sums[f] !== r.totals[f]) {
            throw new Error(
              `${ctx}: summan av ${f} över raderna = ${sums[f]}, totalen = ${r.totals[f]}`,
            );
          }
        }
        // Vattenfallet.
        const steps = r.waterfall.steps;
        expect(
          steps[0]!.valueOre + steps[1]!.valueOre + steps[2]!.valueOre + steps[3]!.valueOre,
        ).toBe(r.totals.profitOre);
        expect(r.unpriced.revenueOre).toBe(r.totals.unpricedRevenueOre);
        expect(r.unpriced.orders).toBe(r.totals.unpricedOrders);
      }
      ordersChecked += views.title.totals.orders;
      if (views.title.totals.unallocatedRentOre > 0) withUnallocated++;
      if (views.title.totals.unpricedOrders > 0) withUnpriced++;
    }
    // Scenarierna ska faktiskt täcka de svåra fallen.
    expect(rowsChecked).toBeGreaterThan(5_000);
    expect(ordersChecked).toBeGreaterThan(10_000);
    expect(withUnallocated).toBeGreaterThan(20);
    expect(withUnpriced).toBeGreaterThan(50);
  });

  it("ordningen på indata påverkar inte resultatet", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = randomScenario(seed);
      for (const g of ["title", "store", "week"] as const) {
        expect(profitability(shuffled(input, seed * 7919), g), `seed ${seed}, ${g}`).toEqual(
          profitability(input, g),
        );
      }
    }
  });
});
