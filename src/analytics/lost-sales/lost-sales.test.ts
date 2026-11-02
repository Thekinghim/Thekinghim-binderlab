import { describe, expect, it } from "vitest";
import { addDays, DomainError, type OrderLine } from "@/domain";
import { forecastHistoryPeriod, forecastSales } from "../forecast";
import { dailyOrders, ev, machine, NO_TAX, saleEvents } from "../forecast/test-fixtures";
import { lostSales } from "./lost-sales";
import { replayStockDaily, stockLevels, type StockEventRef } from "./stock";
import { stockoutUnavailableDays } from "./unavailable";

const plain = (s: string): string => s.replace(/ /g, " ");
const OCT = { start: "2026-10-01", end: "2026-10-31" } as const;
const PRICES = [{ titleId: "t-a", unitCostOre: 2_000, validFrom: "2026-01-01" }];

/** Order och lagerhändelser för en serie med påfyllningar. */
function scenario(): { orders: OrderLine[]; events: StockEventRef[] } {
  const orders = [
    // 2 pack/dag 21–30 sep. (20 pack) → slut.
    ...dailyOrders("a", "t-a", "m-1", "2026-09-21", 10, 2),
    // 1 pack på påfyllningsdagen 8 okt.
    ...dailyOrders("b", "t-a", "m-1", "2026-10-08", 1, 1),
    // 2 pack/dag 9–31 okt.
    ...dailyOrders("c", "t-a", "m-1", "2026-10-09", 23, 2),
  ];
  const events = [
    ev("r1", "m-1", "t-a", "refill", 20, "2026-09-21", { seq: 1 }),
    ev("r2", "m-1", "t-a", "refill", 20, "2026-10-08", { seq: 2 }),
    ev("r3", "m-1", "t-a", "refill", 50, "2026-10-15", { seq: 3 }),
    ...saleEvents(orders),
  ];
  return { orders, events };
}

describe("lagersaldo ur lagerhändelser", () => {
  it("inventering sätter saldot, övriga händelser ändrar det", () => {
    const events = [
      ev("1", "m-1", "t-a", "refill", 10, "2026-10-01", { seq: 1 }),
      ev("2", "m-1", "t-a", "sale", -1, "2026-10-01", { seq: 2 }),
      ev("3", "m-1", "t-a", "sale", -1, "2026-10-02", { seq: 3 }),
      ev("4", "m-1", "t-a", "count", 12, "2026-10-03", { seq: 4 }),
      ev("5", "m-1", "t-a", "waste", -2, "2026-10-03", { seq: 5 }),
    ];
    const [s] = replayStockDaily(events, "2026-10-04");
    expect(s!.days.map((d) => [d.date, d.opening, d.closing, d.inflow, d.sold])).toEqual([
      ["2026-10-01", null, 9, 10, 1],
      ["2026-10-02", 9, 8, 0, 1],
      // Inventeringen visar 4 fler än väntat: räknas som inflöde.
      ["2026-10-03", 8, 10, 4, 0],
      ["2026-10-04", 10, 10, 0, 0],
    ]);
    expect(s!.days[2]!.counted).toBe(true);
    expect(s!.days[2]!.eventIds).toEqual(["4", "5"]);
  });

  it("ordnar händelser inom dagen efter tidpunkt, sedan seq", () => {
    const sale = ev("s", "m-1", "t-a", "sale", -1, "2026-10-01", {
      seq: 10,
      occurredAt: "2026-10-01T07:00:00Z",
    });
    const count = ev("c", "m-1", "t-a", "count", 5, "2026-10-01", {
      seq: 5,
      occurredAt: "2026-10-01T14:00:00+02:00",
    });
    // Försäljningen 09:00 svensk tid före inventeringen 14:00: saldot är 5.
    expect(stockLevels([count, sale], "2026-10-01")[0]!.onHand).toBe(5);
    // Utan tidpunkter gäller seq: inventering (5) först, sedan försäljning → 4.
    const noTime = [
      { ...sale, occurredAt: null },
      { ...count, occurredAt: null },
    ];
    expect(stockLevels(noTime, "2026-10-01")[0]!.onHand).toBe(4);
  });

  it("saldot är okänt före första inventering/påfyllning och efter negativt saldo", () => {
    const events = [
      ev("1", "m-1", "t-a", "sale", -1, "2026-10-01"),
      ev("2", "m-1", "t-a", "refill", 3, "2026-10-02"),
      ev("3", "m-1", "t-a", "count", 3, "2026-10-03"),
      ev("4", "m-1", "t-a", "sale", -1, "2026-10-04"),
    ];
    const [s] = replayStockDaily(events, "2026-10-04");
    expect(s!.days.map((d) => d.closing)).toEqual([null, null, 3, 2]);
    const levels = stockLevels(events, "2026-10-04");
    expect(levels[0]).toMatchObject({ onHand: 2, known: true, lastCountDate: "2026-10-03" });
    // Som vyn stock_levels: utan inventering summeras alla händelser.
    const noCount = stockLevels(
      [
        ev("1", null, "t-a", "receipt", 4, "2026-10-01"),
        ev("2", null, "t-a", "transfer_out", -6, "2026-10-02"),
      ],
      "2026-10-02",
    );
    expect(noCount[0]).toMatchObject({
      onHand: -2,
      known: false,
      machineId: null,
      lastInflowDate: "2026-10-01",
    });
  });

  it("händelser efter sista dagen räknas inte; ogiltiga händelser ger DomainError", () => {
    const events = [
      ev("1", "m-1", "t-a", "refill", 5, "2026-10-01"),
      ev("2", "m-1", "t-a", "sale", -1, "2026-10-09"),
    ];
    expect(stockLevels(events, "2026-10-05")[0]!.onHand).toBe(5);
    expect(() =>
      stockLevels([ev("x", "m-1", "t-a", "count", -1, "2026-10-01")], "2026-10-01"),
    ).toThrow(DomainError);
    expect(() =>
      stockLevels(
        [{ ...ev("x", "m-1", "t-a", "refill", 1, "2026-10-01"), kind: "gift" as never }],
        "2026-10-01",
      ),
    ).toThrow(DomainError);
  });
});

