/**
 * Oberoende revision av fas 6b (prognos, förlorad försäljning, inköp).
 *
 * Varje förväntat värde är uträknat för hand (räkningen står i kommentaren vid testet),
 * inte hämtat från koden. Testerna körs även med TZ=UTC och TZ=Asia/Shanghai via
 * src/analytics/forecast/vitest.tz.config.ts.
 */

import { describe, expect, it } from "vitest";
import { addDays, type OrderLine } from "@/domain";
import { accuracyMetrics, fitModel, forecastSales, predictDay } from "@/analytics/forecast";
import { lostSales } from "@/analytics/lost-sales";
import {
  demandFromForecast,
  inventoryValuation,
  orderQuantity,
  purchasePlan,
  safetyStockMilli,
  type PurchasingInput,
} from "@/analytics/purchasing";
import { dailyOrders, ev, NO_TAX, ord, saleEvents } from "../test-fixtures";

const plain = (s: string): string => s.replace(/ /g, " ");

const AS_OF = "2026-10-31"; // lördag
/** 98 dagar: 8 veckors historik + 6 backtest-ursprung à 7 dagar (56 + 7 + 35). */
const START = addDays(AS_OF, -97);

const MODEL = {
  historyWeeks: 8,
  weekdayPriorDays: 2,
  maxTrendBp: 3_000,
  trendMinDaysPerHalf: 7,
  trendMinUnits: 10,
};

