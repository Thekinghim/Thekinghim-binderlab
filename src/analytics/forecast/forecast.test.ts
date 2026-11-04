import { describe, expect, it } from "vitest";
import { addDays, dayOfWeek, DomainError } from "@/domain";
import { accuracyMetrics, residualVariance } from "./backtest";
import { approxKr, isqrtRound, packs, packsOneDecimal, signedPacksOneDecimal } from "./common";
import { biasCorrectionBp, forecastSales, resolveForecastOptions } from "./forecast";
import { fitModel, predictDay, type DailyHistory } from "./model";
import { dailyOrders, lcg, machine, NO_TAX, ord } from "./test-fixtures";

const AS_OF = "2026-10-31"; // lördag
const START = addDays(AS_OF, -139); // 20 veckor historik

const MODEL = {
  historyWeeks: 8,
  weekdayPriorDays: 2,
  maxTrendBp: 3_000,
  trendMinDaysPerHalf: 7,
  trendMinUnits: 10,
};

/** Hårda mellanslag → vanliga, för att jämföra texter. */
const plain = (s: string): string => s.replace(/\u00a0/g, " ");

function history(units: number[], available?: boolean[], start = "2026-06-01"): DailyHistory {
  return { start, units, available: available ?? units.map(() => true) };
}

describe("hjälpfunktioner", () => {
  it("isqrtRound avrundar roten till närmaste heltal", () => {
    expect(isqrtRound(0n)).toBe(0n);
    expect(isqrtRound(1n)).toBe(1n);
    expect(isqrtRound(10n)).toBe(3n);
    expect(isqrtRound(12n)).toBe(3n);
    expect(isqrtRound(13n)).toBe(4n);
    expect(isqrtRound(84_000_000n)).toBe(9_165n);
    expect(isqrtRound(10n ** 30n)).toBe(10n ** 15n);
    expect(() => isqrtRound(-1n)).toThrow(DomainError);
  });

  it("formaterar pack och ungefärliga belopp", () => {
    expect(packs(41_600)).toBe("42");
    expect(packs(500)).toBe("1");
    expect(packsOneDecimal(1_450)).toBe("1,5");
    expect(packsOneDecimal(-250)).toBe("−0,3");
    expect(signedPacksOneDecimal(120)).toBe("+0,1");
    expect(signedPacksOneDecimal(0)).toBe("0,0");
    expect(plain(approxKr(318_740))).toBe("ca 3 200 kr");
    expect(plain(approxKr(73_500))).toBe("ca 740 kr");
    expect(plain(approxKr(4_949))).toBe("ca 49 kr");
  });

  it("kontrollerar inställningarna", () => {
    expect(resolveForecastOptions().zMilli).toBe(1_282);
    expect(resolveForecastOptions({ intervalCoverageBp: 9_500 }).zMilli).toBe(1_960);
    expect(() => resolveForecastOptions({ intervalCoverageBp: 7_000 })).toThrow(DomainError);
    expect(() => resolveForecastOptions({ historyWeeks: 0 })).toThrow(DomainError);
    expect(() => resolveForecastOptions({ horizonDays: 1.5 })).toThrow(DomainError);
  });
});

