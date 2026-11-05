import { describe, expect, it } from "vitest";
import type { ProfitabilityInput } from "@/domain";
import { agreement, placement, price } from "@/domain/testing/fixtures";
import { dailyOrders, ev, NO_TAX, ord } from "../forecast/test-fixtures";
import type { StockEventRef } from "../lost-sales/stock";
import {
  bestActions,
  marginAndTrend,
  minutesByMonth,
  refillValue,
  SAVED_SALES_MAX_DAYS,
  TASK_ASSUMPTIONS,
  timeSaved,
  type BestActionsInput,
} from ".";
import { availableMonths, pickMonth } from "./months";

const OCT = { start: "2026-10-01", end: "2026-10-31" };

/** En försäljning (−1) klockan 12 (UTC) samma dag. */
function sale(id: string, date: string, machineId = "m-1", titleId = "t-a"): StockEventRef {
  return ev(id, machineId, titleId, "sale", -1, date, { occurredAt: `${date}T12:00:00Z` });
}
function at(e: StockEventRef, time: string): StockEventRef {
  return { ...e, occurredAt: `${e.businessDate}T${time}Z` };
}
function salesEachDay(
  prefix: string,
  from: number,
  to: number,
  month = "2026-10",
): StockEventRef[] {
  const out: StockEventRef[] = [];
  for (let d = from; d <= to; d++) {
    out.push(sale(`${prefix}${d}`, `${month}-${String(d).padStart(2, "0")}`));
  }
  return out;
}

/**
 * Inventering 10 pack 1 okt., ett pack per dag 1–20 okt. Påfyllning +10 den 9 okt. kl. 08
 * (2 pack kvar: i tid) och +5 den 25 okt. (0 kvar: efter tomt).
 */
function scenario(): StockEventRef[] {
  return [
    at(ev("c1", "m-1", "t-a", "count", 10, "2026-10-01"), "06:00:00"),
    ...salesEachDay("s", 1, 20),
    at(ev("r1", "m-1", "t-a", "refill", 10, "2026-10-09"), "08:00:00"),
    at(ev("r2", "m-1", "t-a", "refill", 5, "2026-10-25"), "08:00:00"),
  ];
}

