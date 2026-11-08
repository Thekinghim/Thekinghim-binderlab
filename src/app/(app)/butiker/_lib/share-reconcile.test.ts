/**
 * Butikens sida: "Till butiken" är det vi faktiskt betalar, samma tal som listan och
 * avräkningen (storeCompensation: också provisionen på order utan inköpspris). Med alla
 * order prissatta går Till butiken + Vår del ihop med vår vinst före andelen. Saknar några
 * sålda inköpspris går det inte ihop (vinsten räknar inte de orderna), och då står en kort
 * notis vid talen ("1 såld saknar inköpspris – vinsten är inte helt rätt.").
 */

import { describe, expect, it } from "vitest";

import { profitability, storeCompensation, type ProfitabilityInput } from "@/domain";

import { compensationOf, storeKpis, unpricedProfitNote } from "./model";

const NB = "\u00a0";

/** Två order i S1 (provision 10 % + hyra 300 kr/mån); `priced`: båda titlarna har pris. */
function input(deductStoreShare: boolean, priced = false): ProfitabilityInput {
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
    prices: [
      { titleId: "t", unitCostOre: 2_000, validFrom: "2026-01-01" },
      ...(priced ? [{ titleId: "u", unitCostOre: 1_000, validFrom: "2026-01-01" }] : []),
    ],
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

const rowOf = (inp: ProfitabilityInput) =>
  profitability(inp, "store").rows.find((r) => r.kind === "item" && r.key === "s1")!;
const toStore = (inp: ProfitabilityInput) =>
  storeCompensation(inp).stores.find((c) => c.storeId === "s1")!.totalOre;

/** Nyckeltalen som butikens sida räknar dem (loadStoreDetail). */
function pageKpis(priced: boolean) {
  const on = input(true, priced);
  const k = storeKpis({
    current: rowOf(on),
    previous: null,
    daily: [],
    storeShareDeducted: true,
    toStoreOre: toStore(on),
  });
  return {
    share: k.find((x) => x.id === "compensation")!.value!,
    ours: k.find((x) => x.id === "profit")!.value!,
    before: rowOf(input(false, priced)).profitOre,
    paid: toStore(on),
    note: unpricedProfitNote(rowOf(on)),
  };
}

describe("Butikens sida: Till butiken = det vi betalar", () => {
  it("alla order har inköpspris: Till butiken + Vår del = vår vinst före andelen", () => {
    const k = pageKpis(true);
    expect(k.share).toBe(k.paid);
    expect(k.share + k.ours).toBe(k.before);
    expect(k.note).toBeNull();
  });

  it("order utan inköpspris: samma belopp som listan och avräkningen, och en notis", () => {
    const k = pageKpis(false);
    // Provisionen på ordern utan pris (10 % av 5 000) ingår i det vi betalar.
    expect(k.share).toBe(k.paid);
    expect(k.share).toBe(compensationOf(rowOf(input(true))) + 500);
    // Därför går det inte ihop med vinsten (som inte räknar den ordern).
    expect(k.share + k.ours).not.toBe(k.before);
    expect(k.note).toBe(`1${NB}såld saknar inköpspris – vinsten är inte helt rätt.`);
  });

  it("flera sålda utan pris: talet i notisen", () => {
    const row = { ...rowOf(input(true)), unpricedOrders: 3 };
    expect(unpricedProfitNote(row)).toBe(
      `3${NB}sålda saknar inköpspris – vinsten är inte helt rätt.`,
    );
  });

  it("andelen som dras från vinsten är fortfarande samma som Lönsamhet per butik", () => {
    const on = rowOf(input(true));
    expect(on.unpricedCommissionOre).toBeGreaterThan(0);
    expect(compensationOf(on)).toBe(on.compensationOre);
    expect(compensationOf(on) + on.profitOre).toBe(rowOf(input(false)).profitOre);
  });
});
