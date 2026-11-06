/**
 * Butiker: "Till butiken" bredvid "Vår del" ska vara exakt andelen som dragits från vår
 * vinst, så att andelen + vår del = vår vinst före andelen, och samma tal som Lönsamhet per
 * butik. Tidigare räknades provisionen på order utan inköpspris in (Kiosken 2 075 kr på
 * Butiker mot 1 966 kr på Lönsamhet; 2 075 + 5 127 ≠ 7 093).
 */

import { describe, expect, it } from "vitest";

import { profitability, type ProfitabilityInput } from "@/domain";

import { compensationOf, storeKpis } from "./model";

function input(deductStoreShare: boolean): ProfitabilityInput {
  return {
    period: { start: "2026-11-01", end: "2026-11-02" },
    orders: [
      // Titel med inköpspris.
      {
        id: "o1",
        externalId: "1",
        titleId: "t",
        machineId: "m1",
        businessDate: "2026-11-01",
        amountOre: 10_000,
      },
      // Titel utan inköpspris: ingår inte i vinsten.
      {
        id: "o2",
        externalId: "2",
        titleId: "u",
        machineId: "m1",
        businessDate: "2026-11-02",
        amountOre: 5_000,
      },
    ],
    prices: [{ titleId: "t", unitCostOre: 2_000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-10-01",
        validTo: null,
        commissionBp: 1_000,
        monthlyRentOre: 30_000,
      },
    ],
    placements: [{ machineId: "m1", storeId: "s1", from: "2026-10-01", to: null }],
    settings: { vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1, deductStoreShare },
  } as ProfitabilityInput;
}

const row = (deduct: boolean) =>
  profitability(input(deduct), "store").rows.find((r) => r.kind === "item" && r.key === "s1")!;

describe("Butiker: andelen går ihop med vår del", () => {
  it("andelen + vår del = vår vinst före andelen, även med order utan inköpspris", () => {
    const on = row(true);
    const before = row(false).profitOre;
    expect(on.unpricedCommissionOre).toBeGreaterThan(0);
    expect(compensationOf(on) + on.profitOre).toBe(before);
    const k = storeKpis({ current: on, previous: null, daily: [], storeShareDeducted: true });
    const share = k.find((x) => x.id === "compensation")!.value;
    const ours = k.find((x) => x.id === "profit")!.value;
    expect(share! + ours!).toBe(before);
  });

  it("samma andel som Lönsamhet per butik (compensationOre)", () => {
    const on = row(true);
    expect(compensationOf(on)).toBe(on.compensationOre);
  });
});