describe("refillValue: påfyllning i tid", () => {
  it("räknar räddade pack högst 7 dagar efter att facket hade blivit tomt", () => {
    const r = refillValue({
      stockEvents: scenario(),
      orders: dailyOrders("o", "t-a", "m-1", "2026-10-01", 20, 1),
      period: OCT,
      settings: NO_TAX,
      prices: [price("t-a", 2_000, "2026-01-01")],
    });
    expect(SAVED_SALES_MAX_DAYS).toBe(7);
    // 2 pack kvar 9 okt.: försäljningen 9 och 10 okt. tömmer dem; 11–17 okt. räddas (7 pack).
    expect(r.savedUnits).toBe(7);
    expect(r.savedRevenueOre).toBe(7 * 4_900);
    expect(r.savedGrossProfitOre).toBe(7 * 2_900);
    expect(r.refills).toEqual({ onTime: 1, afterEmpty: 1, unknown: 0 });
    expect(r.onTimeShareBp).toBe(5_000);
    expect(r.byMonth).toEqual([
      {
        month: "2026-10",
        refillsOnTime: 1,
        refillsAfterEmpty: 1,
        savedUnits: 7,
        savedRevenueOre: 34_300,
      },
    ]);
    expect(r.series[0]).toMatchObject({ machineId: "m-1", titleId: "t-a", savedUnits: 7 });
  });

  it("räknar bara försäljning inom perioden", () => {
    const r = refillValue({
      stockEvents: scenario(),
      orders: dailyOrders("o", "t-a", "m-1", "2026-10-01", 20, 1),
      period: { start: "2026-10-01", end: "2026-10-13" },
      settings: NO_TAX,
    });
    // 11, 12 och 13 okt.
    expect(r.savedUnits).toBe(3);
    // Påfyllningen 25 okt. ligger utanför.
    expect(r.refills).toEqual({ onTime: 1, afterEmpty: 0, unknown: 0 });
    // Inga inköpspriser: inget bruttoresultat.
    expect(r.savedGrossProfitOre).toBe(0);
  });

  it("okänt saldo räknas varken som i tid eller efter tomt", () => {
    const r = refillValue({
      stockEvents: [sale("s1", "2026-10-02"), ev("r1", "m-1", "t-a", "refill", 5, "2026-10-03")],
      orders: [],
      period: OCT,
      settings: NO_TAX,
    });
    expect(r.refills).toEqual({ onTime: 0, afterEmpty: 0, unknown: 1 });
    expect(r.onTimeShareBp).toBeNull();
    expect(r.savedUnits).toBe(0);
  });

  it("slutar räkna vid en inventering med fler pack än väntat", () => {
    const events = [
      at(ev("c1", "m-1", "t-a", "count", 1, "2026-10-01"), "06:00:00"),
      at(ev("r1", "m-1", "t-a", "refill", 5, "2026-10-02"), "08:00:00"),
      sale("s1", "2026-10-02"),
      // Saldo väntat 5, räknat 9: en påfyllning som inte registrerats.
      at(ev("c2", "m-1", "t-a", "count", 9, "2026-10-03"), "06:00:00"),
      ...salesEachDay("x", 3, 6),
    ];
    const r = refillValue({ stockEvents: events, orders: [], period: OCT, settings: NO_TAX });
    expect(r.refills.onTime).toBe(1);
    expect(r.savedUnits).toBe(0);
  });

  it("flera påfyllningar samma dag räknas som en, och pack utan pris räknas utan kronor", () => {
    const events = [
      at(ev("c1", "m-1", "t-a", "count", 1, "2026-10-01"), "06:00:00"),
      at(ev("r1", "m-1", "t-a", "refill", 2, "2026-10-02"), "08:00:00"),
      at(ev("r2", "m-1", "t-a", "refill", 2, "2026-10-02"), "08:30:00"),
      ...salesEachDay("x", 3, 8),
    ];
    const r = refillValue({ stockEvents: events, orders: [], period: OCT, settings: NO_TAX });
    expect(r.refills.onTime).toBe(1);
    // Andra påfyllningen: saldot 3 före. 6 sålda − 3 = 3 räddade, utan snittpris.
    expect(r.savedUnits).toBe(3);
    expect(r.unitsWithoutPrice).toBe(3);
    expect(r.savedRevenueOre).toBe(0);
  });

  it("använder titelns snittpris i alla automater när automaten saknar egna order", () => {
    const r = refillValue({
      stockEvents: scenario(),
      orders: [
        ord("a", "t-a", "m-2", "2026-10-01", 6_000),
        ord("b", "t-a", "m-2", "2026-10-02", 4_000),
      ],
      period: OCT,
      settings: NO_TAX,
    });
    expect(r.savedRevenueOre).toBe(7 * 5_000);
  });

  it("drar momsen från snittpriset", () => {
    const r = refillValue({
      stockEvents: scenario(),
      orders: dailyOrders("o", "t-a", "m-1", "2026-10-01", 20, 1, 6_250),
      period: OCT,
      settings: { vatRateBp: 2_500 },
    });
    expect(r.savedRevenueOre).toBe(7 * 5_000);
  });
});

