import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { agreement, NO_TAX, order, placement, price } from "./testing/fixtures";
import { depreciation, unitEconomics, type UnitEconomicsInput } from "./unit-economics";
import type { OrderLine } from "./types";

/** Ett pack per dag och automat, 49,00 kr, inköp 20,00 → 29,00 kvar per order. */
function dailyOrders(machineId: string, from: string, days: number): OrderLine[] {
  return Array.from({ length: days }, (_, i) =>
    order({ machineId, businessDate: addDays(from, i) }),
  );
}

const input: UnitEconomicsInput = {
  // sep–nov 2026: 30 + 31 + 30 = 91 dagar
  orders: [...dailyOrders("m-1", "2026-09-01", 91), ...dailyOrders("m-2", "2026-11-16", 15)],
  prices: [price("t-a", 2000, "2026-01-01")],
  agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 0 })],
  placements: [
    placement("m-1", "s-1", "2026-01-01", null),
    placement("m-2", "s-1", "2026-11-16", null),
  ],
  settings: NO_TAX,
  period: { start: "2026-09-01", end: "2026-11-30" },
  investments: [
    {
      machineId: "m-1",
      kind: "purchase",
      amountOre: 2_000_000,
      date: "2026-09-01",
      depreciationMonths: 36,
    },
    {
      machineId: "m-1",
      kind: "installation",
      amountOre: 100_000,
      date: "2026-09-01",
      depreciationMonths: null,
    },
    {
      machineId: "m-3",
      kind: "purchase",
      amountOre: 1_000_000,
      date: "2026-12-01",
      depreciationMonths: 24,
    },
  ],
};

describe("unitEconomics", () => {
  const rows = unitEconomics(input);
  const row = (id: string) => rows.find((r) => r.machineId === id)!;

  it("vinst per månad över hela kalendermånader", () => {
    // 91 order × 2 900 = 263 900 över exakt 3 månader → 87 966,67 → 87 967
    expect(row("m-1")).toMatchObject({
      orders: 91,
      profitOre: 263_900,
      activeDays: 91,
      activeMonths: 3,
      profitPerMonthOre: 87_967,
    });
  });

  it("investering, linjär avskrivning och återbetalningstid", () => {
    // Avskrivning 2 000 000 / 36 = 55 555,56 → 55 556 per månad; 2 hela månader per 30 nov
    // ackumulerad = round(2 000 000 × 2 / 36) = 111 111; installationen skrivs inte av
    // återbetalning = 2 100 000 / (263 900 / 3) = 23,87 → 23,9 månader
    expect(row("m-1")).toMatchObject({
      investmentOre: 2_100_000,
      monthlyDepreciationOre: 55_556,
      accumulatedDepreciationOre: 111_111,
      bookValueOre: 1_988_889,
      profitPerMonthAfterDepreciationOre: 87_967 - 55_556,
      paybackMonths: 23.9,
    });
  });

  it("automat som bara var placerad en del av perioden", () => {
    // 15 av 30 dagar i november = 0,5 månad; 15 × 2 900 = 43 500 → 87 000 per månad
    expect(row("m-2")).toMatchObject({
      activeDays: 15,
      activeMonths: 0.5,
      profitPerMonthOre: 87_000,
      paybackMonths: 0,
    });
  });

  it("investering efter asOf räknas inte; automat utan order kommer med", () => {
    expect(row("m-3")).toMatchObject({ orders: 0, investmentOre: 0, profitOre: 0 });
    const later = unitEconomics({ ...input, asOf: "2026-12-31" });
    expect(later.find((r) => r.machineId === "m-3")).toMatchObject({
      investmentOre: 1_000_000,
      paybackMonths: null,
    });
  });
});

describe("depreciation", () => {
  it("helt avskriven efter avskrivningstiden", () => {
    const inv = {
      machineId: "m",
      kind: "purchase" as const,
      amountOre: 1_000_000,
      date: "2024-01-15",
      depreciationMonths: 24,
    };
    expect(depreciation(inv, "2026-01-15")).toMatchObject({
      accumulatedOre: 1_000_000,
      bookValueOre: 0,
      monthlyOre: 0,
    });
    expect(depreciation(inv, "2026-01-14")).toMatchObject({
      accumulatedOre: 958_333,
      monthlyOre: 41_667,
    });
    expect(depreciation(inv, "2023-12-31")).toMatchObject({
      accumulatedOre: 0,
      bookValueOre: 1_000_000,
    });
  });
});
