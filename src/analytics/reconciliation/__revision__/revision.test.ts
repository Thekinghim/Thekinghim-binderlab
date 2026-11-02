/**
 * Oberoende revision av ekonomiområdet (fas 9): avstämning, kassaflöde, fasta kostnader och avtal.
 *
 * Alla förväntade värden är uträknade för hand i kommentarerna. Inget facit hämtas från
 * funktionerna som testas. Testerna ska ge samma resultat under TZ=UTC, Europe/Stockholm och
 * Asia/Shanghai (kör med src/analytics/reconciliation/vitest.tz.config.ts).
 */

import { describe, expect, it } from "vitest";
import { eachDay, type OrderLine, type Settings } from "@/domain";
import type { AnalyticsOrder } from "../../todos/types";
import { reconcilePayouts } from "../index";
import type { Deviation, Payout, PayoutReconciliation, ReconciliationInput } from "../index";
import {
  accrueFixedCosts,
  cashflow,
  fixedCostOccurrences,
  profitabilityWithFixedCosts,
  type CashflowInput,
  type FixedCost,
} from "../../cashflow";
import {
  contractReminders,
  contractStatus,
  contractTerm,
  expiringRevenueOverview,
  type Contract,
} from "../../contracts";

/** Hårda och smala mellanslag → vanliga, äkta minus → bindestreck. */
const norm = (s: string): string => s.replace(/[  ]/g, " ").replace(/−/g, "-");

function ord(
  id: string,
  externalId: string,
  businessDate: string,
  amountOre = 4900,
  orderedAt?: string,
): AnalyticsOrder {
  return {
    id,
    externalId,
    titleId: "t1",
    machineId: "m1",
    businessDate,
    amountOre,
    ...(orderedAt ? { orderedAt } : {}),
  };
}

function kinds(p: PayoutReconciliation): string[] {
  return p.deviations.map((d) => d.kind);
}

function dev(p: PayoutReconciliation, kind: string): Deviation {
  const d = p.deviations.find((x) => x.kind === kind);
  expect(d, `avvikelse ${kind} saknas`).toBeDefined();
  return d!;
}

function identity(p: PayoutReconciliation): void {
  expect(p.deviations.reduce((s, d) => s + d.impactOre, 0) + p.roundingOre).toBe(p.differenceOre);
}