describe("timeSaved: sparad tid", () => {
  const counts = [
    { month: "2026-10", kind: "refill_visit" as const, count: 12 },
    { month: "2026-10", kind: "settlement" as const, count: 2 },
    { month: "2026-09", kind: "refill_visit" as const, count: 4 },
  ];

  it("antal × minuter per uppgift, i antagandenas ordning", () => {
    const t = timeSaved(counts, { months: ["2026-10"] });
    expect(t.lines.map((l) => l.kind)).toEqual(TASK_ASSUMPTIONS.map((a) => a.kind));
    expect(t.lines.find((l) => l.kind === "refill_visit")).toMatchObject({
      count: 12,
      minutes: 60,
    });
    expect(t.lines.find((l) => l.kind === "settlement")).toMatchObject({ count: 2, minutes: 40 });
    expect(t.minutes).toBe(100);
    expect(t.tasks).toBe(14);
    expect(t.valueOre).toBeNull();
  });

  it("kronor bara med timkostnad: minuter × timkostnad / 60", () => {
    expect(timeSaved(counts, { months: ["2026-10"], hourlyCostOre: 30_000 }).valueOre).toBe(50_000);
    expect(timeSaved(counts, { hourlyCostOre: 0 }).valueOre).toBeNull();
  });

  it("per månad", () => {
    expect(minutesByMonth(counts, ["2026-09", "2026-10", "2026-11"])).toEqual([
      { month: "2026-09", minutes: 20 },
      { month: "2026-10", minutes: 100 },
      { month: "2026-11", minutes: 0 },
    ]);
  });

  it("vägrar negativa antal", () => {
    expect(() => timeSaved([{ month: "2026-10", kind: "alert", count: -1 }])).toThrow();
  });
});

describe("marginAndTrend: kvar efter inköp", () => {
  function input(): ProfitabilityInput {
    return {
      orders: [
        ...dailyOrders("sep", "t-a", "m-1", "2026-09-01", 5, 1),
        ...dailyOrders("oct", "t-a", "m-1", "2026-10-01", 10, 1),
        ...dailyOrders("oct2", "t-b", "m-1", "2026-10-01", 1, 1),
      ],
      period: { start: "2026-09-01", end: "2026-10-31" },
      prices: [price("t-a", 2_000, "2026-01-01")],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1_000 })],
      placements: [placement("m-1", "s-1", "2026-01-01", null)],
      settings: NO_TAX,
    };
  }

  it("hela beloppet före butikens andel, per månad, automat och butik", () => {
    const r = marginAndTrend(input(), ["2026-09", "2026-10"], "2026-11-04");
    expect(r.current).toMatchObject({
      month: "2026-10",
      partial: false,
      revenueOre: 49_000,
      keptOre: 29_000,
      // t-b saknar inköpspris: ingår inte.
      unpricedRevenueOre: 4_900,
    });
    expect(r.previous).toMatchObject({ month: "2026-09", revenueOre: 24_500, keptOre: 14_500 });
    expect(r.keptChangeBp).toBe(10_000);
    expect(r.revenueChangeBp).toBe(10_000);
    expect(r.keptMarginBp).toBe(5_918);
    expect(r.machines).toEqual([
      {
        key: "m-1",
        orders: 11,
        revenueOre: 49_000,
        keptOre: 29_000,
        previousKeptOre: 14_500,
        changeBp: 10_000,
      },
    ]);
    // Butikens andel bara per butik: 10 % av 49 000 = 4 900.
    expect(r.stores[0]).toMatchObject({
      key: "s-1",
      keptOre: 29_000,
      storeShareOre: 4_900,
      ourOre: 24_100,
    });
  });

  it("en pågående månad jämförs med samma dagar månaden före", () => {
    const data = {
      ...input(),
      orders: [
        ...dailyOrders("sep", "t-a", "m-1", "2026-09-01", 30, 1),
        ...dailyOrders("oct", "t-a", "m-1", "2026-10-01", 10, 1),
      ],
    };
    const r = marginAndTrend(data, ["2026-09", "2026-10"], "2026-10-10");
    expect(r.current.partial).toBe(true);
    expect(r.previous).toMatchObject({ month: "2026-09", partial: true, revenueOre: 49_000 });
    expect(r.revenueChangeBp).toBe(0);
    expect(r.months.map((m) => m.revenueOre)).toEqual([147_000, 49_000]);
  });

  it("utan försäljning månaden före finns ingen förändring", () => {
    const r = marginAndTrend(
      { ...input(), orders: dailyOrders("oct", "t-a", "m-1", "2026-10-01", 2, 1) },
      ["2026-09", "2026-10"],
      "2026-11-04",
    );
    expect(r.previous).toBeNull();
    expect(r.keptChangeBp).toBeNull();
    expect(r.machines[0]!.changeBp).toBeNull();
  });
});