describe("modellen", () => {
  it("jämn försäljning: nivå = takten, faktorer 1,0, ingen trend", () => {
    const h = history(new Array(56).fill(3));
    const c = fitModel(h, 55, MODEL)!;
    expect(c.levelMilli).toBe(3_000);
    expect(c.weekdayFactorsBp).toEqual(new Array(7).fill(10_000));
    expect(c.trendApplied).toBe(true);
    expect(c.trendMilliPerWeek).toBe(0);
    expect(c.availableDays).toBe(56);
    expect(c.excludedDays).toBe(0);
    expect(c.weeks.map((w) => w.weight)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Viktade medelpunkten: 8,5 − Σk²/Σk = 8,5 − 204/36 = 17/6 veckor.
    expect(c.levelLagWeeks.num / c.levelLagWeeks.den).toBeCloseTo(17 / 6, 10);
    expect(predictDay(c, 1, 3_000).unitsMilli).toBe(3_000);
  });

  it("veckodagsfaktorer summerar till 70 000 och fångar helgen (utan krympning exakt)", () => {
    // 2026-06-01 är en måndag; lördagar (index 5) säljer 6, övriga 2.
    const units = Array.from({ length: 56 }, (_, i) => (i % 7 === 5 ? 6 : 2));
    const c = fitModel(history(units), 55, { ...MODEL, weekdayPriorDays: 0 })!;
    expect(c.weekdayFactorsBp.reduce((a, b) => a + b, 0)).toBe(70_000);
    // 6 / (18/7) = 2,333… → 23 333; 2 / (18/7) = 0,777… → 7 778 (största rest får öret).
    expect(c.weekdayFactorsBp[5]).toBe(23_333);
    expect(c.weekdayFactorsBp[0]).toBe(7_778);
    // Nivån är veckodagsjusterad: 18 pack / 7 faktordagar = 2,571.
    expect(c.levelMilli).toBe(2_571);
    expect(predictDay(c, 6, 3_000).weekday).toBe(6);
    expect(predictDay(c, 6, 3_000).unitsMilli).toBe(5_999);
    expect(predictDay(c, 1, 3_000).unitsMilli).toBe(2_000);
  });

  it("krympningen drar faktorerna mot 1,0", () => {
    const units = Array.from({ length: 56 }, (_, i) => (i % 7 === 5 ? 6 : 2));
    const shrunk = fitModel(history(units), 55, MODEL)!;
    // (48 + 2 × 18/7) / 10 = 5,314 mot snittet 18/7 → 2,067.
    expect(shrunk.weekdayFactorsBp[5]).toBe(20_667);
    expect(shrunk.weekdayFactorsBp.reduce((a, b) => a + b, 0)).toBe(70_000);
  });

  it("veckodagsjusterad nivå: en vecka med bara helgdagar jämförs med helgens faktor", () => {
    const units = Array.from({ length: 56 }, (_, i) => (i % 7 >= 5 ? 4 : 2));
    const available = units.map((_, i) => i < 49 || i % 7 >= 5); // sista veckan bara helg
    const c = fitModel(history(units, available), 55, { ...MODEL, weekdayPriorDays: 0 })!;
    // Takten är densamma varje vecka efter justering: 18/7 ≈ 2,571 (4+4+5×2 = 18 per vecka).
    expect(c.levelMilli).toBe(2_571);
    expect(c.excludedDays).toBe(5);
  });

  it("trend: en vecka i taget högre ger +1 pack/dag per vecka och träffar nästa veckas takt", () => {
    // Vecka k (1–8) säljer 21 + k per dag; nästa vecka 30.
    const units = Array.from({ length: 56 }, (_, i) => 22 + Math.floor(i / 7));
    const c = fitModel(history(units), 55, MODEL)!;
    expect(c.trendApplied).toBe(true);
    expect(c.trendMilliPerWeek).toBe(1_000);
    // Nivå = 21 + Σk²/Σk = 21 + 204/36 = 26,667.
    expect(c.levelMilli).toBe(26_667);
    const p = predictDay(c, 4, 10_000); // mitt i nästa vecka
    expect(p.unitsMilli).toBe(30_000);
    expect(p.trendMilli).toBe(3_333);
  });

  it("trenden begränsas till ±maxTrendBp av nivån och prognosen blir aldrig negativ", () => {
    const units = Array.from({ length: 56 }, (_, i) => 22 + Math.floor(i / 7));
    const c = fitModel(history(units), 55, MODEL)!;
    // +1 pack/dag per vecka: 26 667 + 1 000 × (17/6 + 55/14) = 33 429, under taket 34 667.
    expect(predictDay(c, 28, 3_000).baseMilli).toBe(33_429);
    // +3 pack/dag per vecka: nivå 36 000, utan tak 56 286; taket är 36 000 × 1,3 = 46 800.
    const steep = Array.from({ length: 56 }, (_, i) => 22 + 3 * Math.floor(i / 7));
    const cs = fitModel(history(steep), 55, MODEL)!;
    expect(cs.levelMilli).toBe(36_000);
    expect(cs.trendMilliPerWeek).toBe(3_000);
    expect(predictDay(cs, 28, 3_000).baseMilli).toBe(46_800);
    expect(predictDay(cs, 28, 10_000).baseMilli).toBe(56_286);
    const down = Array.from({ length: 56 }, (_, i) => Math.max(0, 16 - 2 * Math.floor(i / 7)));
    const d = fitModel(history(down), 55, MODEL)!;
    expect(d.trendMilliPerWeek).toBeLessThan(0);
    expect(predictDay(d, 28, 10_000).baseMilli).toBe(0);
  });

  it("trenden räknas inte vid för lite data", () => {
    const units = new Array(56).fill(0);
    units[50] = 3;
    const c = fitModel(history(units), 55, MODEL)!;
    expect(c.trendApplied).toBe(false);
    expect(c.trendNote).toMatch(/färre än 10 sålda pack/);
    const avail = units.map((_, i) => i >= 30);
    const c2 = fitModel(history(new Array(56).fill(2), avail), 55, MODEL)!;
    expect(c2.trendApplied).toBe(false);
    expect(c2.trendNote).toMatch(/färre än 7 dagar/);
  });

  it("ingen dag med data ger null", () => {
    expect(fitModel(history([1, 1], [false, false]), 1, MODEL)).toBeNull();
    expect(fitModel(history([]), -1, MODEL)).toBeNull();
  });
});

describe("backtest och träffsäkerhet", () => {
  it("räknar WAPE, MAPE, bias och den enkla jämförelsen", () => {
    const m = accuracyMetrics(
      [
        { actualMilli: 1_000, forecastMilli: 1_500, naiveMilli: 1_000 },
        { actualMilli: 3_000, forecastMilli: 2_000, naiveMilli: 2_000 },
      ],
      [{ actualMilli: 4_000, forecastMilli: 3_500 }],
    );
    expect(m.wapeBp).toBe(3_750);
    expect(m.biasBp).toBe(-1_250);
    expect(m.naiveWapeBp).toBe(2_500);
    expect(m.mapeBp).toBe(1_250);
    expect(m.points).toBe(2);
  });

  it("utfall 0 ger null i stället för division med noll", () => {
    const m = accuracyMetrics(
      [{ actualMilli: 0, forecastMilli: 500, naiveMilli: 0 }],
      [{ actualMilli: 0, forecastMilli: 500 }],
    );
    expect(m.wapeBp).toBeNull();
    expect(m.mapeBp).toBeNull();
    expect(m.biasBp).toBeNull();
  });

  it("residualvariansen är snittet av kvadrerade fel", () => {
    expect(
      residualVariance([
        { actualMilli: 1_000, forecastMilli: 1_500 },
        { actualMilli: 3_000, forecastMilli: 2_000 },
      ]),
    ).toBe(625_000);
    expect(residualVariance([])).toBeNull();
  });
});

describe("forecastSales", () => {
  const constant = dailyOrders("a", "t-a", "m-1", START, 140, 3);

  it("jämn försäljning: 3 pack/dag i 4 veckor, Poisson-intervall, träffsäkerhet 0 %", () => {
    const r = forecastSales({ orders: constant, asOf: AS_OF, settings: NO_TAX });
    expect(r.horizon).toEqual({ start: "2026-11-01", end: "2026-11-28" });
    expect(r.series).toHaveLength(1);
    const s = r.series[0]!;
    expect(s.status).toBe("ok");
    expect(s.days).toHaveLength(28);
    expect(s.days.every((d) => d.unitsMilli === 3_000 && d.revenueOre === 14_700)).toBe(true);
    expect(s.total.unitsMilli).toBe(84_000);
    expect(s.total.revenueOre).toBe(411_600);
    expect(s.avgPriceOre).toBe(4_900);
    // Residualerna är 0 → Poisson-golv: 3 000 × 1 000 milli² per dag.
    expect(s.varianceSource).toBe("poisson");
    expect(s.dayVarianceMilli2).toBe(3_000_000);
    // √(28 × 3 000 000) = 9 165; × 1,282 = 11 750.
    expect(s.total.unitsLowMilli).toBe(84_000 - 11_750);
    expect(s.total.unitsHighMilli).toBe(84_000 + 11_750);
    // √(28 × 3 000 000 × 4 900²) = 44 909 240; × 1,282 / 1 000 000 = 57 574.
    expect(s.total.revenueLowOre).toBe(411_600 - 57_574);
    expect(s.weeks).toHaveLength(4);
    expect(s.weeks.reduce((a, w) => a + w.unitsMilli, 0)).toBe(84_000);
    expect(s.accuracy.wapeBp).toBe(0);
    expect(s.accuracy.biasBp).toBe(0);
    expect(s.accuracy.origins).toBe(6);
    expect(plain(s.text)).toBe(
      "t-a i m-1: ca 4 100 kr och ca 84 pack kommande 4 veckor (80 %-intervall: 72–96 pack).",
    );
    expect(plain(s.explanation)).toMatch(/^Nivå 3,0 pack\/dag \(viktat snitt av 8 veckor/);
    expect(s.evidence.titleIds).toEqual(["t-a"]);
    expect(s.evidence.machineIds).toEqual(["m-1"]);
    expect(s.evidence.period).toEqual({ start: "2026-09-06", end: AS_OF });
    expect(s.evidence.orderIds).toHaveLength(56 * 3);
    expect(plain(r.accuracy.text)).toMatch(
      /^Träffsäkerhet de senaste 6 veckorna: summan per dag missade i snitt 0 %/,
    );
  });

  it("intäkt räknas exklusive moms", () => {
    const r = forecastSales({
      orders: constant,
      asOf: AS_OF,
      settings: { vatRateBp: 2_500, cardFeeBp: 0 },
    });
    // 4 900 inkl. 25 % moms → 3 920 exkl.
    expect(r.series[0]!.avgPriceOre).toBe(3_920);
    expect(r.series[0]!.total.revenueOre).toBe(84 * 3_920);
  });

  it("slutsålda dagar räknas inte som efterfrågan 0", () => {
    // Slutsålt de 10 sista dagarna före asOf utom de två sista.
    const gapDates = Array.from({ length: 10 }, (_, i) => addDays(AS_OF, -11 + i));
    const gap = new Set(gapDates);
    const orders = constant.filter((o) => !gap.has(o.businessDate));
    const without = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    const withUnavail = forecastSales({
      orders,
      asOf: AS_OF,
      settings: NO_TAX,
      unavailable: gapDates.map((date) => ({ machineId: "m-1", titleId: "t-a", date })),
    });
    expect(without.series[0]!.components.levelMilli).toBeLessThan(2_500);
    expect(withUnavail.series[0]!.components.levelMilli).toBe(3_000);
    expect(withUnavail.series[0]!.components.excludedDays).toBe(10);
    expect(withUnavail.series[0]!.evidence.dates).toEqual(gapDates);
    expect(plain(withUnavail.series[0]!.explanation)).toMatch(/10 dagar utan data räknades inte/);
  });

  it("veckodagar och trend syns i prognosen och komponenterna förklarar den", () => {
    const orders = dailyOrders("w", "t-a", "m-1", START, 140, (_d, date) =>
      dayOfWeek(date) === 6 ? 6 : 2,
    );
    const r = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    const s = r.series[0]!;
    const saturday = s.days.find((d) => d.weekday === 6)!;
    const monday = s.days.find((d) => d.weekday === 1)!;
    expect(saturday.unitsMilli).toBeGreaterThan(2 * monday.unitsMilli);
    expect(plain(s.explanation)).toMatch(
      /ingen tydlig trend, starkast lördag \(2,1×\), svagast \p{L}+ \(0,8×\)/u,
    );
    // Veckosumman är densamma som historiken: 18 pack per vecka.
    expect(s.weeks[0]!.unitsMilli).toBeGreaterThanOrEqual(17_990);
    expect(s.weeks[0]!.unitsMilli).toBeLessThanOrEqual(18_010);
  });

  it("automat som slutar inom horisonten får 0 efter sista dagen; slutad automat ingen prognos", () => {
    const r = forecastSales({
      orders: constant,
      asOf: AS_OF,
      settings: NO_TAX,
      machines: [machine("m-1", null, "2026-11-10")],
    });
    const s = r.series[0]!;
    expect(s.days.filter((d) => d.unitsMilli > 0)).toHaveLength(10);
    expect(s.total.unitsMilli).toBe(30_000);
    const stopped = forecastSales({
      orders: constant,
      asOf: AS_OF,
      settings: NO_TAX,
      machines: [machine("m-1", null, AS_OF)],
    });
    expect(stopped.series).toHaveLength(0);
  });

  it("ny serie får status low-data; serie utan försäljning i historiken tas inte med", () => {
    const fresh = dailyOrders("n", "t-n", "m-1", addDays(AS_OF, -9), 10, 1);
    const old = dailyOrders("o", "t-o", "m-1", START, 20, 1);
    const r = forecastSales({
      orders: [...fresh, ...old, ord("x", "t-a", null, AS_OF)],
      asOf: AS_OF,
      settings: NO_TAX,
    });
    expect(r.series.map((s) => s.titleId)).toEqual(["t-n"]);
    expect(r.series[0]!.status).toBe("low-data");
    expect(r.series[0]!.components.levelMilli).toBe(1_000);
    expect(r.ordersWithoutMachine).toBe(1);
  });

  it("order efter asOf räknas inte", () => {
    const later = dailyOrders("l", "t-a", "m-1", "2026-11-01", 5, 50);
    const a = forecastSales({ orders: constant, asOf: AS_OF, settings: NO_TAX });
    const b = forecastSales({ orders: [...constant, ...later], asOf: AS_OF, settings: NO_TAX });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("brus ger residualvarians och intervall som täcker utfallet de flesta veckor", () => {
    const rnd = lcg(7);
    const orders = dailyOrders("r", "t-a", "m-1", START, 140, () => Math.floor(rnd() * 7));
    const r = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    const s = r.series[0]!;
    expect(s.varianceSource).toBe("residuals");
    expect(s.total.unitsHighMilli - s.total.unitsLowMilli).toBeGreaterThan(0);
    expect(s.accuracy.wapeBp).toBeGreaterThan(0);
    expect(s.accuracy.naiveWapeBp).not.toBeNull();
  });

  it("summorna per titel, automat och totalt är exakt summan av serierna", () => {
    const orders = [
      ...constant,
      ...dailyOrders("b", "t-b", "m-1", START, 140, (d) => (d % 3 === 0 ? 2 : 1), 5_900),
      ...dailyOrders("c", "t-a", "m-2", START, 140, (d) => d % 2, 4_900),
    ];
    const r = forecastSales({
      orders,
      asOf: AS_OF,
      settings: NO_TAX,
      titles: [
        { id: "t-a", name: "Pokémon 151" },
        { id: "t-b", name: "30th Celebration" },
      ],
      machines: [machine("m-1"), machine("m-2")],
    });
    expect(r.series).toHaveLength(3);
    const sum = (f: (s: (typeof r.series)[number]) => number) =>
      r.series.reduce((a, s) => a + f(s), 0);
    expect(r.total.total.unitsMilli).toBe(sum((s) => s.total.unitsMilli));
    expect(r.total.total.revenueOre).toBe(sum((s) => s.total.revenueOre));
    expect(r.byTitle.reduce((a, t) => a + t.total.revenueOre, 0)).toBe(r.total.total.revenueOre);
    expect(r.byMachine.reduce((a, t) => a + t.total.unitsMilli, 0)).toBe(r.total.total.unitsMilli);
    const ta = r.byTitle.find((t) => t.key === "t-a")!;
    expect(ta.seriesKeys).toHaveLength(2);
    expect(plain(ta.text)).toMatch(
      /^Pokémon 151: ca [\d ]+ kr och ca \d+ pack kommande 4 veckor i 2 automater/,
    );
    // Intervallet för summan är smalare än summan av seriernas intervall (oberoende).
    const widths = r.series.reduce((a, s) => a + (s.total.unitsHighMilli - s.total.unitsMilli), 0);
    expect(r.total.total.unitsHighMilli - r.total.total.unitsMilli).toBeLessThan(widths);
    expect(plain(r.total.text)).toMatch(/^Prognos kommande 4 veckor \(1–28 nov\.\): ca /);
    expect(r.accuracy.total.points).toBeGreaterThan(0);
    expect(r.accuracy.evidence.machineIds).toEqual(["m-1", "m-2"]);
  });

  it("resultatet beror inte på ordernas ordning", () => {
    const orders = [
      ...constant,
      ...dailyOrders("b", "t-b", "m-2", START, 140, (d) => (d % 4 === 0 ? 3 : 1)),
    ];
    const a = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    const b = forecastSales({ orders: [...orders].reverse(), asOf: AS_OF, settings: NO_TAX });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("horisont som inte är hela veckor och annan täckning", () => {
    const r = forecastSales({
      orders: constant,
      asOf: AS_OF,
      settings: NO_TAX,
      options: { horizonDays: 10, intervalCoverageBp: 9_500 },
    });
    const s = r.series[0]!;
    expect(s.weeks.map((w) => w.days)).toEqual([7, 3]);
    expect(plain(s.text)).toMatch(/kommande 10 dagar \(95 %-intervall/);
  });

  it("ogiltigt datum ger DomainError", () => {
    expect(() => forecastSales({ orders: [], asOf: "2026-02-30", settings: NO_TAX })).toThrow(
      DomainError,
    );
  });
});

/**
 * Som produktionen 4 nov.: automaten startade 14 okt. med en startpuckel (10 pack per dag
 * första veckorna) och säljer nu 6 per dag. Prognosen låg för högt i testveckorna.
 */
describe("forecastSales: utgår och korrigering för överskattning", () => {
  const launch = (d: number) => (d < 14 ? 10 : 6);
  const orders = [
    ...dailyOrders("a", "t-a", "m-1", "2026-10-14", 21, launch),
    ...dailyOrders("b", "t-b", "m-1", "2026-10-14", 21, 2),
  ];
  const base = { orders, asOf: "2026-11-03", settings: NO_TAX, machines: [machine("m-1")] };

  it("en serie som gått ur automaten får ingen prognos", () => {
    const all = forecastSales(base);
    const res = forecastSales({ ...base, excludeSeries: [{ machineId: "m-1", titleId: "t-b" }] });
    expect(all.series.map((x) => x.titleId)).toEqual(["t-a", "t-b"]);
    expect(res.series.map((x) => x.titleId)).toEqual(["t-a"]);
    expect(res.total.total.unitsMilli).toBeLessThan(all.total.total.unitsMilli);
  });

  it("utan korrigering ligger prognosen över senaste veckans takt", () => {
    const res = forecastSales({ ...base, excludeSeries: [{ machineId: "m-1", titleId: "t-b" }] });
    // Senaste veckan: 6 per dag = 42 per vecka; prognosen bär med sig startpuckeln.
    expect(res.total.weeks[0]!.unitsMilli).toBeGreaterThan(48_000);
    expect(res.correction.factorBp).toBe(10_000);
    expect(res.correction.biasBp).toBeGreaterThan(0);
  });

  it("med biasCorrection sänks prognosen med utfall / prognos i testveckorna, högst 30 %", () => {
    const raw = forecastSales({ ...base, excludeSeries: [{ machineId: "m-1", titleId: "t-b" }] });
    const res = forecastSales({
      ...base,
      excludeSeries: [{ machineId: "m-1", titleId: "t-b" }],
      options: { biasCorrection: true },
    });
    const f = res.correction.factorBp;
    expect(f).toBeLessThan(10_000);
    expect(f).toBeGreaterThanOrEqual(7_000);
    // faktor = 1 / (1 + bias)
    expect(Math.abs(f - Math.round(100_000_000 / (10_000 + res.correction.biasBp!)))).toBeLessThan(
      3,
    );
    const week = res.total.weeks[0]!.unitsMilli;
    expect(Math.abs(week - Math.round((raw.total.weeks[0]!.unitsMilli * f) / 10_000))).toBeLessThan(
      10,
    );
    expect(week).toBeLessThan(raw.total.weeks[0]!.unitsMilli);
    expect(res.series[0]!.evidence.figures.some((x) => x.key === "biasCorrectionBp")).toBe(true);
  });

  it("biasCorrectionBp: skalar aldrig upp och kräver två testveckor", () => {
    const o = (origin: string, a: number, f: number) => ({
      origin,
      actualMilli: a,
      forecastMilli: f,
    });
    expect(
      biasCorrectionBp([o("2026-10-27", 100_000, 80_000), o("2026-10-20", 100_000, 90_000)], true)
        .factorBp,
    ).toBe(10_000);
    expect(biasCorrectionBp([o("2026-10-27", 100_000, 160_000)], true).factorBp).toBe(10_000);
    expect(
      biasCorrectionBp(
        [o("2026-10-27", 129_000, 208_000), o("2026-10-20", 179_000, 163_000)],
        true,
      ),
    ).toEqual({ factorBp: Math.round((308_000 * 10_000) / 371_000), biasBp: 2_045, origins: 2 });
    expect(
      biasCorrectionBp([o("2026-10-27", 100_000, 300_000), o("2026-10-20", 100_000, 300_000)], true)
        .factorBp,
    ).toBe(7_000);
    expect(
      biasCorrectionBp(
        [o("2026-10-27", 129_000, 208_000), o("2026-10-20", 179_000, 163_000)],
        false,
      ).factorBp,
    ).toBe(10_000);
  });
});