// ===========================================================================
// Scenario 1: avstämning MED specifikation, alla ordertyper av avvikelse samtidigt.
// ===========================================================================
//
// Kortavgift 250 bp. Våra order i november (6 st, 384,00 kr):
//   o1  #100  5 nov.   4 900
//   o2  #101 12 nov.   5 900
//   o3  #102 15 nov.   4 900
//   o3b #102 15 nov.   4 900   ← dubblett i vår import (o3 < o3b, så o3b är extra)
//   o4  #103 20 nov.  12 900   ← leverantören säger 12 000
//   o5  #104 25 nov.   4 900   ← saknas i utbetalningen
// Väntade avgifter per order: 4 900 → round(122,5) = 123; 5 900 → round(147,5) = 148;
// 12 900 → round(322,5) = 323. Summa 4 × 123 + 148 + 323 = 963.
// Väntad utbetalning = 38 400 − 963 = 37 437.
//
// Specifikation: #100 4 900, #101 5 900, #101 5 900 (dubbel rad), #102 4 900, #103 12 000,
// #999 4 900 (finns inte hos oss). Summa 38 500. Avgifter 1 000. Utbetalt 38 500 − 1 000 = 37 500.
// Skillnad 37 500 − 37 437 = +63 =
//   avgift −(1 000 − 963) = −37
//   dubblett i import −4 900, dubbel rad +5 900, belopp 12 000 − 12 900 = −900,
//   saknas hos oss +4 900, saknas i utbetalning −4 900
//   −37 − 4 900 + 5 900 − 900 + 4 900 − 4 900 = +63 ✓
describe("Revision 1: avstämning med specifikation", () => {
  const SETTINGS: Settings = { vatRateBp: 0, cardFeeBp: 250 };
  const ORDERS = [
    ord("o1", "100", "2026-11-05", 4900),
    ord("o2", "101", "2026-11-12", 5900),
    ord("o3", "102", "2026-11-15", 4900),
    ord("o3b", "102", "2026-11-15", 4900),
    ord("o4", "103", "2026-11-20", 12900),
    ord("o5", "104", "2026-11-25", 4900),
  ];
  const PAYOUT: Payout = {
    reference: "U-NOV",
    period: "2026-11",
    amountOre: 37_500,
    feesOre: 1_000,
    lines: [
      { externalId: "100", amountOre: 4900 },
      { externalId: "101", amountOre: 5900 },
      { externalId: "101", amountOre: 5900 },
      { externalId: "102", amountOre: 4900 },
      { externalId: "103", amountOre: 12000 },
      { externalId: "999", amountOre: 4900 },
    ],
  };
  const run = (extra: Partial<ReconciliationInput> = {}) =>
    reconcilePayouts({ orders: ORDERS, payouts: [PAYOUT], settings: SETTINGS, ...extra });

  it("väntat, skillnad och avvikelser per typ (handräknat)", () => {
    const r = run();
    const p = r.payouts[0]!;
    expect(p.expected).toEqual({
      orders: 6,
      salesOre: 38_400,
      feesOre: 963,
      refundsOre: 0,
      payoutOre: 37_437,
    });
    expect(p.actual).toEqual({
      payoutOre: 37_500,
      feesOre: 1_000,
      refundsOre: 0,
      salesOre: 38_500,
    });
    expect(p.differenceOre).toBe(63);
    expect(kinds(p)).toEqual([
      "missing-in-payout",
      "missing-in-sales",
      "duplicate-payout",
      "duplicate-order",
      "amount-mismatch",
      "fee",
    ]);
    expect(p.deviations.map((d) => d.impactOre)).toEqual([-4900, 4900, 5900, -4900, -900, -37]);
    expect(p.deviations.every((d) => d.confidence === "confirmed")).toBe(true);
    identity(p);
    expect(p.status).toBe("deviation");
    expect(p.roundingOre).toBe(0);
  });

  it("underlag: varje avvikelse pekar på rätt order och utbetalning", () => {
    const p = run().payouts[0]!;
    expect(dev(p, "missing-in-payout").evidence.orderIds).toEqual(["o5"]);
    expect(dev(p, "duplicate-order").evidence.orderIds).toEqual(["o3b"]);
    expect(dev(p, "duplicate-payout").evidence.orderIds).toEqual(["o2"]);
    expect(dev(p, "amount-mismatch").evidence.orderIds).toEqual(["o4"]);
    for (const d of p.deviations) {
      expect(d.evidence.payoutReferences).toEqual(["U-NOV"]);
      expect(d.evidence.period).toEqual({ start: "2026-11-01", end: "2026-11-30" });
      expect(d.evidence.figures.find((f) => f.key === "impactOre")?.value).toBe(d.impactOre);
    }
    expect(p.evidence.orderIds).toEqual(["o1", "o2", "o3", "o3b", "o4", "o5"]);
    const fee = dev(p, "fee");
    expect(fee.evidence.figures.find((f) => f.key === "reportedFeesOre")?.value).toBe(1000);
    expect(fee.evidence.figures.find((f) => f.key === "expectedFeesOre")?.value).toBe(963);
  });

  it("texter på svenska med siffror", () => {
    const p = run().payouts[0]!;
    expect(norm(dev(p, "fee").title)).toBe("Avgifterna är 0,37 kr högre än väntat");
    expect(norm(dev(p, "missing-in-payout").title)).toBe("1 order saknas i utbetalningen");
    expect(norm(dev(p, "missing-in-sales").title)).toBe("1 order saknas i vår import");
    expect(norm(dev(p, "missing-in-sales").explanation)).toContain("999");
    expect(norm(dev(p, "amount-mismatch").explanation)).toContain("103");
    expect(norm(dev(p, "amount-mismatch").explanation)).toContain("-9,00 kr");
    expect(norm(p.summary)).toBe(
      "U-NOV (1–30 nov.): utbetalt 375,00 kr, väntat 374,37 kr. Skillnad +0,63 kr. Att utreda: " +
        "1 order saknas i utbetalningen (-49,00 kr); 1 order saknas i vår import (+49,00 kr); " +
        "1 order betalas två gånger (+59,00 kr); 1 order finns två gånger i importen (-49,00 kr); " +
        "1 order har olika belopp (-9,00 kr); avgifterna är 0,37 kr högre än väntat (-0,37 kr).",
    );
  });

  it("underlag för order som saknas hos oss innehåller leverantörens ordernummer (#999)", () => {
    // Ordern finns inte i vår databas, så det enda underlaget är leverantörens ordernummer.
    // Det står bara i texten; underlaget (evidence) har inget fält för det.
    const d = dev(run().payouts[0]!, "missing-in-sales");
    expect(JSON.stringify(d.evidence)).toContain("999");
  });

  it("status utredd: alla avvikelser utredda med rätt fingerprint → investigated; ändrat → stale", () => {
    // fingerprint = '<påverkan>|<antal order>'
    const fp: Record<string, string> = {
      fee: "-37|0",
      "duplicate-order": "-4900|1",
      "duplicate-payout": "5900|1",
      "amount-mismatch": "-900|1",
      "missing-in-sales": "4900|1",
      "missing-in-payout": "-4900|1",
    };
    const resolutions = Object.entries(fp).map(([k, f]) => ({
      key: `U-NOV:${k}`,
      fingerprint: f,
      note: "Utrett med leverantören",
    }));
    const r = run({ resolutions });
    expect(r.payouts[0]!.status).toBe("investigated");
    expect(r.totals.investigatedDeviations).toBe(6);
    expect(r.totals.openDeviations).toBe(0);
    expect(r.staleResolutions).toEqual([]);
    expect(norm(r.payouts[0]!.summary)).toContain("Skillnaden +0,63 kr är utredd.");

    const changed = resolutions.map((x) =>
      x.key === "U-NOV:fee" ? { ...x, fingerprint: "-36|0" } : x,
    );
    const r2 = run({ resolutions: changed });
    expect(r2.payouts[0]!.status).toBe("deviation");
    expect(r2.totals.openDeviations).toBe(1);
    expect(r2.staleResolutions.map((x) => x.key)).toEqual(["U-NOV:fee"]);
  });

  it("toleransen gäller hela skillnaden: avgift avrundad på totalen (1 öre) syns inte", () => {
    // 3 order à 4 900, 250 bp: per order 123 → 369. Leverantören avrundar på totalen:
    // round(14 700 × 250 / 10 000) = round(367,5) = 368. Utbetalt 14 700 − 368 = 14 332.
    // Väntat 14 700 − 369 = 14 331. Skillnad +1 öre ≤ tolerans 5 öre.
    // RECONCILIATION_OPTIONS.toleranceOre: "Skillnad (i öre, absolut) som räknas som
    // avrundning och inte visas" → ska bli 'matched'.
    const r = reconcilePayouts({
      orders: [
        ord("a", "1", "2026-11-02"),
        ord("b", "2", "2026-11-03"),
        ord("c", "3", "2026-11-04"),
      ],
      payouts: [{ reference: "R", period: "2026-11", amountOre: 14_332, feesOre: 368 }],
      settings: SETTINGS,
      options: { toleranceOre: 5 },
    });
    const p = r.payouts[0]!;
    expect(p.differenceOre).toBe(1);
    expect(p.status).toBe("matched");
  });
});