describe("bestActions: tre förslag", () => {
  const base: BestActionsInput = {
    lost: [],
    titles: [],
    unpriced: [],
    assortment: [],
    titleName: (id) => `Titel ${id}`,
    machineName: (id) => `Automat ${id}`,
    monthLabel: "oktober",
    hrefs: {
      lost: (m, t) => `/lost/${m}/${t}`,
      price: (t) => `/pris/${t}`,
      assortment: (m) => `/sortiment/${m}`,
    },
  };

  it("en av varje sort först, sedan störst värde", () => {
    const actions = bestActions({
      ...base,
      lost: [
        { machineId: "m-1", titleId: "t-a", lostRevenueOre: 90_000 },
        { machineId: "m-2", titleId: "t-a", lostRevenueOre: 80_000 },
        { machineId: "m-3", titleId: "t-a", lostRevenueOre: 4_000 },
      ],
      titles: [
        { titleId: "t-b", pricedOrders: 5, keptOre: -2_500 },
        { titleId: "t-c", pricedOrders: 2, keptOre: -9_000 },
        { titleId: "t-d", pricedOrders: 9, keptOre: 4_000 },
      ],
      assortment: [{ machineId: "m-1", effectPerWeekOre: 3_000, text: "Byt t-e mot t-f." }],
      unpriced: [{ titleId: "t-x", orders: 4, revenueOre: 19_600 }],
    });
    expect(actions.map((a) => a.key)).toEqual([
      "refill-earlier:m-1:t-a",
      "assortment:m-1",
      "price:t-b",
    ]);
    expect(actions[0]).toMatchObject({
      title: "Fyll på Titel t-a i Automat m-1 tidigare",
      valueOre: 90_000,
      href: "/lost/m-1/t-a",
    });
    expect(actions[1]!.valueOre).toBe(12_000);
    expect(actions[2]).toMatchObject({ title: "Höj priset på Titel t-b", valueOre: 2_500 });
    expect(actions[2]!.detail).toContain("−5,00");
  });

  it("fyller på med de näst bästa när sorterna inte räcker", () => {
    const actions = bestActions({
      ...base,
      lost: [
        { machineId: "m-1", titleId: "t-a", lostRevenueOre: 90_000 },
        { machineId: "m-2", titleId: "t-a", lostRevenueOre: 80_000 },
      ],
      unpriced: [{ titleId: "t-x", orders: 4, revenueOre: 19_600 }],
    });
    expect(actions.map((a) => a.kind)).toEqual([
      "refill-earlier",
      "refill-earlier",
      "missing-price",
    ]);
    expect(actions[2]!.valueOre).toBeNull();
  });

  it("inga kandidater ger en tom lista", () => {
    expect(bestActions(base)).toEqual([]);
  });
});

describe("månadsvalet", () => {
  it("listar månaderna från första ordern, nyast först", () => {
    expect(availableMonths("2026-08-15", "2026-11-05")).toEqual([
      "2026-11",
      "2026-10",
      "2026-09",
      "2026-08",
    ]);
    expect(availableMonths(null, "2026-11-05")).toEqual(["2026-11"]);
    expect(availableMonths("2020-01-01", "2026-11-05")).toHaveLength(24);
  });

  it("väljer ?manad om den finns, annars förra månaden, annars den senaste", () => {
    const months = ["2026-11", "2026-10", "2026-09"];
    expect(pickMonth("2026-09", months, "2026-11-05")).toBe("2026-09");
    expect(pickMonth("2020-01", months, "2026-11-05")).toBe("2026-10");
    expect(pickMonth(null, ["2026-11"], "2026-11-05")).toBe("2026-11");
  });
});
