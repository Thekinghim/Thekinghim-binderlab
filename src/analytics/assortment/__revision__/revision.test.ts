/**
 * Oberoende revision av FAS 11 (marknad): releaser, marknadspriser, sortiment och prissättning.
 *
 * Alla förväntade värden är räknade för hand (se kommentarerna) från specifikationen, inte
 * från koden. Inga avgifter: moms 0, kortavgift 0, provision 10 % i alla butiker, så att
 * bidrag per pack = belopp − inköp − belopp / 10.
 */

import { describe, expect, it } from "vitest";
import { addDays, type EconomicsSources, type IsoDate, type OrderLine } from "@/domain";
import type { MachineRef } from "../../todos/types";
import {
  detectPriceChanges,
  flagPurchaseAnomalies,
  priceChangeEffect,
  proposePriceTests,
  purchasePriceTrends,
  type PurchaseRecord,
} from "../../pricing";
import {
  releaseCurve,
  releaseOutcome,
  releaseProfiles,
  suggestReleasePurchase,
} from "../../releases";
import { assortmentFollowUp, recommendAssortment, type SlotAssignment } from "..";

// ---------------------------------------------------------------------------
// Egen testdata (oberoende av byggagentens fixtures)
// ---------------------------------------------------------------------------

function src(prices: Record<string, number>): EconomicsSources {
  const ids = [1, 2, 3, 4, 5];
  return {
    settings: { vatRateBp: 0, cardFeeBp: 0 },
    prices: Object.entries(prices).map(([titleId, unitCostOre]) => ({
      titleId,
      unitCostOre,
      validFrom: "2025-01-01",
    })),
    placements: ids.map((i) => ({
      machineId: `m-${i}`,
      storeId: `s-${i}`,
      from: "2025-01-01",
      to: null,
    })),
    agreements: ids.map((i) => ({
      storeId: `s-${i}`,
      validFrom: "2025-01-01",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: null,
    })),
  };
}

function m(id: string, activeFrom: IsoDate | null = null): MachineRef {
  return { id, name: `Automat ${id.slice(2)}`, activeFrom, activeTo: null };
}