// ===========================================================================
// Scenario 2: tidszonsförskjutning över periodgräns (utan specifikation).
// ===========================================================================
//
// Leverantören räknar i Asia/Shanghai (UTC+8). Stockholm är CET (UTC+1) efter 25 okt. 2026.
//   b1 #200 31 okt. 22:30Z = 23:30 svensk tid = 1 nov. 06:30 Shanghai   4 900
//   b2 #201 15 okt. 10:00Z = 12:00 svensk tid = 15 okt. 18:00 Shanghai  5 900
//   b3 #202 10 nov. 12:00Z                                                4 900
//   b4 #203 30 nov. 16:30Z = 17:30 svensk tid = 1 dec. 00:30 Shanghai    5 900
// Leverantören: oktober = b2 = 5 900, november = b1 + b3 = 9 800 (b4 hör till december).
// Oktober: väntat b1 + b2 = 10 800 → −4 900, förklaras av b1 (ut).
// November: väntat b3 + b4 = 10 800 → −1 000 = b1 in (+4 900) och b4 ut (−5 900).
describe("Revision 2: tidszon över periodgräns", () => {
  const SETTINGS: Settings = { vatRateBp: 0, cardFeeBp: 0 };
  const ORDERS = [
    ord("b1", "200", "2026-10-31", 4900, "2026-10-31T22:30:00Z"),
    ord("b2", "201", "2026-10-15", 5900, "2026-10-15T10:00:00Z"),
    ord("b3", "202", "2026-11-10", 4900, "2026-11-10T12:00:00Z"),
    ord("b4", "203", "2026-11-30", 5900, "2026-11-30T16:30:00Z"),
  ];
  const PAYOUTS: Payout[] = [
    { reference: "U-OKT", period: "2026-10", amountOre: 5_900, feesOre: 0 },
    { reference: "U-NOV", period: "2026-11", amountOre: 9_800, feesOre: 0 },
  ];

  it("förskjutningen förklarar skillnaden och status blir 'explained'", () => {
    const r = reconcilePayouts({
      orders: ORDERS,
      payouts: PAYOUTS,
      settings: SETTINGS,
      options: { providerTimeZone: "Asia/Shanghai" },
    });
    const [okt, nov] = r.payouts;
    expect(okt!.expected.payoutOre).toBe(10_800);
    expect(okt!.differenceOre).toBe(-4_900);
    expect(kinds(okt!)).toEqual(["timezone-shift"]);
    expect(dev(okt!, "timezone-shift").impactOre).toBe(-4_900);
    expect(dev(okt!, "timezone-shift").evidence.orderIds).toEqual(["b1"]);
    expect(okt!.status).toBe("explained");
    expect(norm(dev(okt!, "timezone-shift").explanation)).toBe(
      "Leverantören räknar perioden i Asia/Shanghai: 1 order (49,00 kr) räknas av leverantören " +
        "till en annan period. Nettoeffekt -49,00 kr, som jämnas ut i grannperioden. Exempel: " +
        "order 200 betalades 31 okt. 23:30 svensk tid = 1 nov. 06:30 i Asia/Shanghai.",
    );
    expect(norm(okt!.summary)).toBe(
      "U-OKT (1–31 okt.): utbetalt 59,00 kr, väntat 108,00 kr. Skillnaden -49,00 kr beror på " +
        "tidszonen och jämnas ut i grannperioden.",
    );

    expect(nov!.expected.payoutOre).toBe(10_800);
    expect(nov!.differenceOre).toBe(-1_000);
    const tz = dev(nov!, "timezone-shift");
    expect(tz.impactOre).toBe(-1_000);
    expect(tz.orderCount).toBe(2);
    expect(tz.evidence.orderIds).toEqual(["b1", "b4"]);
    expect(tz.evidence.figures.find((f) => f.key === "inOre")?.value).toBe(4_900);
    expect(tz.evidence.figures.find((f) => f.key === "outOre")?.value).toBe(5_900);
    expect(nov!.status).toBe("explained");
    identity(okt!);
    identity(nov!);

    expect(r.totals).toMatchObject({
      expectedOre: 21_600,
      actualOre: 15_700,
      differenceOre: -5_900,
      openDeviations: 0,
    });
    expect(r.totals.byStatus).toEqual({ matched: 0, explained: 2, deviation: 0, investigated: 0 });
    expect(r.uncovered).toEqual([]);
  });

  it("utan leverantörens tidszon blir samma skillnad en härledd saknad order", () => {
    // Oktober −4 900 = exakt 1 order à 49,00 (vanligaste beloppet bland 4 900 och 5 900 är lika
    // vanliga; 5 900 delar inte 4 900, så 4 900 väljs) → missing-in-payout, inferred.
    const r = reconcilePayouts({ orders: ORDERS, payouts: PAYOUTS, settings: SETTINGS });
    const okt = r.payouts[0]!;
    expect(kinds(okt)).toEqual(["missing-in-payout"]);
    expect(okt.deviations[0]!.confidence).toBe("inferred");
    expect(okt.deviations[0]!.orderCount).toBe(1);
    expect(okt.status).toBe("deviation");
  });

  it("utbetalning som stämmer exakt hittar inte på tidszon + saknad order", () => {
    // Leverantören betalar oktober på svenska dagar: b1 + b2 = 10 800 = väntat, skillnad 0.
    // Att då påstå "1 order hamnar i en annan period" (−49) och "troligen 1 order saknas i
    // importen" (+49) är fel: inget saknas och inget är förskjutet.
    const r = reconcilePayouts({
      orders: ORDERS,
      payouts: [{ reference: "U-OKT", period: "2026-10", amountOre: 10_800, feesOre: 0 }],
      settings: SETTINGS,
      options: { providerTimeZone: "Asia/Shanghai" },
    });
    const okt = r.payouts[0]!;
    expect(okt.differenceOre).toBe(0);
    expect(kinds(okt)).not.toContain("missing-in-sales");
    expect(okt.status).not.toBe("deviation");
  });
});