describe("lostSales", () => {
  it("slutsålt enligt lagret: takt före × dagar × snittpris, påfyllningsdagen räknas till hälften", () => {
    const { orders, events } = scenario();
    const r = lostSales({
      orders,
      stockEvents: events,
      period: OCT,
      settings: NO_TAX,
      prices: PRICES,
    });
    expect(r.periods).toHaveLength(1);
    const p = r.periods[0]!;
    expect(p).toMatchObject({
      machineId: "m-1",
      titleId: "t-a",
      start: "2026-10-01",
      end: "2026-10-08",
      days: 8,
      source: "stock",
      ongoing: false,
      capped: false,
      lostDayWeightBp: 75_000,
      avgPriceOre: 4_900,
      priceSource: "series",
      lostUnitsMilli: 15_000,
      lostRevenueOre: 73_500,
      lostGrossProfitOre: 73_500 - 15 * 2_000,
    });
    // Takten: 20 pack på 10 dagar (serien började 21 sep.).
    expect(p.rate).toMatchObject({ units: 20, days: 10, perDayMilli: 2_000, lowData: false });
    expect(p.rate.window).toEqual({ start: "2026-09-03", end: "2026-09-30" });
    expect(plain(p.text)).toBe(
      "t-a i m-1 var slutsåld 1–8 okt. (7,5 dagar): ca 740 kr i förlorad försäljning (2,0 pack/dag × 7,5 dagar × 49,00 kr).",
    );
    expect(p.evidence.orderIds).toHaveLength(20);
    expect(p.evidence.dates).toHaveLength(8);
    expect(p.byMonth).toEqual([{ month: "2026-10", lostRevenueOre: 73_500, weightBp: 75_000 }]);

    const m = r.months[0]!;
    expect(plain(m.text)).toBe("Slutsålt kostade ca 740 kr i oktober.");
    expect(plain(m.detail)).toBe(
      "1 period i 1 automat, 7,5 dagar totalt. Störst: t-a i m-1, ca 740 kr (7,5 dagar).",
    );
    expect(m.lostRevenueOre).toBe(73_500);
    expect(m.lostGrossProfitOre).toBe(43_500);
    expect(r.total.lostRevenueOre).toBe(73_500);
    expect(r.stockoutDays.map((d) => d.weightBp)).toEqual([...new Array(7).fill(10_000), 5_000]);
    expect(r.mismatches).toEqual([]);
  });

  it("underlaget för perioden, månaden och totalen länkar till dagar, order och lagerhändelser", () => {
    const { orders, events } = scenario();
    const r = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    const p = r.periods[0]!;
    // Påfyllningen 8 okt. och försäljningen samma dag.
    expect(p.evidence.stockEventIds).toEqual(["r2", "s-b-0-0"]);
    const m = r.months[0]!;
    expect(m.heuristicLostRevenueOre).toBe(0);
    expect(m.evidence.dates).toEqual(p.evidence.dates);
    expect(m.evidence.dates).toHaveLength(8);
    expect(m.evidence.orderIds).toEqual(p.evidence.orderIds);
    expect(m.evidence.stockEventIds).toEqual(["r2", "s-b-0-0"]);
    expect(r.total.evidence.dates).toEqual(m.evidence.dates);
    expect(r.total.evidence.orderIds).toHaveLength(20);
    expect(r.total.evidence.stockEventIds).toEqual(["r2", "s-b-0-0"]);
  });

  it("en period över månadsskiftet delas efter slutsålda dagar och summerar exakt", () => {
    const orders = [
      ...dailyOrders("a", "t-a", "m-1", "2026-10-15", 14, 2), // 15–28 okt., 28 pack
      ...dailyOrders("b", "t-a", "m-1", "2026-11-05", 5, 2),
    ];
    const events = [
      ev("r1", "m-1", "t-a", "refill", 28, "2026-10-15"),
      ev("r2", "m-1", "t-a", "refill", 30, "2026-11-04"),
      ...saleEvents(orders),
    ];
    const r = lostSales({
      orders,
      stockEvents: events,
      period: { start: "2026-10-01", end: "2026-11-30" },
      settings: NO_TAX,
    });
    const p = r.periods[0]!;
    expect([p.start, p.end, p.lostDayWeightBp]).toEqual(["2026-10-29", "2026-11-04", 65_000]);
    expect(p.lostRevenueOre).toBe(63_700);
    expect(p.byMonth).toEqual([
      { month: "2026-10", lostRevenueOre: 29_400, weightBp: 30_000 },
      { month: "2026-11", lostRevenueOre: 34_300, weightBp: 35_000 },
    ]);
    expect(r.months.map((m) => m.lostRevenueOre)).toEqual([29_400, 34_300]);
    expect(r.months.reduce((a, m) => a + m.lostUnitsMilli, 0)).toBe(p.lostUnitsMilli);
    // Utan inköpspris: bruttoresultatet går inte att räkna.
    expect(p.lostGrossProfitOre).toBeNull();
    expect(r.months[0]!.periodsWithoutCost).toBe(1);
  });

  it("analysperioden kortar perioden; delmånad står i texten", () => {
    const { orders, events } = scenario();
    const r = lostSales({
      orders,
      stockEvents: events,
      period: { start: "2026-10-05", end: "2026-10-20" },
      settings: NO_TAX,
    });
    const p = r.periods[0]!;
    expect(p.start).toBe("2026-10-01");
    expect(p.lostDayWeightBp).toBe(35_000); // 5–7 okt. + halva 8 okt.
    expect(p.lostRevenueOre).toBe(34_300);
    expect(plain(r.months[0]!.text)).toBe("Slutsålt kostade ca 340 kr i oktober (5–20 okt.).");
    expect(r.months[0]!.partial).toBe(true);
  });

  it("automat ur drift räknas inte som slutsåld", () => {
    const { orders, events } = scenario();
    const r = lostSales({
      orders,
      stockEvents: events,
      period: OCT,
      settings: NO_TAX,
      machines: [machine("m-1", null, "2026-10-03")],
    });
    expect(r.periods[0]!.lostDayWeightBp).toBe(30_000);
    expect(r.periods[0]!.end).toBe("2026-10-03");
  });

  it("lång period: bara de första maxOpenDays dagarna kostar", () => {
    const orders = dailyOrders("a", "t-a", "m-1", "2026-09-20", 5, 1);
    const events = [ev("r", "m-1", "t-a", "refill", 5, "2026-09-20"), ...saleEvents(orders)];
    const r = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    const p = r.periods[0]!;
    expect([p.start, p.end, p.ongoing, p.capped]).toEqual(["2026-09-25", "2026-10-31", true, true]);
    // 25 sep. + 27 dagar = 22 okt. är sista dagen som kostar → 22 dagar i oktober.
    expect(p.lostDayWeightBp).toBe(220_000);
    expect(p.rate).toMatchObject({ units: 5, days: 5, lowData: true });
    expect(p.lostRevenueOre).toBe(22 * 4_900);
    expect(plain(p.text)).toMatch(
      /^t-a i m-1 är slutsåld sedan 25 sep\. \(37 dagar\): ca 1 100 kr/,
    );
    expect(plain(p.text)).toMatch(/Räknat på de första 28 dagarna/);
    expect(plain(p.text)).toMatch(/Takten bygger på bara 5 dagar\./);
  });

  it("försäljning trots saldo 0 räknas som tillgänglig och listas", () => {
    const orders = [
      ...dailyOrders("a", "t-a", "m-1", "2026-09-25", 10, 1), // 25 sep.–4 okt.
      ...dailyOrders("b", "t-a", "m-1", "2026-10-06", 5, 1),
    ];
    const events = [
      ev("r", "m-1", "t-a", "refill", 20, "2026-09-25", { seq: 1 }),
      ev("c", "m-1", "t-a", "count", 0, "2026-10-05", { seq: 2 }),
      ...saleEvents(orders),
    ];
    const r = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    expect(r.mismatches).toEqual([{ machineId: "m-1", titleId: "t-a", date: "2026-10-06" }]);
    expect(r.periods).toHaveLength(0);
    expect(plain(r.months[0]!.text)).toBe("Inget slutsålt i oktober.");
  });

  describe("heuristik när lagret är okänt", () => {
    const base = [
      ...dailyOrders("a", "t-a", "m-2", "2026-09-01", 39, 3), // 1 sep.–9 okt.
      ...dailyOrders("a2", "t-a", "m-2", "2026-10-15", 17, 3), // 15–31 okt.
    ];
    const other = dailyOrders("b", "t-b", "m-2", "2026-09-01", 61, 1);

    it("flera dagar utan försäljning trots takt, medan automaten säljer annat → troligen slutsåld", () => {
      const r = lostSales({
        orders: [...base, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
      });
      expect(r.periods).toHaveLength(1);
      const p = r.periods[0]!;
      expect(p).toMatchObject({
        source: "heuristic",
        start: "2026-10-10",
        end: "2026-10-14",
        lostDayWeightBp: 50_000,
        lostUnitsMilli: 15_000,
        lostRevenueOre: 73_500,
      });
      expect(plain(p.text)).toBe(
        "t-a i m-2 var troligen slutsåld 10–14 okt.: ingen försäljning på 5 dagar trots 3,0 pack/dag innan, " +
          "medan automaten sålde andra titlar: ca 740 kr i förlorad försäljning (3,0 pack/dag × 5 dagar × 49,00 kr).",
      );
      expect(r.stockoutDays.filter((d) => d.status === "probable-stockout")).toHaveLength(5);
      // Heuristikens del redovisas separat i månaden och totalen.
      expect(r.months[0]!.heuristicLostRevenueOre).toBe(73_500);
      expect(r.total.heuristicLostRevenueOre).toBe(73_500);
      expect(plain(r.months[0]!.detail)).toBe(
        "1 period i 1 automat, 5 dagar totalt. Störst: t-a i m-2, ca 740 kr (5 dagar). " +
          "Varav ca 740 kr bedömt ur försäljningen (lagret okänt).",
      );
    });

    it("ingen slutsats när takten bygger på färre än 7 dagar (ny titel)", () => {
      // Ny titel: 3 pack 10 okt., inget 11–12 okt., 1 pack 13 okt., sedan inget.
      // Automaten säljer en annan titel varje dag.
      const fresh = [
        ...dailyOrders("n1", "t-n", "m-2", "2026-10-10", 1, 3),
        ...dailyOrders("n2", "t-n", "m-2", "2026-10-13", 1, 1),
      ];
      const r = lostSales({
        orders: [...fresh, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
      });
      expect(r.periods).toHaveLength(0);
      expect(r.total.lostRevenueOre).toBe(0);

      // Utan kravet blir det två "troliga" perioder ur en takt från 1 respektive 2 dagar:
      // 11–12 okt.: 3 pack/dag × 2 dagar × 49 kr = 294 kr;
      // 14–31 okt.: (3 + 1) / 2 dagar = 2 pack/dag × 18 dagar × 49 kr = 1 764 kr.
      const loose = lostSales({
        orders: [...fresh, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
        options: { minRateDays: 1 },
      });
      expect(loose.periods.map((p) => [p.start, p.end, p.rate.days, p.lostRevenueOre])).toEqual([
        ["2026-10-14", "2026-10-31", 2, 176_400],
        ["2026-10-11", "2026-10-12", 1, 29_400],
      ]);
    });

    it("gränsen: takt från exakt 7 dagar räcker", () => {
      // 3 pack/dag 1–7 okt., inget 8–10 okt.: 3 × 3 = 9 pack väntat, takt från 7 dagar.
      const week = dailyOrders("w", "t-w", "m-2", "2026-10-01", 7, 3);
      const after = dailyOrders("w2", "t-w", "m-2", "2026-10-11", 21, 3);
      const r = lostSales({
        orders: [...week, ...after, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
      });
      const p = r.periods.find((x) => x.titleId === "t-w")!;
      expect([p.start, p.end, p.source, p.rate.days]).toEqual([
        "2026-10-08",
        "2026-10-10",
        "heuristic",
        7,
      ]);
      // 3 pack/dag × 3 dagar × 49 kr.
      expect(p.lostRevenueOre).toBe(44_100);
      const stricter = lostSales({
        orders: [...week, ...after, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
        options: { minRateDays: 8 },
      });
      expect(stricter.periods.some((x) => x.titleId === "t-w")).toBe(false);
    });

    it("inte när hela automaten var tyst (fel, inte slutsålt)", () => {
      const quiet = other.filter(
        (o) => o.businessDate < "2026-10-10" || o.businessDate > "2026-10-14",
      );
      const r = lostSales({
        orders: [...base, ...quiet],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
      });
      expect(r.periods).toHaveLength(0);
    });

    it("inte när den väntade försäljningen är under 3 pack", () => {
      const slow = [
        ...dailyOrders("s", "t-a", "m-2", "2026-09-01", 39, (d) => (d % 2 === 0 ? 1 : 0)),
        ...dailyOrders("s2", "t-a", "m-2", "2026-10-12", 20, 1),
      ];
      // 9 okt. (d = 38) säljer; 10–11 okt. tomt: 2 dagar × 0,5 pack = 1 pack väntat.
      const r = lostSales({
        orders: [...slow, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
      });
      expect(r.periods).toHaveLength(0);
    });

    it("kan stängas av", () => {
      const r = lostSales({
        orders: [...base, ...other],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
        options: { heuristic: false },
      });
      expect(r.periods).toHaveLength(0);
    });
  });

  it("slutsålda dagar gör att prognosen inte räknar dem som efterfrågan 0", () => {
    const { orders, events } = scenario();
    const ls = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    const plainForecast = forecastSales({ orders, asOf: "2026-10-31", settings: NO_TAX });
    const adjusted = forecastSales({
      orders,
      asOf: "2026-10-31",
      settings: NO_TAX,
      unavailable: ls.stockoutDays,
    });
    // 15 dagar före första försäljningen (21 sep.) + 8 slutsålda dagar.
    expect(plainForecast.series[0]!.components.excludedDays).toBe(15);
    expect(adjusted.series[0]!.components.excludedDays).toBe(23);
    expect(adjusted.series[0]!.components.levelMilli).toBeGreaterThan(
      plainForecast.series[0]!.components.levelMilli,
    );
  });

  it("resultatet beror inte på indatans ordning", () => {
    const { orders, events } = scenario();
    const a = lostSales({
      orders,
      stockEvents: events,
      period: OCT,
      settings: NO_TAX,
      prices: PRICES,
    });
    const b = lostSales({
      orders: [...orders].reverse(),
      stockEvents: [...events].reverse(),
      period: OCT,
      settings: NO_TAX,
      prices: PRICES,
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("ogiltig period eller inställning ger DomainError", () => {
    expect(() =>
      lostSales({
        orders: [],
        stockEvents: [],
        period: { start: "2026-10-31", end: "2026-10-01" },
        settings: NO_TAX,
      }),
    ).toThrow(DomainError);
    expect(() =>
      lostSales({
        orders: [],
        stockEvents: [],
        period: OCT,
        settings: NO_TAX,
        options: { refillDayShareBp: 12_000 },
      }),
    ).toThrow(DomainError);
    expect(addDays(OCT.start, 0)).toBe(OCT.start);
  });
});

describe("slutsålda dagar för prognosens historik", () => {
  // 2 pack/dag 20–29 juli (påfyllt 20), slut 30 juli–4 aug., påfyllt 5 aug., sedan 2 pack/dag.
  const orders = [
    ...dailyOrders("a", "t-a", "m-1", "2026-07-20", 10, 2),
    ...dailyOrders("b", "t-a", "m-1", "2026-08-05", 88, 2),
  ];
  const events = [
    ev("r1", "m-1", "t-a", "refill", 20, "2026-07-20", { seq: 1 }),
    ev("r2", "m-1", "t-a", "refill", 200, "2026-08-05", { seq: 2 }),
    ...saleEvents(orders),
  ];

  it("historiken är 8 veckor + backtestens dagar (98 dagar med standardvärdena)", () => {
    expect(forecastHistoryPeriod("2026-10-31")).toEqual({ start: "2026-07-26", end: "2026-10-31" });
    // 4 veckor + 7 dagar för ett ursprung = 35 dagar.
    expect(forecastHistoryPeriod("2026-10-31", { historyWeeks: 4, backtestOrigins: 1 })).toEqual({
      start: "2026-09-27",
      end: "2026-10-31",
    });
  });

  it("täcker hela historiken, också dagar som en körning för oktober inte bedömer", () => {
    const days = stockoutUnavailableDays({
      orders,
      stockEvents: events,
      asOf: "2026-10-31",
      settings: NO_TAX,
    });
    expect(days.map((d) => [d.date, d.status])).toEqual([
      ["2026-07-30", "stockout"],
      ["2026-07-31", "stockout"],
      ["2026-08-01", "stockout"],
      ["2026-08-02", "stockout"],
      ["2026-08-03", "stockout"],
      ["2026-08-04", "stockout"],
      ["2026-08-05", "refill-day"],
    ]);
    // lostSales för oktober bedömer bara från 6 aug. (1 okt. − 56 dagar).
    const oct = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    expect(oct.stockoutDays).toEqual([]);
  });

  it("dagar före historiken tas bort", () => {
    const days = stockoutUnavailableDays({
      orders,
      stockEvents: events,
      asOf: "2026-10-31",
      settings: NO_TAX,
      forecastOptions: { historyWeeks: 4, backtestOrigins: 1 },
    });
    expect(days).toEqual([]);
    const late = stockoutUnavailableDays({
      orders,
      stockEvents: events,
      asOf: "2026-08-31",
      settings: NO_TAX,
      forecastOptions: { historyWeeks: 4, backtestOrigins: 1 },
    });
    // Historik 28 juli–31 aug.: 30 juli–5 aug.
    expect(late.map((d) => d.date)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
    expect(late.every((d) => d.date >= "2026-07-28")).toBe(true);
  });

  it("resultatet passar direkt som unavailable i prognosen", () => {
    const unavailable = stockoutUnavailableDays({
      orders,
      stockEvents: events,
      asOf: "2026-08-31",
      settings: NO_TAX,
      forecastOptions: { historyWeeks: 4, backtestOrigins: 1 },
    });
    const options = { historyWeeks: 4, backtestOrigins: 1 };
    const plainF = forecastSales({ orders, asOf: "2026-08-31", settings: NO_TAX, options });
    const adjusted = forecastSales({
      orders,
      asOf: "2026-08-31",
      settings: NO_TAX,
      options,
      unavailable,
    });
    // Historiken 4 aug.–31 aug.: 4 och 5 aug. räknas inte som efterfrågan.
    expect(adjusted.series[0]!.components.excludedDays).toBe(
      plainF.series[0]!.components.excludedDays + 2,
    );
    expect(adjusted.series[0]!.components.levelMilli).toBe(2_000);
  });
});