let seq = 0;
/** n order samma dag. */
function burst(
  titleId: string,
  machineId: string | null,
  date: IsoDate,
  n: number,
  amountOre = 4_900,
): OrderLine[] {
  const out: OrderLine[] = [];
  for (let i = 0; i < n; i++) {
    const id = `o-${String(++seq).padStart(6, "0")}`;
    out.push({ id, externalId: id, titleId, machineId, businessDate: date, amountOre });
  }
  return out;
}
/** perDay(d) order per dag i `days` dagar från `start`. */
function span(
  titleId: string,
  machineId: string | null,
  start: IsoDate,
  days: number,
  perDay: number | ((d: number) => number),
  amountOre = 4_900,
): OrderLine[] {
  const out: OrderLine[] = [];
  for (let d = 0; d < days; d++) {
    const n = typeof perDay === "number" ? perDay : perDay(d);
    out.push(...burst(titleId, machineId, addDays(start, d), n, amountOre));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Releaser: förslag före släpp
// ---------------------------------------------------------------------------

describe("Revision 1 – inköpsförslag före släpp (median per automat, typisk automat, lådor)", () => {
  // Horisont 7 dagar. m-1…m-3 i drift sedan 2026-01-01, m-4 ny 2026-09-01 (ingen historik).
  // R1 (S&V, 1 mars): m-1 10, m-2 4, m-3 0. R2 (S&V, 1 maj): m-1 14, m-2 6, m-3 2.
  // R3 (annan serie, 1 juli): 100 per automat – ska inte påverka (2 släpp i serien finns).
  const machines = [
    m("m-1", "2026-01-01"),
    m("m-2", "2026-01-01"),
    m("m-3", "2026-01-01"),
    m("m-4", "2026-09-01"),
  ];
  const orders = [
    ...burst("r1", "m-1", "2026-03-01", 6),
    ...burst("r1", "m-1", "2026-03-04", 4),
    ...burst("r1", "m-2", "2026-03-02", 4),
    ...burst("r1", "m-1", "2026-03-08", 50), // dag 8: utanför horisonten
    ...burst("r2", "m-1", "2026-05-01", 14),
    ...burst("r2", "m-2", "2026-05-03", 6),
    ...burst("r2", "m-3", "2026-05-07", 2),
    ...burst("r3", "m-1", "2026-07-01", 100),
    ...burst("r3", "m-2", "2026-07-01", 100),
    ...burst("r3", "m-3", "2026-07-01", 100),
  ];
  const releases = [
    { titleId: "r1", series: "Scarlet & Violet", releaseDate: "2026-03-01" },
    { titleId: "r2", series: "Scarlet & Violet", releaseDate: "2026-05-01" },
    { titleId: "r3", series: "Sword & Shield", releaseDate: "2026-07-01" },
  ];
  const base = {
    orders,
    releases,
    machines,
    asOf: "2026-11-01",
    horizonDays: 7,
    newRelease: { titleId: "new", series: "  scarlet &  violet ", releaseDate: "2026-11-10" },
  };

  it("median per automat, typisk automat för ny automat, tak, lådor och lager", () => {
    // Pool (serien): 10, 4, 0, 14, 6, 2 → sorterat 0 2 4 6 10 14 → typisk = (4 + 6) / 2 = 5.
    // m-1 median(10, 14) = 12; m-2 median(4, 6) = 5; m-3 median(0, 2) = 1; m-4 typisk 5.
    // Σ = 23 → 23 pack. Lager 3 → behov 20 → lådor à 6: tak(20/6) = 4 → 24 pack; kvar 3 + 24 − 23 = 4.
    const s = suggestReleasePurchase({ ...base, onHandUnits: 3, boxSize: 6 });
    expect(s.status).toBe("ok");
    expect(s.basis).toBe("series");
    expect(s.comparableTitleIds).toEqual(["r1", "r2"]);
    expect(s.typicalUnitsPerMachineTenths).toBe(50);
    expect(s.allocations.map((a) => [a.machineId, a.units, a.source])).toEqual([
      ["m-1", 12, "history"],
      ["m-2", 5, "history"],
      ["m-3", 1, "history"],
      ["m-4", 5, "typical"],
    ]);
    expect(s.machineUnits).toBe(23);
    expect(s.boxes).toBe(4);
    expect(s.purchaseUnits).toBe(24);
    expect(s.warehouseUnits).toBe(4);
    // Underlag: order från r1 (bara de 14 inom horisonten) och r2, inte r3.
    expect(s.evidence.orderIds).toHaveLength(14 + 22);
    expect(s.evidence.titleIds).toEqual(["new", "r1", "r2"]);
    expect(s.evidence.machineIds).toEqual(["m-1", "m-2", "m-3", "m-4"]);
    expect(s.text).toContain("24");
  });

  it("antagande 120 %: tak(27,6) = 28 fördelat med största resten; minsta beställning", () => {
    // 14,4 / 6 / 1,2 / 6 = 27,6 → 28. 28 × 14,4/27,6 = 14,609 → 14 (rest ,609); 6,087 → 6 (,087);
    // 1,217 → 1 (,217); 6,087 → 6 (,087). 27 utdelat, 1 kvar → m-1 (störst rest) → 15, 6, 1, 6.
    // Lager 0, minsta beställning 40 → köp 40, kvar 12.
    const s = suggestReleasePurchase({ ...base, scaleBp: 12_000, minOrderQty: 40 });
    expect(s.allocations.map((a) => a.units)).toEqual([15, 6, 1, 6]);
    expect(s.allocations.map((a) => a.expectedTenths)).toEqual([144, 60, 12, 60]);
    expect(s.machineUnits).toBe(28);
    expect(s.purchaseUnits).toBe(40);
    expect(s.warehouseUnits).toBe(12);
    expect(s.text).toContain("120");
  });

  it("färre än 2 släpp i serien → jämför mot alla släpp", () => {
    // Bara r3 i Sword & Shield → alla tre släppen. m-1: median(10, 14, 100) = 14.
    const s = suggestReleasePurchase({
      ...base,
      newRelease: { titleId: "new", series: "Sword & Shield", releaseDate: "2026-11-10" },
    });
    expect(s.basis).toBe("all");
    expect(s.allocations[0]).toMatchObject({ machineId: "m-1", units: 14 });
  });

  it("ingen historik → inget förslag men underlag", () => {
    const s = suggestReleasePurchase({ ...base, orders: [], releases: [] });
    expect(s.status).toBe("no-history");
    expect(s.purchaseUnits).toBe(0);
    expect(s.evidence.titleIds).toEqual(["new"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Releaser: normaliserad kurva och utfall efter släpp
// ---------------------------------------------------------------------------

describe("Revision 2 – släppkurva (lika vikt) och utfall mot förslag (±20 %, slutsålt)", () => {
  // H = 14. A: 6 dag 0, 4 dag 7 (60 % vecka 1). B: 20 dag 0, 80 dag 10 (20 % vecka 1).
  // Lika vikt: vecka 1 = (60 + 20) / 2 = 40 %, vecka 2 = 60 %. Dag 9: (100 + 20) / 2 = 60 %.
  // C släpps 25 okt och är inte komplett 1 nov → ingår inte.
  const orders = [
    ...burst("a", "m-1", "2026-01-05", 6),
    ...burst("a", "m-1", "2026-01-12", 4),
    ...burst("b", "m-1", "2026-02-02", 20),
    ...burst("b", "m-1", "2026-02-12", 80),
    ...burst("c", "m-1", "2026-10-25", 3),
  ];
  const profiles = releaseProfiles({
    orders,
    releases: [{ titleId: "a" }, { titleId: "b" }, { titleId: "c" }],
    machines: [m("m-1")],
    asOf: "2026-11-01",
    horizonDays: 14,
  });
  const curve = releaseCurve(profiles, 14)!;

  it("kurvan: varje släpp väger lika, sista dagen 10 000, veckor summerar till 10 000", () => {
    expect(profiles.find((p) => p.titleId === "c")!.complete).toBe(false);
    expect(curve.titleIds).toEqual(["a", "b"]);
    expect(curve.cumulativeBp[6]).toBe(4_000);
    expect(curve.cumulativeBp[9]).toBe(6_000);
    expect(curve.cumulativeBp[13]).toBe(10_000);
    expect(curve.weeklyBp).toEqual([4_000, 6_000]);
    expect(curve.evidence.orderIds).toHaveLength(110);
    expect(curve.text).toContain("40");
  });

  it("utfall efter 7 dagar: väntat = förslag × 40 %, gränsen 20 % är inkluderande", () => {
    // Släpp 20 okt, asOf 26 okt → e = 7, andel 4 000 bp.
    // m-1 10 → väntat 4, sålt 5 → +25 % före. m-2 10 → väntat 4, sålt 10 → slutsålt 22 okt.
    // m-3 10 → väntat 4, sålt 3 → −25 % efter. m-4 25 → väntat 10, sålt 12 → +20 % = i linje.
    // m-5 (inget förslag) 1. Totalt 31 mot 55 × 0,4 = 22 → 9/22 = 4 091 bp.
    const o = [
      ...burst("n", "m-1", "2026-10-19", 2), // före släppet
      ...burst("n", "m-1", "2026-10-21", 5),
      ...burst("n", "m-2", "2026-10-20", 5),
      ...burst("n", "m-2", "2026-10-22", 5),
      ...burst("n", "m-3", "2026-10-24", 3),
      ...burst("n", "m-4", "2026-10-25", 12), // sommartid slutar denna dag
      ...burst("n", "m-5", "2026-10-26", 1),
      ...burst("n", "m-1", "2026-10-27", 9), // efter asOf
    ];
    const r = releaseOutcome({
      orders: o,
      titleId: "n",
      releaseDate: "2026-10-20",
      asOf: "2026-10-26",
      horizonDays: 14,
      curveCumulativeBp: curve.cumulativeBp,
      allocations: [
        { machineId: "m-1", units: 10 },
        { machineId: "m-2", units: 10 },
        { machineId: "m-3", units: 10 },
        { machineId: "m-4", units: 25 },
      ],
    });
    expect(r.status).toBe("running");
    expect(r.elapsedDays).toBe(7);
    expect(
      r.machines.map((x) => [x.machineId, x.expectedByNowTenths, x.actual, x.diffBp, x.pace]),
    ).toEqual([
      ["m-1", 40, 5, 2_500, "ahead"],
      ["m-2", 40, 10, 15_000, "ahead"],
      ["m-3", 40, 3, -2_500, "behind"],
      ["m-4", 100, 12, 2_000, "on-track"],
    ]);
    expect(r.machines[1]).toMatchObject({ soldOut: true, soldOutDate: "2026-10-22" });
    expect(r.unplanned).toEqual([{ machineId: "m-5", actual: 1 }]);
    expect(r.expectedByNowTenths).toBe(220);
    expect(r.actual).toBe(31);
    expect(r.diffBp).toBe(4_091);
    expect(r.evidence.orderIds).toHaveLength(31);
    expect(r.evidence.period).toEqual({ start: "2026-10-20", end: "2026-10-26" });
    expect(r.evidence.dates).toContain("2026-10-22");
  });
});

// ---------------------------------------------------------------------------
// 3. Marknadspriser: utveckling per titel och leverantör, median + MAD
// ---------------------------------------------------------------------------

describe("Revision 3 – inköpspriser: trend, leverantörer och robusta flaggor", () => {
  const p = (
    id: string,
    titleId: string,
    supplierId: string,
    date: IsoDate,
    unitCostOre: number,
    quantity = 10,
  ): PurchaseRecord => ({ id, titleId, supplierId, date, unitCostOre, quantity });
  const purchases = [
    p("p1", "t-p", "A", "2026-01-10", 2_800),
    p("p2", "t-p", "B", "2026-02-10", 2_900),
    p("p3", "t-p", "A", "2026-03-10", 2_900, 20),
    p("p4", "t-p", "B", "2026-04-10", 3_000),
    p("p5", "t-p", "A", "2026-05-10", 2_850),
    p("p6", "t-p", "B", "2026-06-10", 3_200),
    p("p7", "t-p", "A", "2026-07-10", 3_050),
    p("p8", "t-p", "A", "2026-08-10", 2_300, 5),
    // MAD = 0: fem à 20,00 kr, sedan 20,90 (4,5 %, ej flagga) och 21,00 (5 %, flagga).
    ...[1, 2, 3, 4, 5].map((i) => p(`q${i}`, "t-q", "A", `2026-0${i}-01`, 2_000)),
    p("q6", "t-q", "A", "2026-06-01", 2_090),
    p("q7", "t-q", "A", "2026-07-01", 2_100),
    // För lite historik: 4 inköp, sedan dubbla priset.
    ...[1, 2, 3, 4].map((i) => p(`r${i}`, "t-r", "A", `2026-0${i}-01`, 2_000)),
    p("r5", "t-r", "A", "2026-05-01", 4_000),
    // Historik äldre än 365 dagar räknas inte.
    ...[1, 2, 3, 4, 5].map((i) => p(`s${i}`, "t-s", "A", `2025-0${i}-01`, 2_000)),
    p("s6", "t-s", "A", "2026-06-01", 4_000),
  ];

  it("trend: median per inköp, viktat snitt, månadsförändring, billigast leverantör", () => {
    const t = purchasePriceTrends({ purchases }).find((x) => x.titleId === "t-p")!;
    // Sorterat 2300 2800 2850 2900 2900 3000 3050 3200 → median 2 900.
    expect(t.medianOre).toBe(2_900);
    // Σ pris × antal = 247 500, Σ antal = 85 → 2 911,76 → 2 912.
    expect(t.weightedAverageOre).toBe(2_912);
    // Januari 2 800 → augusti 2 300: −500/2 800 = −17,857 % → −1 786 bp.
    expect(t.changeBp).toBe(-1_786);
    // A: 2300 2800 2850 2900 3050 → 2 850 (−50/2 900 = −172 bp); B: 2900 3000 3200 → 3 000 (+345 bp).
    expect(t.suppliers.map((s) => [s.supplierId, s.medianOre, s.vsTitleMedianBp])).toEqual([
      ["A", 2_850, -172],
      ["B", 3_000, 345],
    ]);
    expect(t.evidence.purchaseIds).toHaveLength(8);
  });

  it("flaggor: |robust z| > 3,5 och ≥ 5 %, MAD 0, minst 5 tidigare, 365 dagar", () => {
    const flags = flagPurchaseAnomalies({ purchases });
    expect(flags.map((f) => f.purchaseId)).toEqual(["p6", "q7", "p8"]);
    // p6: historik 2800 2850 2900 2900 3000 → median 2 900, |avv.| 0 0 50 100 100 → MAD 50.
    // z = 0,6745 × 300 / 50 = 4,047 → 405; +300/2 900 = 1 034 bp; 10 pack × 300 = 3 000 öre.
    const p6 = flags[0]!;
    expect(p6).toMatchObject({
      direction: "expensive",
      medianOre: 2_900,
      madOre: 50,
      robustZHundredths: 405,
      deviationBp: 1_034,
      impactOre: 3_000,
      historyCount: 5,
    });
    expect(p6.evidence.purchaseIds).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    // p7 (3 050): median 2 900, MAD (50 + 100)/2 = 75, z = 1,35 → ingen flagga.
    // p8 (2 300): 7 tidigare, median 2 900, MAD 100, z = −4,047; −600/2 900 = −2 069 bp; 5 × −600.
    expect(flags[2]).toMatchObject({
      direction: "cheap",
      medianOre: 2_900,
      madOre: 100,
      robustZHundredths: -405,
      deviationBp: -2_069,
      impactOre: -3_000,
      historyCount: 7,
    });
    // q7: MAD 0, avvikelse exakt 5 % → flaggas, utan z.
    expect(flags[1]).toMatchObject({ robustZHundredths: null, deviationBp: 500, medianOre: 2_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. Prissättning: upptäckt och difference-in-differences med placebo
// ---------------------------------------------------------------------------

describe("Revision 4 – prisändring: upptäckt och enkel difference-in-differences", () => {
  // X: m-1 2/dag, m-2 1/dag à 49 kr 1–14 okt; 1/dag i båda à 59 kr 15–21 okt.
  // Y (jämförelse): m-1 2/dag hela tiden; m-2 2/dag 1–14 okt, 4/dag 15–21 okt.
  const orders = [
    ...span("t-x", "m-1", "2026-10-01", 14, 2),
    ...span("t-x", "m-2", "2026-10-01", 14, 1),
    ...span("t-x", "m-1", "2026-10-15", 7, 1, 5_900),
    ...span("t-x", "m-2", "2026-10-15", 7, 1, 5_900),
    ...span("t-y", "m-1", "2026-10-01", 21, 2),
    ...span("t-y", "m-2", "2026-10-01", 14, 2),
    ...span("t-y", "m-2", "2026-10-15", 7, 4),
    // Z: tvådagars kampanj är ingen prisändring.
    ...span("t-z", "m-1", "2026-10-01", 5, 1),
    ...span("t-z", "m-1", "2026-10-06", 2, 1, 5_900),
    ...span("t-z", "m-1", "2026-10-08", 5, 1),
  ];

  it("upptäckt: nytt pris tre försäljningsdagar i rad; tvådagarsavvikelse ignoreras", () => {
    const ev = detectPriceChanges(orders);
    expect(ev.map((e) => [e.titleId, e.date, e.fromOre, e.toOre, e.changeBp])).toEqual([
      ["t-x", "2026-10-15", 4_900, 5_900, 2_041],
    ]);
    expect(ev[0]!.evidence.dates).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
  });

  it("effekt: väntat 21 × 42/28 = 31,5, effekt −55,56 %, elasticitet −2,72, bidrag −295,75 kr/vecka", () => {
    // Före 8–14 okt: X 21, Y 28. Efter 15–21 okt: X 14, Y 42.
    // Placebo 1–7 mot 8–14 okt: X 21/21, Y 28/28 → 0. 24–30 sep saknar data → bara en placebo.
    // Bidrag före 4 900 − 2 000 − 490 = 2 410, efter 5 900 − 2 000 − 590 = 3 310.
    // (3 310 × 14 − 2 410 × 31,5) × 7/7 = 46 340 − 75 915 = −29 575.
    const r = priceChangeEffect({
      ...src({ "t-x": 2_000, "t-y": 2_000 }),
      orders,
      titleId: "t-x",
      changeDate: "2026-10-15",
      asOf: "2026-10-21",
      windowDays: 7,
      minUnits: 10,
      excludeTitleIds: ["t-z"],
    });
    expect(r).toMatchObject({
      control: "titles",
      windowDays: 7,
      before: { start: "2026-10-08", end: "2026-10-14" },
      after: { start: "2026-10-15", end: "2026-10-21" },
      unitsBefore: 21,
      unitsAfter: 14,
      controlUnitsBefore: 28,
      controlUnitsAfter: 42,
      expectedUnitsAfterTenths: 315,
      effectUnitsTenths: -175,
      effectBp: -5_556,
      priceChangeBp: 2_041,
      elasticityHundredths: -272,
      contributionPerPackBeforeOre: 2_410,
      contributionPerPackAfterOre: 3_310,
      contributionEffectPerWeekOre: -29_575,
      noiseBp: 0,
      verdict: "clear",
    });
    expect(r.placebos).toEqual([{ changeDate: "2026-10-08", effectBp: 0 }]);
    expect(r.evidence.orderIds).toHaveLength(35);
    expect(r.evidence.machineIds).toEqual(["m-1", "m-2"]);
  });

  it("under 30 pack i ett fönster (standard) → osäker", () => {
    const r = priceChangeEffect({
      ...src({ "t-x": 2_000, "t-y": 2_000 }),
      orders,
      titleId: "t-x",
      changeDate: "2026-10-15",
      asOf: "2026-10-21",
      windowDays: 7,
    });
    expect(r.verdict).toBe("uncertain");
    expect(r.reasons.join(" ")).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// 5. Prissättning: pristester som experiment
// ---------------------------------------------------------------------------

describe("Revision 5 – pristester: urval, riktning, brytpunkt och ABBA-fördelning", () => {
  // Underlag 1–28 okt. A: m-1 3, m-2 2, m-3 2, m-4 1 per dag = 224 pack.
  // B: m-1 2, m-2 1 per dag = 84 pack. C: bara m-1 → utesluts. D: bytte pris 9 sep (< 90 dagar).
  const orders = [
    ...span("t-a", "m-1", "2026-10-01", 28, 3),
    ...span("t-a", "m-2", "2026-10-01", 28, 2),
    ...span("t-a", "m-3", "2026-10-01", 28, 2),
    ...span("t-a", "m-4", "2026-10-01", 28, 1),
    ...span("t-b", "m-1", "2026-10-01", 28, 2),
    ...span("t-b", "m-2", "2026-10-01", 28, 1),
    ...span("t-c", "m-1", "2026-10-01", 28, 3),
    ...span("t-d", "m-1", "2026-08-01", 39, 2),
    ...span("t-d", "m-2", "2026-08-01", 39, 2),
    ...span("t-d", "m-1", "2026-09-09", 50, 2, 5_400),
    ...span("t-d", "m-2", "2026-09-09", 50, 2, 5_400),
  ];
  const props = proposePriceTests({
    ...src({ "t-a": 2_000, "t-b": 2_000, "t-c": 2_000, "t-d": 2_000 }),
    orders,
    asOf: "2026-10-28",
  });

  it("A (över median 154) höjs, B (under, bidrag 24,10 kr ≥ 10 kr) sänks; C och D utesluts", () => {
    expect(props.map((x) => [x.titleId, x.direction, x.experiment, x.label])).toEqual([
      ["t-a", "up", true, "Experiment"],
      ["t-b", "down", true, "Experiment"],
    ]);
  });

  it("A: 54 kr, bidrag 28,60 kr, brytpunkt −15,73 %, test m-1+m-4, kontroll m-2+m-3", () => {
    // 5 400 − 2 000 − 540 = 2 860; 2 410/2 860 − 1 = −0,15734 → −1 573 bp.
    // Sorterat: m-1 84, m-2 56, m-3 56, m-4 28 → T K K T.
    const a = props[0]!;
    expect(a).toMatchObject({
      fromOre: 4_900,
      toOre: 5_400,
      contributionPerPackOre: 2_410,
      newContributionPerPackOre: 2_860,
      breakEvenVolumeChangeBp: -1_573,
      testMachineIds: ["m-1", "m-4"],
      controlMachineIds: ["m-2", "m-3"],
      expectedTestUnits: 112,
      expectedControlUnits: 112,
      unitsPerWeekTenths: 560,
      weeklyContributionOre: 134_960,
      period: { start: "2026-10-29", end: "2026-11-25" },
      key: "price-test:t-a:up:2026-10-29",
    });
    expect(a.evaluation).toEqual({
      titleId: "t-a",
      changeDate: "2026-10-29",
      windowDays: 28,
      testMachineIds: ["m-1", "m-4"],
      controlMachineIds: ["m-2", "m-3"],
    });
    expect(a.evidence.orderIds).toHaveLength(224);
  });

  it("B: 44 kr, bidrag 19,60 kr, brytpunkt +22,96 %", () => {
    // 4 400 − 2 000 − 440 = 1 960; 2 410/1 960 − 1 = 0,229592 → 2 296 bp.
    expect(props[1]).toMatchObject({
      toOre: 4_400,
      newContributionPerPackOre: 1_960,
      breakEvenVolumeChangeBp: 2_296,
      testMachineIds: ["m-1"],
      controlMachineIds: ["m-2"],
      expectedTestUnits: 56,
      expectedControlUnits: 28,
      weeklyContributionOre: 50_610,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Sortiment: rekommendation per automat
// ---------------------------------------------------------------------------

describe("Revision 6 – sortiment: fack, liknande automat, effekt i kr/vecka och 'behåll'", () => {
  const OCT = { start: "2026-10-01", end: "2026-10-28" };
  const slot = (machineId: string, titleId: string, slots: number): SlotAssignment => ({
    machineId,
    titleId,
    slots,
    from: "2026-09-01",
    to: null,
  });
  // m-1 (4 fack): A 1 fack 2/dag (14/v), B 2 fack varannan dag (3,5/v), C 1 fack var 4:e dag (1,75/v).
  // m-2 (3 fack): D 2 fack 2/dag (14/v), A 1 fack 1/dag. Nivå m-2 = 84/84 = 1; m-1 = 77/112 = 0,6875.
  // Bidrag: A, B, D 2 410; C (inköp 35 kr) 4 900 − 3 500 − 490 = 910.
  const orders = [
    ...span("t-a", "m-1", OCT.start, 28, 2),
    ...span("t-b", "m-1", OCT.start, 28, (d) => (d % 2 === 0 ? 1 : 0)),
    ...span("t-c", "m-1", OCT.start, 28, (d) => (d % 4 === 0 ? 1 : 0)),
    ...span("t-d", "m-2", OCT.start, 28, 2),
    ...span("t-a", "m-2", OCT.start, 28, 1),
  ];
  const sources = src({ "t-a": 2_000, "t-b": 2_000, "t-c": 3_500, "t-d": 2_000 });

  it("girig fördelning: A 2, B 1, D 1 (ny via m-2), C bort; +312 kr/vecka (31 244 öre)", () => {
    // D här: 14 × 0,6875 / 1 = 9,625/v. Vinst per nästa fack:
    // 1) A 24 100, D 23 196,25, B 8 435, C 1 592,5 → A. 2) A 9 640, D 23 196,25 → D.
    // 3) A 9 640 → A. 4) A 0, D 0, B 8 435 → B. Nu: 24 100 + 8 435 + 1 592,5 = 34 127,5.
    // Föreslaget: 33 740 + 8 435 + 23 196,25 = 65 371,25 → effekt 31 243,75 → 31 244.
    const [r] = recommendAssortment({
      ...sources,
      orders,
      machines: [m("m-1"), m("m-2")],
      assignments: [
        slot("m-1", "t-a", 1),
        slot("m-1", "t-b", 2),
        slot("m-1", "t-c", 1),
        slot("m-2", "t-d", 2),
        slot("m-2", "t-a", 1),
      ],
      period: OCT,
      machineIds: ["m-1"],
      similarMachineIds: { "m-1": ["m-2"] },
    });
    expect(r!.action).toBe("change");
    expect(r!.capacity).toBe(4);
    expect(r!.freeSlots).toBe(0);
    expect(r!.effectPerWeekOre).toBe(31_244);
    expect(r!.fingerprint).toBe("t-a:2,t-b:1,t-d:1");
    expect(
      r!.changes.map((c) => [c.titleId, c.kind, c.fromSlots, c.toSlots, c.effectPerWeekOre]),
    ).toEqual([
      ["t-d", "add", 0, 1, 23_196],
      ["t-a", "increase", 1, 2, 9_640],
      ["t-b", "decrease", 2, 1, 0],
      ["t-c", "remove", 1, 0, -1_593],
    ]);
    const d = r!.lines.find((l) => l.titleId === "t-d")!;
    expect(d).toMatchObject({
      source: "similar",
      demandPerWeekTenths: 96,
      contributionPerPackOre: 2_410,
      basisMachineIds: ["m-2"],
    });
    expect(r!.lines.find((l) => l.titleId === "t-c")).toMatchObject({
      demandPerWeekTenths: 18,
      contributionPerPackOre: 910,
    });
    expect(r!.evidence.machineIds).toEqual(["m-1", "m-2"]);
    // Underlag: m-1:s 77 order + m-2:s 56 D-order.
    expect(r!.evidence.orderIds).toHaveLength(77 + 56);
    // signedKr avrundar till hela kronor i texten.
    expect(r!.text).toMatch(/väntad effekt \+312\skr\/vecka/);
  });

  // m-3 (3 fack): A 1 fack 11/v (44 pack), B 1 fack 0,25/v (1 pack), X 1 fack utan inköpspris.
  const keepInput = {
    ...sources,
    orders: [
      ...span("t-a", "m-3", OCT.start, 28, (d) => (d % 7 < 4 ? 2 : 1)),
      ...burst("t-b", "m-3", "2026-10-10", 1),
      ...span("t-x", "m-3", OCT.start, 28, 1),
    ],
    machines: [m("m-3")],
    assignments: [slot("m-3", "t-a", 1), slot("m-3", "t-b", 1), slot("m-3", "t-x", 1)],
    period: OCT,
    machineIds: ["m-3"],
    similarMachineIds: { "m-3": [] },
  };

  it("effekt under 20 kr/vecka → behåll; titel utan inköpspris låst", () => {
    // Bästa: A 2 fack (+2 410), B bort (−602,5) → 1 807,5 → 1 808 < 2 000.
    const [r] = recommendAssortment(keepInput);
    expect(r!.action).toBe("keep");
    expect(r!.effectPerWeekOre).toBe(0);
    expect(r!.potentialEffectPerWeekOre).toBe(1_808);
    expect(r!.changes).toEqual([]);
    expect(r!.lines.find((l) => l.titleId === "t-x")).toMatchObject({
      locked: "missing-price",
      recommendedSlots: 1,
    });
    expect(r!.text).toContain("saknar inköpspris");
  });

  it("konsistens: vid 'behåll' ska föreslagna fack vara de nuvarande", () => {
    // Revisionskrav: UI som visar rader/fingerprint ska inte visa en omfördelning som rådet inte är.
    const [r] = recommendAssortment(keepInput);
    for (const l of r!.lines) expect(l.recommendedSlots).toBe(l.currentSlots);
  });
});

// ---------------------------------------------------------------------------
// 7. Sortiment: uppföljning före/efter med samma längd
// ---------------------------------------------------------------------------

describe("Revision 7 – uppföljning av sortiment med jämförelseautomater", () => {
  it("14 dagar före/efter, justerat med övriga automaters +50 %", () => {
    // m-1: A 1/dag 1–14 okt, 2/dag 15–28 okt + 1 order utan inköpspris. m-2: 2/dag → 3/dag.
    // Före 14 × 2 410 × 7/14 = 16 870/v; efter 28 × 2 410 / 2 = 33 740/v; +16 870.
    // Jämförelse 42/28 = 1,5 → justerat 33 740 − 16 870 × 1,5 = 8 435. Väntat 10 000 → 8 435 bp.
    const r = assortmentFollowUp({
      ...src({ "t-a": 2_000 }),
      orders: [
        ...span("t-a", "m-1", "2026-10-01", 14, 1),
        ...span("t-a", "m-1", "2026-10-15", 14, 2),
        ...burst("t-x", "m-1", "2026-10-20", 1),
        ...span("t-a", "m-2", "2026-10-01", 14, 2),
        ...span("t-a", "m-2", "2026-10-15", 14, 3),
      ],
      machineId: "m-1",
      implementedOn: "2026-10-15",
      asOf: "2026-10-28",
      expectedEffectPerWeekOre: 10_000,
      changedTitleIds: ["t-a"],
    });
    expect(r).toMatchObject({
      status: "running",
      windowDays: 14,
      before: { start: "2026-10-01", end: "2026-10-14" },
      after: { start: "2026-10-15", end: "2026-10-28" },
      unitsBefore: 14,
      unitsAfter: 29,
      unpricedAfter: 1,
      contributionPerWeekBeforeOre: 16_870,
      contributionPerWeekAfterOre: 33_740,
      changePerWeekOre: 16_870,
      controlChangeBp: 5_000,
      adjustedChangePerWeekOre: 8_435,
      achievedBp: 8_435,
      titles: [{ titleId: "t-a", unitsBefore: 14, unitsAfter: 28 }],
    });
    expect(r.evidence.orderIds).toHaveLength(43);
  });

  it("underlaget nämner jämförelseautomaterna", () => {
    const r = assortmentFollowUp({
      ...src({ "t-a": 2_000 }),
      orders: [
        ...span("t-a", "m-1", "2026-10-01", 28, 1),
        ...span("t-a", "m-2", "2026-10-01", 28, 2),
      ],
      machineId: "m-1",
      implementedOn: "2026-10-15",
      asOf: "2026-10-28",
    });
    expect(r.evidence.machineIds).toContain("m-2");
  });
});