// ===========================================================================
// Scenario 3: avstämning UTAN specifikation – avgift, återbetalning, överlapp, dubbel referens,
// saknad utbetalning, härledda saknade order och oförklarad rest.
// ===========================================================================
//
// Kortavgift 0, fast avgift 300 öre per order. Order à 4 900 utom c8 (5 900):
//   c1 2 sep, c2 3 sep, c3 4 sep, c4 5 sep, c5 6 sep, c6 7 sep, c7 8 sep, c8 8 sep (5 900), c9 9 sep.
// Återbetalning r1 2 sep 1 000.
//
// S-1  1–3 sep: c1 + c2 = 9 800, avgift 600, återbet. 1 000 → väntat 8 200.
//      Leverantören: avgifter 700, återbet. 1 500, utbetalt 9 800 − 700 − 1 500 = 7 600.
//      Skillnad −600 = avgift −100 + återbetalning −500.
// S-2  3–5 sep (3 sep täcks redan av S-1): c3 + c4 = 9 800, avgift 600 → väntat 9 200.
//      Leverantören betalar även c2: försäljning 14 700, avgifter 900, utbetalt 13 800.
//      Skillnad +4 600 = överlapp (duplicate-payout, inferred) +4 900 + avgift −300.
// S-1  6 sep igen (samma referens): 500 → key 'S-1#2', väntat 0, duplicate-payout +500.
//      6 sep täcks då inte → c5 saknar utbetalning: 4 900 − 300 = 4 600 → missing-payout −4 600.
// S-4  7–8 sep: c6 + c7 + c8 = 15 700, avgift 900 → väntat 14 800. Utbetalt 24 600 (avgift 900).
//      Skillnad +9 800 = exakt 2 order à 49,00 → missing-in-sales, inferred, 2 order.
// S-5  9 sep: c9 4 900, avgift 300 → väntat 4 600. Utbetalt 4 650 → +50 oförklarat.
// Totalt väntat 8 200 + 9 200 + 0 + 14 800 + 4 600 = 36 800; utbetalt 7 600 + 13 800 + 500 +
// 24 600 + 4 650 = 51 150; skillnad 14 350. Öppna avvikelser 2 + 2 + 1 + 1 + 1 + 1 = 8.
describe("Revision 3: avstämning utan specifikation", () => {
  const SETTINGS: Settings = { vatRateBp: 0, cardFeeBp: 0 };
  const ORDERS = [
    ord("c1", "301", "2026-09-02"),
    ord("c2", "302", "2026-09-03"),
    ord("c3", "303", "2026-09-04"),
    ord("c4", "304", "2026-09-05"),
    ord("c5", "305", "2026-09-06"),
    ord("c6", "306", "2026-09-07"),
    ord("c7", "307", "2026-09-08"),
    ord("c8", "308", "2026-09-08", 5900),
    ord("c9", "309", "2026-09-09"),
  ];
  const PAYOUTS: Payout[] = [
    {
      reference: "S-1",
      period: { start: "2026-09-01", end: "2026-09-03" },
      amountOre: 7_600,
      feesOre: 700,
      refundsOre: 1_500,
    },
    {
      reference: "S-2",
      period: { start: "2026-09-03", end: "2026-09-05" },
      amountOre: 13_800,
      feesOre: 900,
    },
    {
      reference: "S-1",
      period: { start: "2026-09-06", end: "2026-09-06" },
      amountOre: 500,
      feesOre: 0,
    },
    {
      reference: "S-4",
      period: { start: "2026-09-07", end: "2026-09-08" },
      amountOre: 24_600,
      feesOre: 900,
    },
    {
      reference: "S-5",
      period: { start: "2026-09-09", end: "2026-09-09" },
      amountOre: 4_650,
      feesOre: 300,
    },
  ];
  const base: ReconciliationInput = {
    orders: ORDERS,
    payouts: PAYOUTS,
    refunds: [{ id: "r1", date: "2026-09-02", amountOre: 1_000, orderId: "c1" }],
    settings: SETTINGS,
    options: { fixedFeePerOrderOre: 300 },
  };

  it("varje utbetalning för sig (handräknat)", () => {
    const r = reconcilePayouts(base);
    expect(r.payouts.map((p) => p.key)).toEqual(["S-1", "S-2", "S-1#2", "S-4", "S-5"]);
    const [s1, s2, s1b, s4, s5] = r.payouts;

    expect(s1!.expected).toEqual({
      orders: 2,
      salesOre: 9_800,
      feesOre: 600,
      refundsOre: 1_000,
      payoutOre: 8_200,
    });
    expect(s1!.differenceOre).toBe(-600);
    expect(kinds(s1!)).toEqual(["fee", "refund"]);
    expect(dev(s1!, "fee").impactOre).toBe(-100);
    expect(dev(s1!, "refund").impactOre).toBe(-500);
    expect(dev(s1!, "refund").fingerprint).toBe("-500|1");

    expect(s2!.expected.payoutOre).toBe(9_200);
    expect(s2!.differenceOre).toBe(4_600);
    expect(kinds(s2!)).toEqual(["duplicate-payout", "fee"]);
    expect(dev(s2!, "duplicate-payout").impactOre).toBe(4_900);
    expect(dev(s2!, "duplicate-payout").confidence).toBe("inferred");
    expect(dev(s2!, "duplicate-payout").evidence.orderIds).toEqual(["c2"]);
    expect(dev(s2!, "fee").impactOre).toBe(-300);
    expect(s2!.overlapsWith).toEqual(["S-1"]);
    expect(norm(dev(s2!, "duplicate-payout").title)).toBe("Perioden överlappar S-1");

    expect(s1b!.expected.payoutOre).toBe(0);
    expect(s1b!.differenceOre).toBe(500);
    expect(kinds(s1b!)).toEqual(["duplicate-payout"]);

    expect(s4!.expected.payoutOre).toBe(14_800);
    expect(s4!.differenceOre).toBe(9_800);
    expect(kinds(s4!)).toEqual(["missing-in-sales"]);
    const ms = dev(s4!, "missing-in-sales");
    expect(ms.confidence).toBe("inferred");
    expect(ms.orderCount).toBe(2);
    expect(norm(ms.title)).toBe("Troligen 2 order som saknas i importen");

    expect(s5!.differenceOre).toBe(50);
    expect(kinds(s5!)).toEqual(["unexplained"]);
    expect(norm(dev(s5!, "unexplained").title)).toBe("+0,50 kr är oförklarat");

    for (const p of r.payouts) identity(p);
    expect(r.payouts.every((p) => p.status === "deviation")).toBe(true);

    expect(r.uncovered).toHaveLength(1);
    const u = r.uncovered[0]!;
    expect(u.key).toBe("missing-payout:2026-09");
    expect(u.impactOre).toBe(-4_600);
    expect(u.evidence.orderIds).toEqual(["c5"]);
    expect(u.evidence.dates).toEqual(["2026-09-06"]);
    expect(norm(u.title)).toBe("Ingen utbetalning för 1 dag med försäljning (6 sep.)");

    expect(r.totals).toMatchObject({
      expectedOre: 36_800,
      actualOre: 51_150,
      differenceOre: 14_350,
      openDeviations: 8,
      investigatedDeviations: 0,
    });
    expect(r.evidence.payoutReferences).toEqual(["S-1", "S-2", "S-4", "S-5"]);
  });

  it("tolerans 50 öre: S-5 stämmer med avrundning", () => {
    const r = reconcilePayouts({
      ...base,
      options: { fixedFeePerOrderOre: 300, toleranceOre: 50 },
    });
    const s5 = r.payouts.find((p) => p.key === "S-5")!;
    expect(s5.status).toBe("matched");
    expect(s5.roundingOre).toBe(50);
    expect(norm(s5.summary)).toBe(
      "S-5 (9 sep.): utbetalt 46,50 kr, väntat 46,00 kr. Stämmer (avrundning +0,50 kr).",
    );
  });

  it("ordningen i indata påverkar inte resultatet", () => {
    const a = reconcilePayouts(base);
    const b = reconcilePayouts({
      ...base,
      orders: [...ORDERS].reverse(),
      payouts: [...PAYOUTS].reverse(),
    });
    expect(b).toEqual(a);
  });
});

