/**
 * Prestanda (fas 7): buildLedger sparar liggaren per indata. Samma indata ger samma
 * liggare; allt annat (annan period, annan prislista, fler order) räknas om och ger
 * samma svar som utan sparande.
 */

import { describe, expect, it } from "vitest";

import { buildLedger } from "./ledger";
import { profitability } from "./profitability";
import { randomScenario } from "./testing/fixtures";
import type { ProfitabilityInput } from "./types";

/** Liggaren utan uppslagen (klassinstanser som bara används internt). */
function plain(ledger: ReturnType<typeof buildLedger>) {
  return { ...ledger, context: null };
}

/** Samma indata som nya objekt (ingen träff möjlig). */
function fresh(input: ProfitabilityInput): ProfitabilityInput {
  return structuredClone(input);
}

describe("buildLedger med sparade liggare", () => {
  it("bygger inte om för samma indata", () => {
    const input = randomScenario(11);
    const a = buildLedger(input);
    expect(buildLedger({ ...input })).toBe(a);
    expect(buildLedger(fresh(input))).not.toBe(a);
    expect(plain(buildLedger(fresh(input)))).toEqual(plain(a));
  });

  it("räknar om för annan period, andra priser eller fler order", () => {
    const input = randomScenario(12);
    const base = buildLedger(input);
    const shorter = { ...input, period: { start: input.period.start, end: input.period.start } };
    expect(buildLedger(shorter)).not.toBe(base);
    expect(plain(buildLedger(shorter))).toEqual(plain(buildLedger(fresh(shorter))));

    const prices = { ...input, prices: input.prices.slice(1) };
    expect(plain(buildLedger(prices))).toEqual(plain(buildLedger(fresh(prices))));

    const orders = [...input.orders];
    const growing = { ...input, orders };
    const before = buildLedger(growing);
    orders.pop();
    const after = buildLedger(growing);
    expect(after).not.toBe(before);
    expect(plain(after)).toEqual(plain(buildLedger(fresh(growing))));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("ger samma lönsamhet som utan sparande (slump %i)", (seed) => {
    const input = randomScenario(seed);
    for (const g of ["title", "machine", "store", "day", "month"] as const) {
      const cachedRun = profitability(input, g);
      expect(profitability(input, g)).toEqual(cachedRun);
      expect(cachedRun).toEqual(profitability(fresh(input), g));
    }
  });
});