// ---------------------------------------------------------------------------
// R1. Prognos, jämn försäljning, två automater: Poisson-golv, intervall och summor
// ---------------------------------------------------------------------------
describe("R1 prognos: jämn försäljning i två automater", () => {
  const orders = [
    ...dailyOrders("x", "t-a", "m-1", START, 98, 2),
    ...dailyOrders("y", "t-a", "m-2", START, 98, 1),
    ord("nomachine", "t-a", null, AS_OF),
  ];
  const f = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });

  it("nivå = takten, faktorer 1,0, ingen trend; 28 dagar × 2 pack = 56 pack, × 49 kr = 2 744 kr", () => {
    const s = f.series.find((x) => x.machineId === "m-1")!;
    expect(s.components.levelMilli).toBe(2_000);
    expect(s.components.weekdayFactorsBp).toEqual(new Array(7).fill(10_000));
    expect(s.components.trendMilliPerWeek).toBe(0);
    expect(s.total.unitsMilli).toBe(56_000);
    // 2 000 milli × 4 900 öre / 1 000 = 9 800 öre/dag × 28.
    expect(s.total.revenueOre).toBe(274_400);
    expect(s.avgPriceOre).toBe(4_900);
  });

  it("backtesten är perfekt (residual 0), så Poisson-golvet ger intervallet", () => {
    const s = f.series.find((x) => x.machineId === "m-1")!;
    expect(s.accuracy.wapeBp).toBe(0);
    expect(s.accuracy.mapeBp).toBe(0);
    expect(s.accuracy.biasBp).toBe(0);
    expect(s.accuracy.points).toBe(42); // 6 ursprung × 7 dagar
    expect(s.varianceSource).toBe("poisson");
    // Poisson: 56 000 × 1 000 / 28 = 2 000 000 milli² per dag.
    expect(s.dayVarianceMilli2).toBe(2_000_000);
    // √(28 × 2 000 000) = √56 000 000 = 7 483,3 → 7 483; 1,282 × 7 483 = 9 593,2 → 9 593.
    expect(s.total.unitsLowMilli).toBe(56_000 - 9_593);
    expect(s.total.unitsHighMilli).toBe(56_000 + 9_593);
    // Intäkt: √(56e6 × 4 900²) = 36 668 242,4 → 36 668 242; × 1,282 / 1 000 = 47 008,7 → 47 009.
    expect(s.total.revenueLowOre).toBe(274_400 - 47_009);
    expect(s.total.revenueHighOre).toBe(274_400 + 47_009);
  });

  it("per titel: summan av automaterna, varianserna adderas (oberoende serier)", () => {
    const t = f.byTitle.find((x) => x.key === "t-a")!;
    expect(t.seriesKeys).toHaveLength(2);
    expect(t.total.unitsMilli).toBe(84_000); // 56 + 28 pack
    expect(t.total.revenueOre).toBe(411_600); // 274 400 + 137 200
    expect(t.dayVarianceMilli2).toBe(3_000_000); // 2e6 + 1e6
    // √(28 × 3e6) = √84e6 = 9 165,2 → 9 165; × 1,282 = 11 749,5 → 11 750.
    expect(t.total.unitsLowMilli).toBe(84_000 - 11_750);
    expect(t.total.unitsHighMilli).toBe(84_000 + 11_750);
    // √(84e6 × 4 900²) = 44 909 241,6 → 44 909 242; × 1,282 / 1 000 = 57 573,6 → 57 574.
    expect(t.total.revenueHighOre).toBe(411_600 + 57_574);
    // Den mindre automaten för sig: √(28e6) = 5 291,5 → 5 292; × 1,282 = 6 784,3 → 6 784.
    const m2 = f.series.find((x) => x.machineId === "m-2")!;
    expect(m2.total.unitsHighMilli).toBe(28_000 + 6_784);
    expect(f.total.total.unitsMilli).toBe(84_000);
    expect(f.byMachine.map((m) => m.key)).toEqual(["m-1", "m-2"]);
  });

  it("order utan automat räknas upp men ingår inte", () => {
    expect(f.ordersWithoutMachine).toBe(1);
  });

  it("fyra rullande veckor à 7 dagar som summerar till totalen", () => {
    const s = f.series[0]!;
    expect(s.weeks).toHaveLength(4);
    expect(s.weeks.map((w) => w.period.start)).toEqual([
      "2026-11-01",
      "2026-11-08",
      "2026-11-15",
      "2026-11-22",
    ]);
    expect(s.weeks.reduce((a, w) => a + w.unitsMilli, 0)).toBe(s.total.unitsMilli);
    expect(f.horizon).toEqual({ start: "2026-11-01", end: "2026-11-28" });
  });

  it("intäkten räknas exkl. moms (25 % moms: 4 900 → 3 920 öre)", () => {
    const g = forecastSales({ orders, asOf: AS_OF, settings: { vatRateBp: 2_500, cardFeeBp: 0 } });
    const s = g.series.find((x) => x.machineId === "m-1")!;
    expect(s.avgPriceOre).toBe(3_920);
    expect(s.total.revenueOre).toBe(28 * 7_840);
  });

  it("underlag och text finns (order, titel, automat, tal) och texten har siffror", () => {
    const s = f.series.find((x) => x.machineId === "m-1")!;
    expect(s.evidence.orderIds.length).toBe(112); // 56 dagar × 2 order i historiken
    expect(s.evidence.titleIds).toEqual(["t-a"]);
    expect(s.evidence.machineIds).toEqual(["m-1"]);
    expect(s.evidence.figures.find((x) => x.key === "levelMilli")!.value).toBe(2_000);
    expect(plain(s.text)).toContain("ca 2 700 kr");
    expect(plain(s.text)).toContain("ca 56 pack");
    expect(s.explanation).toContain("Nivå 2,0 pack/dag");
    expect(f.accuracy.evidence.dates.length).toBe(6);
    expect(f.total.evidence.figures.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R2. Veckodagsfaktorer med krympning (k = 2) och nivå
// ---------------------------------------------------------------------------
describe("R2 modellen: veckodagsfaktorer krymps mot 1,0", () => {
  it("lördag 6, övriga 2: faktorer 20 667 / 8 223 / 8 222 och prognos per veckodag", () => {
    // 2026-06-01 är en måndag; index 5 = lördag.
    const units = Array.from({ length: 56 }, (_, i) => (i % 7 === 5 ? 6 : 2));
    const c = fitModel(
      { start: "2026-06-01", units, available: units.map(() => true) },
      55,
      MODEL,
    )!;
    // N = 56, U = 144. Takt (miljondelar): lör (48·56 + 2·144)/(56·10) = 5,3143 → 5 314 285;
    // övriga (16·56 + 288)/560 = 2,1143 → 2 114 285. Summa 17 999 995.
    // Andel av 70 000: lör 20 666,67, övriga 8 222,22 → golv 20 666 + 6·8 222 = 69 998;
    // 2 kvar: lör (rest 0,67), sedan måndag (lika rest, lägsta index).
    expect(c.weekdayFactorsBp).toEqual([8_223, 8_222, 8_222, 8_222, 8_222, 20_667, 8_222]);
    // Varje vecka: 18 pack mot faktorsumma 70 000 → nivå 18/7 = 2,5714 → 2 571.
    expect(c.levelMilli).toBe(2_571);
    expect(c.trendMilliPerWeek).toBe(0);
    // Historiken slutar söndag 26 juli (index 55); h = 1 är måndag, h = 6 lördag.
    expect(c.origin).toBe("2026-07-26");
    const sat = predictDay(c, 6, 3_000);
    expect(sat.weekday).toBe(6);
    // 2 571 × 20 667 / 10 000 = 5 313,49 → 5 313.
    expect(sat.unitsMilli).toBe(5_313);
    const mon = predictDay(c, 1, 3_000);
    expect(mon.weekday).toBe(1);
    // 2 571 × 8 223 / 10 000 = 2 114,13 → 2 114.
    expect(mon.unitsMilli).toBe(2_114);
  });
});

// ---------------------------------------------------------------------------
// R3. Trend: steg från 1 till 3 pack/dag, eftersläpning 17/6 veckor, tak ±30 %
// ---------------------------------------------------------------------------
describe("R3 modellen: trend och tak", () => {
  const units = Array.from({ length: 56 }, (_, i) => (i < 28 ? 1 : 3));
  const c = fitModel({ start: "2026-06-01", units, available: units.map(() => true) }, 55, MODEL)!;

  it("nivå, trend och eftersläpning", () => {
    // Nivå = Σk·u_k / (Σk · 70 000) × 10^7 = (7·10 + 21·26) / (36 · 70 000) × 10^7 = 2 444,4.
    expect(c.levelMilli).toBe(2_444);
    // (3 − 1) / (8/2) = 0,5 pack/dag per vecka.
    expect(c.trendMilliPerWeek).toBe(500);
    expect(c.levelLagWeeks.num * 6).toBe(c.levelLagWeeks.den * 17);
  });

  it("utan tak: bas = 2 444 + 500 × (17/6 + 1/14) = 2 444 + 1 452 = 3 896", () => {
    expect(predictDay(c, 1, 10_000).baseMilli).toBe(3_896);
  });

  it("med standardtaket 30 %: 2 444 × 1,3 = 3 177,2 → 3 177", () => {
    const p = predictDay(c, 1, 3_000);
    expect(p.baseMilli).toBe(3_177);
    expect(p.trendMilli).toBe(733);
  });
});

// ---------------------------------------------------------------------------
// R4. Backtest med rullande ursprung: WAPE, MAPE, bias, naiv jämförelse
// ---------------------------------------------------------------------------
describe("R4 prognos: backtest när sista veckan dubblas", () => {
  // 2 pack/dag i 91 dagar, sedan 4 pack/dag de sista 7 dagarna.
  const orders = dailyOrders("b", "t-b", "m-1", START, 98, (d) => (d >= 91 ? 4 : 2));
  const f = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
  const s = f.series[0]!;

  it("träffsäkerhet för hand", () => {
    // 6 ursprung, alla förutsäger 2 000/dag. Bara sista ursprunget (7 dagar à 4 000) missar.
    // Σ utfall = 35·2 000 + 7·4 000 = 98 000; Σ|fel| = 14 000 → WAPE 1 428,6 → 1 429 bp.
    expect(s.accuracy.points).toBe(42);
    expect(s.accuracy.origins).toBe(6);
    expect(s.accuracy.wapeBp).toBe(1_429);
    expect(s.accuracy.biasBp).toBe(-1_429);
    // MAPE: fem ursprung 0, sista |14 000 − 28 000| / 28 000 = 5 000 → 5 000/6 = 833.
    expect(s.accuracy.mapeBp).toBe(833);
    // Naiv (snittet 7 dagar före ursprunget) = 2 000 överallt → samma fel.
    expect(s.accuracy.naiveWapeBp).toBe(1_429);
    expect(f.accuracy.total.wapeBp).toBe(1_429);
  });

  it("modellens komponenter efter steget", () => {
    // Nivå = (14·28 + 28·8) / (36·70 000) × 10^7 = 616/2 520 000 × 10^7 = 2 444.
    expect(s.components.levelMilli).toBe(2_444);
    // Trend = (70 − 56)/4 / 7 × ... = 2·10^7·14·280 000 / (8·280 000²) = 125.
    expect(s.components.trendMilliPerWeek).toBe(125);
  });

  it("prognosen per dag, summan och intervallet", () => {
    // Dag h: trend = 125 × (232 + 12h) / 84; h = 1 → 363,1 → 363 → 2 807; tak 3 177 från h = 25.
    expect(s.days.slice(0, 3).map((d) => d.unitsMilli)).toEqual([2_807, 2_825, 2_843]);
    expect(s.days[27]!.unitsMilli).toBe(3_177);
    expect(s.total.unitsMilli).toBe(84_939);
    expect(s.total.revenueOre).toBe(416_200);
    // Residualvarians 7·2 000² / 42 = 666 667 < Poisson 84 939 000 / 28 = 3 033 536.
    expect(s.varianceSource).toBe("poisson");
    expect(s.dayVarianceMilli2).toBe(3_033_536);
    // √(28 × 3 033 536) = 9 216,2 → 9 216; × 1,282 = 11 814,9 → 11 815.
    expect(s.total.unitsHighMilli).toBe(84_939 + 11_815);
    expect(s.total.revenueHighOre).toBe(416_200 + 57_895);
    // Första veckan: 20 025 milli, √(7 × 3 033 536) = 4 608,1 → 4 608 × 1,282 = 5 907.
    expect(s.weeks[0]!.unitsMilli).toBe(20_025);
    expect(s.weeks[0]!.unitsHighMilli).toBe(20_025 + 5_907);
  });

  it("accuracyMetrics direkt: MAPE per ursprung, WAPE per dag", () => {
    const m = accuracyMetrics(
      [
        { actualMilli: 2_000, forecastMilli: 3_000, naiveMilli: 2_000 },
        { actualMilli: 4_000, forecastMilli: 3_000, naiveMilli: 2_000 },
      ],
      [
        { actualMilli: 6_000, forecastMilli: 6_000 },
        { actualMilli: 1_000, forecastMilli: 1_500 },
        { actualMilli: 0, forecastMilli: 500 },
      ],
    );
    expect(m.wapeBp).toBe(3_333); // 2 000 / 6 000
    expect(m.biasBp).toBe(0);
    expect(m.naiveWapeBp).toBe(3_333);
    expect(m.mapeBp).toBe(2_500); // (0 + 5 000)/2, ursprung utan utfall hoppas över
  });
});

// ---------------------------------------------------------------------------
// R5. Slutsålda dagar räknas inte som efterfrågan 0
// ---------------------------------------------------------------------------
describe("R5 prognos: slutsålda dagar i historiken", () => {
  const orders = dailyOrders("u", "t-u", "m-1", START, 91, 2);
  const lastWeek = Array.from({ length: 7 }, (_, i) => addDays(AS_OF, -i));

  it("med slutsålda dagar: nivå 2 000 och ingen trend; utan: 1 556", () => {
    const f = forecastSales({
      orders,
      asOf: AS_OF,
      settings: NO_TAX,
      unavailable: lastWeek.map((date) => ({ machineId: "m-1", titleId: "t-u", date })),
    });
    const s = f.series[0]!;
    expect(s.components.levelMilli).toBe(2_000);
    expect(s.components.trendMilliPerWeek).toBe(0);
    expect(s.components.excludedDays).toBe(7);
    expect(s.total.unitsMilli).toBe(56_000);
    expect([...s.evidence.dates].sort()).toEqual([...lastWeek].sort());
    // Sista backtest-ursprunget har bara slutsålda dagar och hoppas över.
    expect(s.accuracy.origins).toBe(5);

    // Utan listan: nivå = 14·28 / (36·70 000) × 10^7 = 1 555,6 → 1 556.
    const g = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    expect(g.series[0]!.components.levelMilli).toBe(1_556);
  });
});

// ---------------------------------------------------------------------------
// R6. Förlorad försäljning enligt lagret
// ---------------------------------------------------------------------------
const OCT = { start: "2026-10-01", end: "2026-10-31" } as const;

describe("R6 förlorad försäljning: slutsålt enligt lagerhändelserna", () => {
  function base(extra: OrderLine[] = []) {
    const sold = [
      ...dailyOrders("a", "t-a", "m-1", "2026-09-03", 28, 2), // 56 pack 3–30 sep.
      ...dailyOrders("c", "t-a", "m-1", "2026-10-10", 22, 2), // 10–31 okt.
    ];
    const events = [
      ev("r1", "m-1", "t-a", "refill", 56, "2026-09-03", { seq: 1 }),
      ev("r2", "m-1", "t-a", "refill", 20, "2026-10-10", { seq: 2 }),
      ev("r3", "m-1", "t-a", "refill", 40, "2026-10-15", { seq: 3 }),
      ...saleEvents(sold),
    ];
    return { orders: [...sold, ...extra], events };
  }

  it("1–9 okt. slutsålt + påfyllningsdag 10 okt. (halv) = 9,5 dagar; 30 sep. räknas inte", () => {
    const { orders, events } = base();
    const r = lostSales({
      orders,
      stockEvents: events,
      period: OCT,
      settings: NO_TAX,
      prices: [{ titleId: "t-a", unitCostOre: 2_000, validFrom: "2026-01-01" }],
      titles: [{ id: "t-a", name: "30th Celebration" }],
    });
    expect(r.periods).toHaveLength(1);
    const p = r.periods[0]!;
    expect([p.start, p.end, p.source]).toEqual(["2026-10-01", "2026-10-10", "stock"]);
    expect(p.lostDayWeightBp).toBe(95_000);
    // Takt: 56 pack / 28 dagar (3–30 sep.) = 2 000 milli.
    expect(p.rate).toMatchObject({ units: 56, days: 28, perDayMilli: 2_000 });
    // 2 × 9,5 = 19 pack; × 49 kr = 931 kr; inköp 19 × 20 kr = 380 kr.
    expect(p.lostUnitsMilli).toBe(19_000);
    expect(p.lostRevenueOre).toBe(93_100);
    expect(p.lostGrossProfitOre).toBe(55_100);
    expect(r.total.lostRevenueOre).toBe(93_100);
    expect(r.months).toHaveLength(1);
    expect(plain(r.months[0]!.text)).toBe("Slutsålt kostade ca 930 kr i oktober.");
    expect(plain(p.text)).toContain("9,5 dagar");
    expect(p.evidence.orderIds).toHaveLength(56);
    expect(p.evidence.dates).toHaveLength(10);
    expect(p.evidence.machineIds).toEqual(["m-1"]);
    expect(r.stockoutDays.filter((d) => d.date >= "2026-10-01")).toHaveLength(10);
    expect(r.stockoutDays.find((d) => d.date === "2026-10-10")!.weightBp).toBe(5_000);
    expect(r.stockoutDays.some((d) => d.date === "2026-09-30")).toBe(false);
    expect(r.mismatches).toEqual([]);
  });

  it("order trots saldo 0 (5 okt.) → tillgänglig dag, listas och delar perioden", () => {
    const { orders, events } = base([ord("x", "t-a", "m-1", "2026-10-05")]);
    const r = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    expect(r.mismatches).toEqual([{ machineId: "m-1", titleId: "t-a", date: "2026-10-05" }]);
    const byStart = new Map(r.periods.map((p) => [p.start, p]));
    // 1–4 okt.: 2 000 × 4 dagar × 49 kr = 39 200 öre.
    expect(byStart.get("2026-10-01")!.lostRevenueOre).toBe(39_200);
    // 6–10 okt.: takt (8 sep.–5 okt., utan slutsålda 1–4 okt.) = 47 pack / 24 dagar = 1 958;
    // 47 × 4,5 dagar × 4 900 / 24 = 43 181,25 → 43 181.
    const second = byStart.get("2026-10-06")!;
    expect(second.rate).toMatchObject({ units: 47, days: 24, perDayMilli: 1_958 });
    expect(second.lostDayWeightBp).toBe(45_000);
    expect(second.lostRevenueOre).toBe(43_181);
    expect(r.total.lostRevenueOre).toBe(82_381);
  });
});

describe("R6b förlorad försäljning: över månadsskiftet och långa perioder", () => {
  it("28 sep.–4 okt.: 3 dagar i sep., 3,5 i okt.; kostnaden delas exakt", () => {
    const orders = [
      ...dailyOrders("a", "t-b", "m-2", "2026-08-31", 28, 1, 5_000), // 31 aug.–27 sep.
      ...dailyOrders("c", "t-b", "m-2", "2026-10-04", 28, 1, 5_000),
    ];
    const events = [
      ev("r1", "m-2", "t-b", "refill", 28, "2026-08-31", { seq: 1 }),
      ev("r2", "m-2", "t-b", "refill", 40, "2026-10-04", { seq: 2 }),
      ...saleEvents(orders),
    ];
    const r = lostSales({
      orders,
      stockEvents: events,
      period: { start: "2026-09-01", end: "2026-10-31" },
      settings: NO_TAX,
    });
    expect(r.periods).toHaveLength(1);
    const p = r.periods[0]!;
    expect([p.start, p.end, p.lostDayWeightBp]).toEqual(["2026-09-28", "2026-10-04", 65_000]);
    // 1 pack/dag × 6,5 dagar × 50 kr = 325 kr → sep. 3/6,5 = 150 kr, okt. 175 kr.
    expect(p.lostRevenueOre).toBe(32_500);
    expect(p.byMonth).toEqual([
      { month: "2026-09", lostRevenueOre: 15_000, weightBp: 30_000 },
      { month: "2026-10", lostRevenueOre: 17_500, weightBp: 35_000 },
    ]);
    expect(r.months.map((m) => plain(m.text))).toEqual([
      "Slutsålt kostade ca 150 kr i september.",
      "Slutsålt kostade ca 180 kr i oktober.",
    ]);
    expect(r.total.lostRevenueOre).toBe(32_500);
    expect(p.lostGrossProfitOre).toBeNull(); // inget inköpspris
  });

  it("slutsåld sedan 20 sep. (pågår): bara de 28 första dagarna kostar, i okt. 1–17 okt.", () => {
    const orders = dailyOrders("a", "t-c", "m-5", "2026-08-23", 28, 1); // 23 aug.–19 sep.
    const events = [ev("r1", "m-5", "t-c", "refill", 28, "2026-08-23"), ...saleEvents(orders)];
    const r = lostSales({ orders, stockEvents: events, period: OCT, settings: NO_TAX });
    const p = r.periods[0]!;
    expect([p.start, p.end, p.days]).toEqual(["2026-09-20", "2026-10-31", 42]);
    expect(p.capped).toBe(true);
    expect(p.ongoing).toBe(true);
    // Dag 1–28 = 20 sep.–17 okt.; inom oktober 17 dagar × 1 pack × 49 kr = 833 kr.
    expect(p.lostDayWeightBp).toBe(170_000);
    expect(p.lostRevenueOre).toBe(83_300);
    expect(plain(r.months[0]!.text)).toBe("Slutsålt kostade ca 830 kr i oktober.");
    expect(plain(p.text)).toContain("de första 28 dagarna");
  });
});

// ---------------------------------------------------------------------------
// R7. Heuristik när lagret är okänt
// ---------------------------------------------------------------------------
describe("R7 förlorad försäljning: heuristik utan lagerhändelser", () => {
  const hot = [
    ...dailyOrders("h1", "t-h", "m-3", "2026-09-03", 28, 2), // 3–30 sep.
    ...dailyOrders("h2", "t-h", "m-3", "2026-10-04", 28, 2), // 4–31 okt.
  ];
  const other = dailyOrders("o", "t-o", "m-3", "2026-09-03", 59, 1); // varje dag
  // Säljer varannan dag (14 pack på 28 dagar) och sedan inget 30 sep.–3 okt.
  // Försäljningen fortsätter varannan dag från 4 okt.
  const slow = [
    ...dailyOrders("s", "t-s", "m-3", "2026-09-03", 27, (d) => (d % 2 === 0 ? 1 : 0)),
    ...dailyOrders("s2", "t-s", "m-3", "2026-10-04", 28, (d) => (d % 2 === 0 ? 1 : 0)),
  ];
  // Samma som t-h men i en automat utan andra titlar.
  const alone = [
    ...dailyOrders("a1", "t-h", "m-4", "2026-09-03", 28, 2),
    ...dailyOrders("a2", "t-h", "m-4", "2026-10-04", 28, 2),
  ];
  const r = lostSales({
    orders: [...hot, ...other, ...slow, ...alone],
    stockEvents: [],
    period: OCT,
    settings: NO_TAX,
  });

  it("3 dagar utan försäljning, väntat 6 pack, automaten sålde annat → troligen slutsåld", () => {
    const p = r.periods.find((x) => x.machineId === "m-3" && x.titleId === "t-h")!;
    expect([p.start, p.end, p.source]).toEqual(["2026-10-01", "2026-10-03", "heuristic"]);
    // 2 pack/dag × 3 dagar × 49 kr = 294 kr.
    expect(p.lostRevenueOre).toBe(29_400);
    expect(p.text).toContain("troligen slutsåld");
    expect(r.stockoutDays.filter((d) => d.titleId === "t-h" && d.machineId === "m-3")).toHaveLength(
      3,
    );
    expect(r.stockoutDays.every((d) => d.status === "probable-stockout")).toBe(true);
  });

  it("väntat under 3 pack (14/27 × 4 = 2,1) → ingen period", () => {
    expect(r.periods.some((x) => x.titleId === "t-s")).toBe(false);
  });

  it("automaten sålde inget annat → ingen period", () => {
    expect(r.periods.some((x) => x.machineId === "m-4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R8. Inköpsplanering och lagervärde
// ---------------------------------------------------------------------------
describe("R8 inköp", () => {
  const TODAY = "2026-11-02";
  const flat = (titleId: string, perDay: number, variance = 0) => ({
    titleId,
    dailyMilli: new Array<number>(28).fill(perDay),
    dayVarianceMilli2: variance,
  });
  const input: PurchasingInput = {
    today: TODAY,
    titles: [
      { id: "A", name: "Pokémon 151" },
      { id: "B", name: "30th Celebration" },
    ],
    suppliers: [
      { id: "s-1", name: "Leverantör 1", defaultLeadTimeDays: 5 },
      { id: "s-2", name: "Leverantör 2", defaultLeadTimeDays: null },
    ],
    supplierItems: [
      {
        id: "i-a1",
        supplierId: "s-1",
        titleId: "A",
        packSize: 12,
        minOrderQty: 10,
        leadTimeDays: 7,
        unitCostOre: 3_000,
      },
      {
        id: "i-a2",
        supplierId: "s-2",
        titleId: "A",
        packSize: 1,
        minOrderQty: 0,
        leadTimeDays: 3,
        unitCostOre: 3_200,
      },
      {
        id: "i-b1",
        supplierId: "s-1",
        titleId: "B",
        packSize: 12,
        minOrderQty: 24,
        leadTimeDays: null,
        unitCostOre: 1_500,
      },
      {
        id: "i-c2",
        supplierId: "s-2",
        titleId: "C",
        packSize: 1,
        minOrderQty: 0,
        leadTimeDays: null,
        unitCostOre: 2_000,
      },
      {
        id: "i-c1",
        supplierId: "s-1",
        titleId: "C",
        packSize: 1,
        minOrderQty: 0,
        leadTimeDays: null,
        unitCostOre: 2_000,
      },
      {
        id: "i-e1",
        supplierId: "s-2",
        titleId: "E",
        packSize: 1,
        minOrderQty: 0,
        leadTimeDays: 10,
        unitCostOre: 2_500,
      },
    ],
    warehouseStock: [
      { titleId: "A", onHand: 10 },
      { titleId: "B", onHand: 4 },
      { titleId: "D", onHand: 2 },
    ],
    machineStock: [
      { machineId: "m-1", titleId: "A", onHand: 5 },
      { machineId: "m-2", titleId: "A", onHand: 3 },
      { machineId: "m-3", titleId: "A", onHand: -2 },
      { machineId: "m-1", titleId: "E", onHand: 3 },
    ],
    openPurchaseOrders: [
      {
        id: "po-1",
        supplierId: "s-1",
        status: "ordered",
        orderedOn: "2026-10-30",
        expectedOn: "2026-11-07",
        lines: [{ titleId: "A", quantity: 10, receivedQuantity: 4, unitCostOre: 3_000 }],
      },
      {
        id: "po-2",
        supplierId: "s-1",
        status: "ordered",
        orderedOn: "2026-11-01",
        expectedOn: "2026-11-22",
        lines: [{ titleId: "A", quantity: 12, receivedQuantity: 0, unitCostOre: 3_000 }],
      },
      {
        id: "po-3",
        supplierId: "s-1",
        status: "draft",
        orderedOn: null,
        expectedOn: null,
        lines: [{ titleId: "A", quantity: 100, receivedQuantity: 0, unitCostOre: 3_000 }],
      },
      {
        id: "po-4",
        supplierId: "s-1",
        status: "cancelled",
        orderedOn: null,
        expectedOn: null,
        lines: [{ titleId: "A", quantity: 50, receivedQuantity: 0, unitCostOre: 3_000 }],
      },
    ],
    prices: [
      { titleId: "A", unitCostOre: 2_500, validFrom: "2026-01-01" },
      { titleId: "A", unitCostOre: 2_800, validFrom: "2026-11-01" },
      { titleId: "A", unitCostOre: 3_100, validFrom: "2026-12-01" },
    ],
    demand: [flat("A", 2_000, 4_000_000), flat("B", 1_100), flat("D", 500), flat("E", 1_000)],
  };
  const plan = purchasePlan(input);
  const line = (id: string) => plan.lines.find((l) => l.titleId === id)!;

  it("A: säkerhetslager, lagerposition och avrundning till box", () => {
    const a = line("A");
    expect([a.supplierItemId, a.leadTimeDays, a.leadTimeSource]).toEqual(["i-a1", 7, "item"]);
    expect(a.demandLeadTimeMilli).toBe(14_000);
    expect(a.demandProtectionMilli).toBe(28_000); // 14 dagar × 2 pack
    // 1,645 × √(14 × 4 000 000) = 1,645 × 7 483 = 12 309,5 → 12 310.
    expect(a.safetyStockMilli).toBe(12_310);
    expect(a.targetMilli).toBe(40_310);
    // 10 + (5 + 3, −2 räknas som 0) + 6 kvar på po-1 (väntas 7 nov. ≤ 15 nov.); po-2 22 nov. räknas inte; utkast ignoreras.
    expect([a.warehouseOnHand, a.machineOnHand, a.onOrderCounted, a.onOrderLater]).toEqual([
      10, 8, 6, 12,
    ]);
    expect(a.positionPacks).toBe(24);
    expect(a.shortfallMilli).toBe(16_310);
    // 16,31 → 17 → minsta order 10 (ingen ändring) → 2 boxar à 12 = 24.
    expect([a.rawQty, a.afterMinQty, a.orderQty, a.boxes]).toEqual([17, 17, 24, 2]);
    expect(a.orderValueOre).toBe(72_000);
    expect(plain(a.text)).toContain("Saknas 17, avrundat till 24 (12 per box)");
    // Täckning: 24 pack / 2 per dag → dag 12 (14 nov.) tar slut; beställ senast 7 nov.
    expect([a.coverDays, a.projectedStockout, a.orderBy, a.late]).toEqual([
      12,
      "2026-11-14",
      "2026-11-07",
      false,
    ]);
    expect(a.evidence.figures.find((f) => f.key === "safetyStockMilli")!.value).toBe(12_310);
    expect(a.evidence.machineIds).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("B: minsta order styr (spec-exemplet 13,2 → 14 → 24 → 24), ledtid från leverantören", () => {
    const b = line("B");
    expect([b.leadTimeDays, b.leadTimeSource]).toEqual([5, "supplier"]);
    // 12 dagar × 1,1 = 13,2 pack; lager 4 → saknas 9,2 → 10 → 24 → 24.
    expect(b.shortfallMilli).toBe(9_200);
    expect([b.rawQty, b.afterMinQty, b.orderQty]).toEqual([10, 24, 24]);
    expect(plain(b.text)).toContain("avrundat till 24 (minsta order 24)");
    expect(orderQuantity(13_200, 24, 12)).toEqual({ rawQty: 14, afterMinQty: 24, orderQty: 24 });
    expect(orderQuantity(25_000, 24, 12)).toEqual({ rawQty: 25, afterMinQty: 25, orderQty: 36 });
    expect(orderQuantity(24_000, 0, 12)).toEqual({ rawQty: 24, afterMinQty: 24, orderQty: 24 });
    expect(orderQuantity(1, 0, 6)).toEqual({ rawQty: 1, afterMinQty: 1, orderQty: 6 });
    expect(orderQuantity(0, 24, 12)).toEqual({ rawQty: 0, afterMinQty: 0, orderQty: 0 });
  });

  it("C: lika pris → kortast ledtid (s-1 5 dagar mot s-2 standard 7); ingen efterfrågan", () => {
    const c = line("C");
    expect(c.supplierItemId).toBe("i-c1");
    expect(c.leadTimeDays).toBe(5);
    expect(c.status).toBe("no-demand");
  });

  it("D saknar leverantör; E tar slut före leveransen", () => {
    const d = line("D");
    expect(d.status).toBe("no-supplier");
    expect(d.rawQty).toBe(5); // 14 × 0,5 = 7 − 2
    const e = line("E");
    // 3 pack, 1/dag → slut dag 3 (5 nov.), leverans dag 10 (12 nov.).
    expect([e.coverDays, e.projectedStockout, e.expectedArrival, e.late]).toEqual([
      3,
      "2026-11-05",
      "2026-11-12",
      true,
    ]);
    expect(e.orderQty).toBe(14); // 17 dagar × 1 − 3
    expect(plain(e.text)).toContain("Lagret väntas ta slut");
  });

  it("inköpsorder per leverantör och totalsumma", () => {
    const s1 = plan.orders.find((o) => o.supplierId === "s-1")!;
    expect(s1.totalPacks).toBe(48);
    expect(s1.totalOre).toBe(72_000 + 36_000);
    const s2 = plan.orders.find((o) => o.supplierId === "s-2")!;
    expect(s2.totalOre).toBe(35_000);
    expect(plan.totalOre).toBe(143_000);
    expect(s1.evidence.titleIds).toEqual(["A", "B"]);
  });

  it("säkerhetslager: z × √(dagar × varians)", () => {
    expect(safetyStockMilli(1_645, 14, 4_000_000)).toBe(12_310);
    expect(safetyStockMilli(0, 14, 4_000_000)).toBe(0);
    expect(safetyStockMilli(1_645, 14, 0)).toBe(0);
  });

  it("lagervärde med inköpspriset som gäller i dag och kapitalbindning", () => {
    const v = inventoryValuation(input);
    const a = v.titles.find((t) => t.titleId === "A")!;
    expect([a.unitCostOre, a.costSource]).toEqual([2_800, "purchase-price"]);
    expect(a.onHand).toBe(18);
    expect(a.valueOre).toBe(50_400);
    expect(a.onOrderPacks).toBe(18); // 6 + 12 (utkast och makulerad räknas inte)
    expect(a.onOrderValueOre).toBe(54_000);
    expect(a.capitalTiedOre).toBe(104_400);
    expect(a.coverDays).toBe(9); // 18 pack / 2 per dag
    const b = v.titles.find((t) => t.titleId === "B")!;
    expect([b.unitCostOre, b.costSource, b.valueOre]).toEqual([1_500, "supplier-item", 6_000]);
    const e = v.titles.find((t) => t.titleId === "E")!;
    expect(e.valueOre).toBe(7_500);
    expect(v.titlesWithoutCost).toEqual(["D"]);
    expect(v.valueOre).toBe(63_900);
    expect(a.shareBp).toBe(7_887); // 50 400 / 63 900
    expect(v.capitalTiedOre).toBe(117_900);
    expect(a.evidence.figures.find((f) => f.key === "capitalTiedOre")!.value).toBe(104_400);
  });
});

// ---------------------------------------------------------------------------
// R9. Kedjan prognos → inköp
// ---------------------------------------------------------------------------
describe("R9 prognosen som efterfrågan i inköpen", () => {
  it("per titel, med summerad varians och hoppade dagar", () => {
    const orders = [
      ...dailyOrders("x", "t-a", "m-1", START, 98, 2),
      ...dailyOrders("y", "t-a", "m-2", START, 98, 1),
    ];
    const f = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    const d = demandFromForecast(f, "2026-11-03");
    expect(d).toHaveLength(1);
    expect(d[0]!.dailyMilli).toHaveLength(26);
    expect(d[0]!.dailyMilli[0]).toBe(3_000);
    expect(d[0]!.dayVarianceMilli2).toBe(3_000_000);
  });
});