// ===========================================================================
// Scenario 4: fasta kostnader – betalningsdagar, periodisering och fördelning i lönsamheten.
// ===========================================================================
//
// f1 Försäkring 300,00 kr/kvartal från 31 jan. 2026: 31 jan., 30 apr., 31 juli, 31 okt.
//    31 okt. avser 31 okt. – 30 jan. 2027 = 1 + 30 + 31 + 30 = 92 dagar.
//    November: round(30 000 × 30 / 92) = round(9 782,6) = 9 783.
// f2 Bokföring 120,00 kr/månad 15 nov. 2026 – 14 feb. 2027: 15 nov. avser 15 nov. – 14 dec. (30 d).
//    November: 16 dagar → 12 000 × 16 / 30 = 6 400.
// f3 Larm (automat m2) 1 200,00 kr/år 1 juni – 10 nov. 2026: avser 1 juni – 10 nov. = 163 dagar.
//    November: 10 dagar → round(120 000 × 10 / 163) = round(7 361,96) = 7 362.
// Totalt 23 545, gemensamt 16 183, direkt 7 362.
//
// Lönsamhet november: provision 10 %, inköp 20,00. m1: 3 × 49 → 14 700 − 6 000 − 1 470 = 7 230.
// m2: 1 × 49 → 4 900 − 2 000 − 490 = 2 410. m3 står i butiken men säljer inget: 0.
// Efter intäkt: 16 183 × 14 700/19 600 = 12 137,25; × 4 900/19 600 = 4 045,75; m3 0.
//   Heltal 12 137 + 4 045 = 16 182, öret till största rest (m2 0,75) → 12 137, 4 046, 0.
//   m1 7 230 − 12 137 = −4 907; m2 2 410 − 4 046 − 7 362 = −8 998; m3 0. Σ = −13 905.
// Lika: 16 183 / 3 = 5 394,33 → 5 394 × 3 = 16 182, öret till första (lika rester) → 5 395, 5 394, 5 394.
//   m1 1 835; m2 2 410 − 5 394 − 7 362 = −10 346; m3 −5 394. Σ = −13 905.
describe("Revision 4: fasta kostnader", () => {
  const F1: FixedCost = {
    id: "f1",
    name: "Försäkring",
    amountOre: 30_000,
    interval: "quarter",
    start: "2026-01-31",
    end: null,
  };
  const F2: FixedCost = {
    id: "f2",
    name: "Bokföring",
    amountOre: 12_000,
    interval: "month",
    start: "2026-11-15",
    end: "2027-02-14",
  };
  const F3: FixedCost = {
    id: "f3",
    name: "Larm",
    amountOre: 120_000,
    interval: "year",
    start: "2026-06-01",
    end: "2026-11-10",
    machineId: "m2",
  };
  const NOV = { start: "2026-11-01", end: "2026-11-30" };

  it("betalningsdagar glider inte och slutdatum respekteras", () => {
    expect(fixedCostOccurrences(F1, "2026-12-31").map((o) => o.date)).toEqual([
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
    ]);
    expect(fixedCostOccurrences(F1, "2026-12-31")[3]!.coverage).toEqual({
      start: "2026-10-31",
      end: "2027-01-30",
    });
    // 15 feb. 2027 ligger efter slutet 14 feb.; sista betalningen 15 jan. avser 15 jan. – 14 feb.
    const f2 = fixedCostOccurrences(F2, "2027-12-31");
    expect(f2.map((o) => o.date)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15"]);
    expect(f2[2]!.coverage).toEqual({ start: "2027-01-15", end: "2027-02-14" });
    expect(fixedCostOccurrences(F3, "2027-12-31")).toEqual([
      {
        costId: "f3",
        date: "2026-06-01",
        amountOre: 120_000,
        coverage: { start: "2026-06-01", end: "2026-11-10" },
      },
    ]);
  });

  it("periodisering november", () => {
    const a = accrueFixedCosts([F3, F1, F2], NOV);
    expect(a.byCost.map((c) => [c.costId, c.accruedOre])).toEqual([
      ["f1", 9_783],
      ["f2", 6_400],
      ["f3", 7_362],
    ]);
    expect(a.totalOre).toBe(23_545);
    expect(a.sharedOre).toBe(16_183);
    expect(a.directOre).toBe(7_362);
    expect(a.evidence.fixedCostIds).toEqual(["f1", "f2", "f3"]);
  });

  const orders: OrderLine[] = [
    {
      id: "x1",
      externalId: "1",
      titleId: "t1",
      machineId: "m1",
      businessDate: "2026-11-02",
      amountOre: 4900,
    },
    {
      id: "x2",
      externalId: "2",
      titleId: "t1",
      machineId: "m1",
      businessDate: "2026-11-03",
      amountOre: 4900,
    },
    {
      id: "x3",
      externalId: "3",
      titleId: "t1",
      machineId: "m1",
      businessDate: "2026-11-04",
      amountOre: 4900,
    },
    {
      id: "x4",
      externalId: "4",
      titleId: "t1",
      machineId: "m2",
      businessDate: "2026-11-05",
      amountOre: 4900,
    },
  ];
  const input = {
    orders,
    prices: [{ titleId: "t1", unitCostOre: 2000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 1000,
        monthlyRentOre: null,
      },
    ],
    placements: ["m1", "m2", "m3"].map((m) => ({
      machineId: m,
      storeId: "s1",
      from: "2026-01-01",
      to: null,
    })),
    settings: { vatRateBp: 0, cardFeeBp: 0 },
    period: NOV,
    fixedCosts: [F1, F2, F3],
    machines: [
      { id: "m1", name: "Automat 1" },
      { id: "m2", name: "Automat 2" },
      { id: "m3", name: "Automat 3" },
    ],
  };

  it("fördelning efter intäkt (största rest) och summakontroll", () => {
    const r = profitabilityWithFixedCosts(input, "revenue");
    const rows = r.rows.map((x) => [
      x.key,
      x.profitOre,
      x.sharedFixedOre,
      x.directFixedOre,
      x.profitAfterFixedOre,
    ]);
    expect(rows).toEqual([
      ["m1", 7_230, 12_137, 0, -4_907],
      ["m2", 2_410, 4_046, 7_362, -8_998],
      ["m3", 0, 0, 0, 0],
    ]);
    expect(r.totals).toMatchObject({
      revenueOre: 19_600,
      profitOre: 9_640,
      fixedCostOre: 23_545,
      profitAfterFixedOre: -13_905,
    });
    expect(r.rows.reduce((s, x) => s + x.profitAfterFixedOre, 0)).toBe(-13_905);
    expect(r.rows[1]!.evidence.fixedCostIds).toEqual(["f1", "f2", "f3"]);
    expect(r.rows[0]!.evidence.fixedCostIds).toEqual(["f1", "f2"]);
    expect(r.rows[0]!.shareBp).toBe(7_500);
    expect(norm(r.summary)).toBe(
      "Fasta kostnader 235 kr 1–30 nov. (3 st). Vinst 96 kr före och -139 kr efter fasta kostnader " +
        "(marginal -71 %). Gemensamma kostnader fördelas efter nettointäkt: Automat 1 bär 121 kr (75 %). " +
        "Går med förlust efter fasta kostnader: Automat 1 (-49 kr), Automat 2 (-90 kr).",
    );
  });

  it("fördelning lika per automat", () => {
    const r = profitabilityWithFixedCosts(input, "equal");
    expect(r.rows.map((x) => [x.key, x.sharedFixedOre, x.profitAfterFixedOre])).toEqual([
      ["m1", 5_395, 1_835],
      ["m2", 5_394, -10_346],
      ["m3", 5_394, -5_394],
    ]);
    expect(r.totals.profitAfterFixedOre).toBe(-13_905);
  });
});

// ===========================================================================
// Scenario 5: kassaflöde per månad, faktiskt och prognos.
// ===========================================================================
//
// I dag 15 nov. 2026. En order à 49,00 om dagen 1 okt. – 14 nov. Automat m1 i butik s1:
// provision 10 %, hyra 500,00 kr/månad. Oktober (151 900 = 31 × 4 900) betalades 5 nov.
// → månadsrytm, fördröjning 5 dagar.
// Fönster: 28 dagar t.o.m. i går = 18 okt. – 14 nov.: 28 order, 137 200, provision 13 720.
//
// Oktober (allt faktiskt): inköp 10 okt. 50 000; fast f-q 15 okt. 30 000; fast f-m 31 okt. 10 000;
//   butiksersättning för september 31 okt.: provision 0 + hyra 50 000. Ut 140 000.
// November: utbetalning 5 nov. 151 900 (faktisk). Prognos: planerat inköp 10 nov. har passerat
//   → 16 nov., 20 000; f-m 30 nov. 10 000; butiksersättning oktober 30 nov.:
//   31 × 490 + 50 000 = 65 190. In 151 900, ut 95 190, netto 56 710.
// December: väntad utbetalning för november 5 dec.: känd 14 × 4 900 = 68 600 + prognos
//   round(137 200 × 16 / 28) = 78 400 → 147 000. Inköp 20 dec. 30 000; f-m 31 dec. 10 000;
//   butiksersättning november 31 dec.: 14 × 490 + round(13 720 × 16 / 28) = 6 860 + 7 840
//   = 14 700 + hyra 50 000 = 64 700. In 147 000, ut 104 700, netto 42 300.
// Totalt in 298 900, ut 339 890, netto −40 990. Saldo från 100 000: −40 000, 16 710, 59 010.
describe("Revision 5: kassaflöde", () => {
  const ORDERS: OrderLine[] = eachDay("2026-10-01", "2026-11-14").map((d, i) => ({
    id: `k${String(i).padStart(2, "0")}`,
    externalId: String(50000 + i),
    titleId: "t1",
    machineId: "m1",
    businessDate: d,
    amountOre: 4900,
  }));
  const BASE: CashflowInput = {
    orders: ORDERS,
    prices: [{ titleId: "t1", unitCostOre: 2000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 1000,
        monthlyRentOre: 50_000,
      },
    ],
    placements: [{ machineId: "m1", storeId: "s1", from: "2026-01-01", to: null }],
    settings: { vatRateBp: 0, cardFeeBp: 0 },
    payouts: [
      {
        reference: "P-10",
        period: "2026-10",
        amountOre: 151_900,
        feesOre: 0,
        paidOn: "2026-11-05",
      },
    ],
    purchases: [
      { id: "inv1", date: "2026-10-10", amountOre: 50_000, status: "paid" },
      { id: "inv2", date: "2026-11-10", amountOre: 20_000, status: "planned" },
      { id: "inv3", date: "2026-12-20", amountOre: 30_000, status: "planned" },
    ],
    fixedCosts: [
      {
        id: "f-m",
        name: "Kassasystem",
        amountOre: 10_000,
        interval: "month",
        start: "2026-01-31",
        end: null,
      },
      {
        id: "f-q",
        name: "Lager",
        amountOre: 30_000,
        interval: "quarter",
        start: "2026-10-15",
        end: "2026-12-31",
      },
    ],
    asOf: "2026-11-15",
    range: { start: "2026-10-01", end: "2026-12-31" },
    granularity: "month",
    options: { openingBalanceOre: 100_000 },
  };

  it("månader, faktiskt/prognos, saldo och underlag (handräknat)", () => {
    const r = cashflow(BASE);
    const lines = r.buckets.map((b) => [
      b.key,
      b.phase,
      b.total.inOre,
      b.total.outOre,
      b.total.netOre,
    ]);
    expect(lines).toEqual([
      ["2026-10", "actual", 0, 140_000, -140_000],
      ["2026-11", "mixed", 151_900, 95_190, 56_710],
      ["2026-12", "forecast", 147_000, 104_700, 42_300],
    ]);
    expect(r.buckets.map((b) => b.closingBalanceOre)).toEqual([-40_000, 16_710, 59_010]);
    expect(r.buckets[1]!.actual).toMatchObject({ inOre: 151_900, outOre: 0 });
    expect(r.buckets[1]!.forecast).toMatchObject({
      inOre: 0,
      outOre: 95_190,
      purchasesOre: 20_000,
    });
    expect(r.totals.total).toMatchObject({ inOre: 298_900, outOre: 339_890, netOre: -40_990 });
    expect(r.totals.actual.netOre).toBe(11_900);
    expect(r.totals.forecast.netOre).toBe(-52_890);
    expect(r.lowestBalance).toEqual({ bucketKey: "2026-10", balanceOre: -40_000 });
    expect(r.basis).toEqual({
      window: { start: "2026-10-18", end: "2026-11-14" },
      windowDays: 28,
      windowOrders: 28,
      windowSalesOre: 137_200,
      windowCommissionOre: 13_720,
      payoutCycle: "month",
      payoutLagDays: 5,
    });

    const byKey = new Map(r.items.map((i) => [i.key, i]));
    const fc = r.items.find((i) => i.kind === "payout" && i.phase === "forecast")!;
    expect(fc.date).toBe("2026-12-05");
    expect(fc.amountOre).toBe(147_000);
    expect(fc.evidence.orderIds).toHaveLength(14);
    expect(fc.evidence.figures.find((f) => f.key === "forecastSalesOre")?.value).toBe(78_400);

    const okt = byKey.get("store-compensation:2026-10")!;
    expect(okt.date).toBe("2026-11-30");
    expect(okt.amountOre).toBe(65_190);
    expect(okt.evidence.storeIds).toEqual(["s1"]);
    const sep = byKey.get("store-compensation:2026-09")!;
    expect(sep).toMatchObject({ date: "2026-10-31", amountOre: 50_000, phase: "actual" });
    expect(byKey.get("store-compensation:2026-11")!.amountOre).toBe(64_700);

    const inv2 = byKey.get("purchase:inv2")!;
    expect(inv2).toMatchObject({ date: "2026-11-16", overdue: true, phase: "forecast" });
    expect(inv2.evidence.purchaseIds).toEqual(["inv2"]);
    expect(byKey.get("fixed:f-q:2026-10-15")!.evidence.fixedCostIds).toEqual(["f-q"]);
    expect(r.buckets[0]!.evidence.purchaseIds).toEqual(["inv1"]);
    expect(r.buckets[0]!.evidence.fixedCostIds).toEqual(["f-m", "f-q"]);

    const s = norm(r.summary);
    expect(s).toContain("1 okt. –\u2060 31 dec.: in 2 989 kr, ut 3 399 kr, netto -410 kr.");
    expect(s).toContain("Varav prognos från 16 nov.: netto -529 kr.");
    expect(s).toContain("Saldot blir negativt i oktober 2026: -400 kr.");
  });

  it("veckovis ger samma totaler som månadsvis", () => {
    const w = cashflow({ ...BASE, granularity: "week" });
    expect(w.totals.total).toMatchObject({ inOre: 298_900, outOre: 339_890, netOre: -40_990 });
    expect(w.buckets[0]!.key).toBe("2026-W40");
    expect(w.buckets[0]!.partial).toBe(true);
    expect(w.buckets.reduce((s, b) => s + b.total.netOre, 0)).toBe(-40_990);
  });

  it("faktiska butiksbetalningar ersätter beräkningen för det som har hänt", () => {
    // Septembers ersättning (förfaller 31 okt.) betalades 30 okt. med 48 000.
    const r = cashflow({
      ...BASE,
      storePayments: [{ id: "sp1", storeId: "s1", paidOn: "2026-10-30", amountOre: 48_000 }],
    });
    expect(r.buckets[0]!.total.storeCompensationOre).toBe(48_000);
    expect(r.items.some((i) => i.key === "store-compensation:2026-09")).toBe(false);
  });

  it("butiksersättning betald i förväg räknas inte två gånger", () => {
    // Oktobers ersättning 65 190 betalades redan 10 nov. (förfaller 30 nov.). Utflödet för
    // oktober är då 65 190, inte 65 190 (betalt) + 65 190 (beräknat 30 nov.).
    const r = cashflow({
      ...BASE,
      storePayments: [
        { id: "sp-sep", storeId: "s1", paidOn: "2026-10-31", amountOre: 50_000 },
        { id: "sp-okt", storeId: "s1", paidOn: "2026-11-10", amountOre: 65_190 },
      ],
    });
    expect(r.buckets[1]!.total.storeCompensationOre).toBe(65_190);
  });

  it("obetald butiksersättning försvinner inte ur kassaflödet", () => {
    // Faktiska betalningar registreras, men septembers ersättning (50 000, förföll 31 okt.)
    // är inte betald. Som för utbetalningar och inköp ska den ligga kvar som försenad
    // (i morgon), annars ser kassan 500 kr bättre ut än den är.
    const r = cashflow({ ...BASE, storePayments: [] });
    expect(r.totals.total.storeCompensationOre).toBe(50_000 + 65_190 + 64_700);
  });
});

// ===========================================================================
// Scenario 6: avtal – påminnelse 90 dagar före sista uppsägningsdag, förlängning, uppsägning,
// och andel av intäkten på avtal som löper ut inom 12 månader.
// ===========================================================================
//
// I dag 2 nov. 2026.
// k1 ICA (s1) 1 apr. 2025 – 31 mars 2027, 3 mån: sista dag 31 dec. 2026, påminnelse
//    31 dec. − 90 = 2 okt. 2026 → due. 59 dagar kvar (28 i nov. + 31), 149 till slutet.
// k2 Lekia (s2) – 31 dec. 2026, 1 mån, förlängs 12 mån: sista dag 30 nov., påminnelse 1 sep. → due.
// k3 Coop (s3) 1 juni 2023 – 31 maj 2024, 2 mån, förlängs 12 mån: förlängt 3 gånger till
//    31 maj 2027 (period från 1 juni 2026). Sista dag 31 mars 2027, påminnelse 31 dec. 2026 → scheduled.
// k4 Pressbyrån (s4) tills vidare → open-ended.
// k5 ICA (s1) 2023 – 31 mars 2025 → expired.
// k6 Hemköp (s5) – 15 jan. 2027, ingen uppsägningstid: påminnelse 15 jan. − 90 = 17 okt. → due, 74 dagar.
// k7 Willys (s6) – 31 dec. 2026, 3 mån, förlängs, uppsagt 15 sep. (före sista dag 30 sep.) → terminated.
describe("Revision 6: avtal", () => {
  const ASOF = "2026-11-02";
  const STORES = [
    { id: "s1", name: "ICA Kvantum" },
    { id: "s2", name: "Lekia" },
    { id: "s3", name: "Coop" },
    { id: "s4", name: "Pressbyrån" },
    { id: "s5", name: "Hemköp" },
    { id: "s6", name: "Willys" },
    { id: "s7", name: "Elgiganten" },
  ];
  const C: Contract[] = [
    { id: "k1", storeId: "s1", validFrom: "2025-04-01", validTo: "2027-03-31", noticeMonths: 3 },
    {
      id: "k2",
      storeId: "s2",
      validFrom: "2024-01-01",
      validTo: "2026-12-31",
      noticeMonths: 1,
      renewalMonths: 12,
    },
    {
      id: "k3",
      storeId: "s3",
      validFrom: "2023-06-01",
      validTo: "2024-05-31",
      noticeMonths: 2,
      renewalMonths: 12,
    },
    { id: "k4", storeId: "s4", validFrom: "2024-01-01", validTo: null, noticeMonths: 3 },
    { id: "k5", storeId: "s1", validFrom: "2023-01-01", validTo: "2025-03-31", noticeMonths: 0 },
    { id: "k6", storeId: "s5", validFrom: "2026-01-16", validTo: "2027-01-15" },
    {
      id: "k7",
      storeId: "s6",
      validFrom: "2025-01-01",
      validTo: "2026-12-31",
      noticeMonths: 3,
      renewalMonths: 12,
      terminatedOn: "2026-09-15",
    },
  ];

  it("påminnelser, status och texter", () => {
    const r = contractReminders({ contracts: C, asOf: ASOF, stores: STORES });
    expect(r.reminders.map((x) => [x.contractId, x.status])).toEqual([
      ["k5", "expired"],
      ["k7", "terminated"],
      ["k2", "due"],
      ["k1", "due"],
      ["k6", "due"],
      ["k3", "scheduled"],
      ["k4", "open-ended"],
    ]);
    expect(r.due.map((x) => x.contractId)).toEqual(["k2", "k1", "k6"]);
    const k1 = r.reminders.find((x) => x.contractId === "k1")!;
    expect(k1.term).toMatchObject({
      currentEnd: "2027-03-31",
      noticeDeadline: "2026-12-31",
      reminderDate: "2026-10-02",
      renews: false,
    });
    expect(k1.daysToDeadline).toBe(59);
    expect(k1.daysToEnd).toBe(149);
    expect(norm(k1.title)).toBe("Avtalet med ICA Kvantum löper ut 31 mars 2027");
    expect(norm(k1.detail)).toBe(
      "Säg upp eller omförhandla senast 31 dec. 2026 (3 månaders uppsägningstid), om 59 dagar.",
    );
    expect(k1.evidence.contractIds).toEqual(["k1"]);
    expect(k1.evidence.storeIds).toEqual(["s1"]);
    expect(k1.evidence.dates).toEqual(["2026-10-02", "2026-12-31", "2027-03-31"]);

    const k2 = r.reminders.find((x) => x.contractId === "k2")!;
    expect(k2.term).toMatchObject({
      noticeDeadline: "2026-11-30",
      reminderDate: "2026-09-01",
      nextEnd: "2027-12-31",
    });
    expect(norm(k2.detail)).toBe(
      "Säg upp eller omförhandla senast 30 nov. 2026 (1 månads uppsägningstid), om 28 dagar. " +
        "Annars förlängs det med 12 månader till 31 dec. 2027.",
    );

    const k3 = r.reminders.find((x) => x.contractId === "k3")!;
    expect(k3.term).toMatchObject({
      termStart: "2026-06-01",
      currentEnd: "2027-05-31",
      noticeDeadline: "2027-03-31",
      reminderDate: "2026-12-31",
      renewals: 3,
      renews: true,
    });

    const k6 = r.reminders.find((x) => x.contractId === "k6")!;
    expect(k6.term).toMatchObject({ noticeDeadline: "2027-01-15", reminderDate: "2026-10-17" });
    expect(k6.daysToDeadline).toBe(74);

    expect(norm(r.summary)).toBe(
      "3 avtal behöver åtgärdas. Först: avtalet med Lekia löper ut 31 dec. 2026, säg upp senast " +
        "30 nov. 2026. 1 avtal har gått ut.",
    );
  });

  it("påminnelse 90 dagar före slutet med reminderBasis 'end'", () => {
    // 31 mars 2027 − 90 dagar = 31 dec. 2026 → i dag är påminnelsen inte kommen.
    const t = contractTerm(C[0]!, ASOF, { reminderBasis: "end" });
    expect(t.reminderDate).toBe("2026-12-31");
    expect(contractStatus(C[0]!, t, ASOF)).toBe("scheduled");
  });

  it("sen uppsägning (efter sista dag) förlänger ändå en period", () => {
    // Uppsagt 15 okt. 2026, sista dag var 30 sep. → förlängs till 31 dec. 2027 och slutar då.
    const late: Contract = { ...C[6]!, terminatedOn: "2026-10-15" };
    const now = contractTerm(late, ASOF);
    expect(now).toMatchObject({ currentEnd: "2026-12-31", renews: true, nextEnd: "2027-12-31" });
    expect(contractStatus(late, now, ASOF)).toBe("notice-passed");
    const next = contractTerm(late, "2027-01-10");
    expect(next).toMatchObject({ currentEnd: "2027-12-31", renews: false, renewals: 1 });
    expect(contractStatus(late, next, "2027-01-10")).toBe("terminated");
  });

  it("andel av intäkten senaste 12 mån på avtal som löper ut inom 12 mån", () => {
    // Fönster 2 nov. 2025 – 1 nov. 2026. Horisont t.o.m. 2 nov. 2027.
    // s1 30 000 (k1, löper ut), s2 20 000 (k2, löper ut, förlängs), s3 10 000 (k3, löper ut,
    // förlängs), s4 25 000 (tills vidare), s7 15 000 (inget avtal), m6 utan butik 5 000.
    // Order 1 nov. 2025 och 2 nov. 2026 ligger utanför fönstret.
    // Totalt 105 000. Löper ut 60 000 → 5 714 bp (57 %). Förlängs 30 000. Utan avtal 15 000 → 1 429 bp.
    const o = (id: string, m: string, d: string, a: number): OrderLine => ({
      id,
      externalId: id,
      titleId: "t1",
      machineId: m,
      businessDate: d,
      amountOre: a,
    });
    const r = expiringRevenueOverview({
      contracts: C,
      asOf: ASOF,
      stores: STORES,
      orders: [
        o("e1", "m1", "2026-05-01", 30_000),
        o("e0", "m1", "2025-11-01", 10_000),
        o("e9", "m1", "2026-11-02", 10_000),
        o("e2", "m2", "2025-11-02", 20_000),
        o("e3", "m3", "2026-11-01", 10_000),
        o("e4", "m4", "2026-03-01", 25_000),
        o("e7", "m5", "2026-07-01", 15_000),
        o("e6", "m6", "2026-08-01", 5_000),
      ],
      prices: [],
      agreements: [],
      placements: [
        ["m1", "s1"],
        ["m2", "s2"],
        ["m3", "s3"],
        ["m4", "s4"],
        ["m5", "s7"],
      ].map(([machineId, storeId]) => ({
        machineId: machineId!,
        storeId: storeId!,
        from: "2025-01-01",
        to: null,
      })),
      settings: { vatRateBp: 0, cardFeeBp: 0 },
    });
    expect(r.window).toEqual({ start: "2025-11-02", end: "2026-11-01" });
    expect(r.horizonEnd).toBe("2027-11-02");
    expect(r).toMatchObject({
      totalRevenueOre: 105_000,
      expiringRevenueOre: 60_000,
      expiringShareBp: 5_714,
      renewingRevenueOre: 30_000,
      noContractRevenueOre: 15_000,
      noContractShareBp: 1_429,
      noStoreRevenueOre: 5_000,
    });
    expect(r.stores.map((s) => [s.storeId, s.category, s.revenueOre])).toEqual([
      ["s1", "expiring", 30_000],
      ["s4", "secure", 25_000],
      ["s2", "expiring", 20_000],
      ["s7", "no-contract", 15_000],
      ["s3", "expiring", 10_000],
      ["s5", "expiring", 0],
      ["s6", "expiring", 0],
    ]);
    expect(r.evidence.storeIds).toEqual(["s1", "s2", "s3"]);
    expect(r.evidence.contractIds).toEqual(["k1", "k2", "k3"]);
    expect(norm(r.summary)).toBe(
      "57 % av intäkten de senaste 12 månaderna (600 kr av 1 050 kr) ligger på avtal som löper ut " +
        "inom 12 månader: ICA Kvantum 29 % (slutar 31 mars 2027), Lekia 19 % (slutar 31 dec. 2026), " +
        "Coop 10 % (slutar 31 maj 2027). 300 kr av det förlängs automatiskt om ingen säger upp. " +
        "150 kr (14 %) kommer från butiker utan gällande avtal: Elgiganten.",
    );
  });
});
