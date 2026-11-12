/**
 * Avstämning med avsiktliga avvikelser av varje typ. Alla förväntade belopp är uträknade
 * för hand i kommentarerna; inga facit hämtas från funktionen som testas.
 */

import { describe, expect, it } from "vitest";
import type { Settings } from "@/domain";
import type { AnalyticsOrder } from "../todos/types";
import {
  chooseTimezoneShift,
  feeBasisText,
  reconcilePayouts,
  splitRounding,
  summaryAmounts,
} from "./reconcile";
import type { Payout, PayoutReconciliation, ReconciliationInput } from "./types";

const SETTINGS: Settings = { vatRateBp: 0, cardFeeBp: 0 };

/** Gör texten jämförbar: hårda mellanslag → vanliga, äkta minus → bindestreck. */
function norm(s: string): string {
  return s.replace(/ /g, " ").replace(/−/g, "-");
}

function order(
  id: string,
  externalId: string,
  businessDate: string,
  amountOre = 4900,
  orderedAt?: string,
): AnalyticsOrder {
  return {
    id,
    externalId,
    titleId: "t-30th",
    machineId: "m1",
    businessDate,
    amountOre,
    ...(orderedAt ? { orderedAt } : {}),
  };
}

/** Tre order à 49,00 kr i november: 14 700 öre. */
const NOV = [
  order("o1", "42001", "2026-11-03"),
  order("o2", "42002", "2026-11-10"),
  order("o3", "42003", "2026-11-20"),
];

function run(payouts: Payout[], extra: Partial<ReconciliationInput> = {}) {
  return reconcilePayouts({ orders: NOV, payouts, settings: SETTINGS, ...extra });
}

function only(result: ReturnType<typeof run>): PayoutReconciliation {
  expect(result.payouts).toHaveLength(1);
  return result.payouts[0]!;
}

function checkIdentity(p: PayoutReconciliation): void {
  const sum = p.deviations.reduce((s, d) => s + d.impactOre, 0) + p.roundingOre;
  expect(sum).toBe(p.differenceOre);
}

describe("reconcilePayouts: grundregel", () => {
  it("utbetalning som stämmer exakt: väntat = försäljning − avgifter − återbetalningar", () => {
    const p = only(run([{ reference: "U-11", period: "2026-11", amountOre: 14_700, feesOre: 0 }]));
    expect(p.expected).toEqual({
      orders: 3,
      salesOre: 14_700,
      feesOre: 0,
      refundsOre: 0,
      payoutOre: 14_700,
    });
    expect(p.differenceOre).toBe(0);
    expect(p.status).toBe("matched");
    expect(p.deviations).toEqual([]);
    expect(p.period).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(p.paidOn).toBe("2026-11-30");
    expect(norm(p.summary)).toBe(
      "U-11 (1–30 nov.): utbetalt 147,00 kr, väntat 147,00 kr. Stämmer.",
    );
    expect(p.evidence.orderIds).toEqual(["o1", "o2", "o3"]);
    expect(p.evidence.payoutReferences).toEqual(["U-11"]);
  });

  it("kortavgift 2,5 %: round(4 900 × 250 / 10 000) = 123 per order, 369 för tre", () => {
    const p = only(
      run([{ reference: "U-11", period: "2026-11", amountOre: 14_700 - 369, feesOre: 369 }], {
        settings: { vatRateBp: 0, cardFeeBp: 250 },
      }),
    );
    expect(p.expected.feesOre).toBe(369);
    expect(p.expected.payoutOre).toBe(14_331);
    expect(p.status).toBe("matched");
  });

  it("fast avgift per order räknas in: 3 × 50 öre", () => {
    const p = only(
      run([{ reference: "U-11", period: "2026-11", amountOre: 14_550, feesOre: 150 }], {
        options: { fixedFeePerOrderOre: 50 },
      }),
    );
    expect(p.expected.feesOre).toBe(150);
    expect(p.status).toBe("matched");
  });

  it("perioden kan anges som { start, end } och utbetalningsdag som datum", () => {
    const p = only(
      run([
        {
          reference: "U-a",
          period: { start: "2026-11-01", end: "2026-11-15" },
          amountOre: 9800,
          feesOre: 0,
          paidOn: "2026-11-20",
        },
      ]),
    );
    expect(p.expected.orders).toBe(2);
    expect(p.paidOn).toBe("2026-11-20");
    expect(p.status).toBe("matched");
  });

  it("negativ utbetalning tillåts (återbetalningar större än försäljningen)", () => {
    const p = only(
      reconcilePayouts({
        orders: [],
        payouts: [
          { reference: "U", period: "2026-11", amountOre: -4900, feesOre: 0, refundsOre: 4900 },
        ],
        refunds: [{ id: "r1", date: "2026-11-05", amountOre: 4900 }],
        settings: SETTINGS,
      }),
    );
    expect(p.expected.payoutOre).toBe(-4900);
    expect(p.status).toBe("matched");
  });
});

describe("kända avdrag (en engångsavgift i leverantörens rapport)", () => {
  it("avdraget dras från det väntade och är ingen avvikelse", () => {
    // Försäljning 14 700, kortavgift 2,5 % = 369, engångsavgift 1 000 → väntat 13 331.
    const p = only(
      run(
        [
          {
            reference: "N-11",
            period: "2026-11",
            amountOre: 13_331,
            feesOre: 369,
            deductionsOre: 1_000,
          },
        ],
        { settings: { vatRateBp: 0, cardFeeBp: 250 } },
      ),
    );
    expect(p.expected.payoutOre).toBe(13_331);
    expect(p.actual.payoutOre).toBe(13_331);
    // Leverantörens försäljning = utbetalt + avgifter + avdrag = vår försäljning.
    expect(p.actual.salesOre).toBe(14_700);
    expect(p.differenceOre).toBe(0);
    expect(p.status).toBe("matched");
    expect(p.deviations).toEqual([]);
  });

  it("med inställningen 0 % är bara kortavgiften en avvikelse, inte avdraget", () => {
    const p = only(
      run([
        { reference: "N-11", period: "2026-11", amountOre: 13_331, feesOre: 369, deductionsOre: 1_000 },
      ]),
    );
    expect(p.expected.payoutOre).toBe(13_700);
    expect(p.differenceOre).toBe(-369);
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["fee", -369]]);
    checkIdentity(p);
  });

  it("utan avdrag i indata räknas allt som förut", () => {
    const a = only(run([{ reference: "U", period: "2026-11", amountOre: 14_700, feesOre: 0 }]));
    const b = only(
      run([{ reference: "U", period: "2026-11", amountOre: 14_700, feesOre: 0, deductionsOre: 0 }]),
    );
    expect(b).toEqual(a);
  });
});

describe("avvikelse: avgifter", () => {
  it("leverantören drar 3,00 kr i avgift när inställningen ger 0", () => {
    // Väntat 14 700. Utbetalt 14 400, avgift 300 → skillnad −300, helt förklarad av avgiften.
    const p = only(
      run([{ reference: "U-11", period: "2026-11", amountOre: 14_400, feesOre: 300 }]),
    );
    expect(p.differenceOre).toBe(-300);
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["fee", -300]]);
    expect(p.status).toBe("deviation");
    const d = p.deviations[0]!;
    expect(norm(d.title)).toBe("Avgifterna är 3,00 kr högre än väntat");
    expect(norm(d.explanation)).toContain("Leverantören drog 3,00 kr i avgifter");
    expect(norm(d.explanation)).toContain("ger 0,00 kr för 3 order på totalt 147,00 kr");
    expect(d.evidence.figures.find((f) => f.key === "reportedFeesOre")?.value).toBe(300);
    checkIdentity(p);
  });
});

describe("avvikelse: saknade order", () => {
  it("med specifikation: order 42003 saknas i utbetalningen", () => {
    const p = only(
      run([
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 9800,
          feesOre: 0,
          lines: [
            { externalId: "42001", amountOre: 4900 },
            { externalId: "42002", amountOre: 4900 },
          ],
        },
      ]),
    );
    expect(p.differenceOre).toBe(-4900);
    expect(p.deviations).toHaveLength(1);
    const d = p.deviations[0]!;
    expect(d.kind).toBe("missing-in-payout");
    expect(d.confidence).toBe("confirmed");
    expect(d.impactOre).toBe(-4900);
    expect(d.evidence.orderIds).toEqual(["o3"]);
    expect(norm(d.title)).toBe("1 order saknas i utbetalningen");
    expect(norm(d.explanation)).toContain("42003");
    expect(norm(d.explanation)).toContain("49,00 kr");
    checkIdentity(p);
  });

  it("med specifikation: order 42999 saknas i vår import", () => {
    const p = only(
      run([
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 20_600,
          feesOre: 0,
          lines: [
            { externalId: "42001", amountOre: 4900 },
            { externalId: "42002", amountOre: 4900 },
            { externalId: "42003", amountOre: 4900 },
            { externalId: "42999", amountOre: 5900 },
          ],
        },
      ]),
    );
    expect(p.differenceOre).toBe(5900);
    const d = p.deviations[0]!;
    expect(d.kind).toBe("missing-in-sales");
    expect(d.impactOre).toBe(5900);
    expect(d.orderCount).toBe(1);
    expect(norm(d.title)).toBe("1 order saknas i vår import");
    expect(norm(d.explanation)).toContain("42999");
    checkIdentity(p);
  });

  it("utan specifikation: 98,00 kr för mycket är exakt 2 order à 49,00 kr (härlett)", () => {
    const p = only(run([{ reference: "U-11", period: "2026-11", amountOre: 24_500, feesOre: 0 }]));
    expect(p.differenceOre).toBe(9800);
    const d = p.deviations[0]!;
    expect(d.kind).toBe("missing-in-sales");
    expect(d.confidence).toBe("inferred");
    expect(d.orderCount).toBe(2);
    expect(norm(d.title)).toBe("Troligen 2 order som saknas i importen");
    expect(norm(d.explanation)).toContain("exakt 2 order à 49,00 kr");
    // 30 dagar i november, order på 3 av dem → 27 dagar utan order i underlaget.
    expect(d.evidence.dates).toHaveLength(27);
    expect(d.evidence.dates).not.toContain("2026-11-03");
    checkIdentity(p);
  });

  it("utan specifikation: 49,00 kr för lite är 1 order som inte betalats ut (härlett)", () => {
    const p = only(run([{ reference: "U-11", period: "2026-11", amountOre: 9800, feesOre: 0 }]));
    const d = p.deviations[0]!;
    expect(d.kind).toBe("missing-in-payout");
    expect(d.confidence).toBe("inferred");
    expect(d.impactOre).toBe(-4900);
    expect(d.orderCount).toBe(1);
  });

  it("fler order än gränsen tolkas inte som saknade order", () => {
    const p = only(
      run([{ reference: "U-11", period: "2026-11", amountOre: 14_700 + 3 * 4900, feesOre: 0 }], {
        options: { maxInferredOrders: 2 },
      }),
    );
    expect(p.deviations.map((d) => d.kind)).toEqual(["unexplained"]);
  });
});

describe("avvikelse: dubbletter", () => {
  it("samma ordernummer två gånger i vår import", () => {
    const orders = [...NOV, order("o3b", "42003", "2026-11-20")];
    const p = only(
      reconcilePayouts({
        orders,
        payouts: [{ reference: "U-11", period: "2026-11", amountOre: 14_700, feesOre: 0 }],
        settings: SETTINGS,
      }),
    );
    // Vår försäljning 19 600 men leverantören betalar 14 700: −4 900, förklarat av dubbletten.
    expect(p.expected.salesOre).toBe(19_600);
    expect(p.differenceOre).toBe(-4900);
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["duplicate-order", -4900]]);
    expect(p.deviations[0]!.evidence.orderIds).toEqual(["o3b"]);
    expect(norm(p.deviations[0]!.explanation)).toContain("42003");
    checkIdentity(p);
  });

  it("samma rad två gånger i specifikationen", () => {
    const p = only(
      run([
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 19_600,
          feesOre: 0,
          lines: [
            { externalId: "42001", amountOre: 4900 },
            { externalId: "42002", amountOre: 4900 },
            { externalId: "42003", amountOre: 4900 },
            { externalId: "42003", amountOre: 4900 },
          ],
        },
      ]),
    );
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["duplicate-payout", 4900]]);
    expect(norm(p.deviations[0]!.title)).toBe("1 order betalas två gånger");
    expect(norm(p.deviations[0]!.explanation)).toContain(
      "förekommer flera gånger i specifikationen",
    );
    checkIdentity(p);
  });

  it("order som redan betalats i en tidigare utbetalning", () => {
    const res = run([
      {
        reference: "U-a",
        period: { start: "2026-11-01", end: "2026-11-15" },
        amountOre: 9800,
        feesOre: 0,
        lines: [
          { externalId: "42001", amountOre: 4900 },
          { externalId: "42002", amountOre: 4900 },
        ],
      },
      {
        reference: "U-b",
        period: { start: "2026-11-16", end: "2026-11-30" },
        amountOre: 9800,
        feesOre: 0,
        lines: [
          { externalId: "42002", amountOre: 4900 },
          { externalId: "42003", amountOre: 4900 },
        ],
      },
    ]);
    const [a, b] = res.payouts;
    expect(a!.status).toBe("matched");
    expect(b!.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["duplicate-payout", 4900]]);
    expect(norm(b!.deviations[0]!.explanation)).toContain("ingår redan i U-a");
    expect(b!.overlapsWith).toEqual(["U-a"]);
    checkIdentity(b!);
  });

  it("samma referens två gånger: den andra är en dubblett och väntas vara 0 kr", () => {
    const payout: Payout = { reference: "U-11", period: "2026-11", amountOre: 14_700, feesOre: 0 };
    const res = run([payout, { ...payout }]);
    expect(res.payouts.map((p) => p.key)).toEqual(["U-11", "U-11#2"]);
    expect(res.payouts[0]!.status).toBe("matched");
    const dup = res.payouts[1]!;
    expect(dup.expected.payoutOre).toBe(0);
    expect(dup.differenceOre).toBe(14_700);
    expect(dup.deviations.map((d) => [d.kind, d.impactOre, d.key])).toEqual([
      ["duplicate-payout", 14_700, "U-11#2:duplicate-payout"],
    ]);
    expect(dup.status).toBe("deviation");
    expect(res.totals.differenceOre).toBe(14_700);
  });

  it("överlappande perioder utan specifikation: dagarna betalas två gånger", () => {
    // U-a 1–15 nov (o1, o2 = 9 800). U-b 10–30 nov, men 10–15 nov ingår redan i U-a.
    // U-b:s egna dagar 16–30 nov: o3 = 4 900. Leverantören betalar 9 800 (o2 + o3).
    // Skillnad +4 900 = överlappet (o2 på 10 nov).
    const res = run([
      {
        reference: "U-b",
        period: { start: "2026-11-10", end: "2026-11-30" },
        amountOre: 9800,
        feesOre: 0,
      },
      {
        reference: "U-a",
        period: { start: "2026-11-01", end: "2026-11-15" },
        amountOre: 9800,
        feesOre: 0,
      },
    ]);
    expect(res.payouts.map((p) => p.reference)).toEqual(["U-a", "U-b"]);
    const b = res.payouts[1]!;
    expect(b.expected.salesOre).toBe(4900);
    expect(b.differenceOre).toBe(4900);
    expect(b.overlapsWith).toEqual(["U-a"]);
    expect(b.deviations.map((d) => [d.kind, d.confidence, d.impactOre])).toEqual([
      ["duplicate-payout", "inferred", 4900],
    ]);
    expect(norm(b.deviations[0]!.explanation)).toContain("6 dagar (10–15 nov.) ingår redan i U-a");
    checkIdentity(b);
  });
});

describe("avvikelse: belopp, period och återbetalningar", () => {
  it("beloppsavvikelse på en order", () => {
    const p = only(
      run([
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 14_500,
          feesOre: 0,
          lines: [
            { externalId: "42001", amountOre: 4900 },
            { externalId: "42002", amountOre: 4700 },
            { externalId: "42003", amountOre: 4900 },
          ],
        },
      ]),
    );
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["amount-mismatch", -200]]);
    expect(p.deviations[0]!.evidence.orderIds).toEqual(["o2"]);
    expect(norm(p.deviations[0]!.explanation)).toContain("totalt -2,00 kr");
  });

  it("order från en annan period som tidszonen inte förklarar", () => {
    const orders = [...NOV, order("o0", "41000", "2026-09-15")];
    const p = only(
      reconcilePayouts({
        orders,
        payouts: [
          {
            reference: "U-11",
            period: "2026-11",
            amountOre: 19_600,
            feesOre: 0,
            lines: [
              { externalId: "41000", amountOre: 4900 },
              { externalId: "42001", amountOre: 4900 },
              { externalId: "42002", amountOre: 4900 },
              { externalId: "42003", amountOre: 4900 },
            ],
          },
        ],
        settings: SETTINGS,
        options: { coverage: { start: "2026-11-01", end: "2026-11-30" } },
      }),
    );
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["period-shift", 4900]]);
    expect(norm(p.deviations[0]!.explanation)).toContain("15 sep.");
  });

  it("återbetalning som vi känner till dras från väntat belopp", () => {
    const p = only(
      run([{ reference: "U-11", period: "2026-11", amountOre: 9800, feesOre: 0 }], {
        refunds: [{ id: "r1", date: "2026-11-21", amountOre: 4900, orderId: "o3" }],
      }),
    );
    expect(p.expected.refundsOre).toBe(4900);
    expect(p.expected.payoutOre).toBe(9800);
    expect(p.status).toBe("matched");
  });

  it("leverantören drar en återbetalning som vi inte känner till", () => {
    const p = only(
      run([
        { reference: "U-11", period: "2026-11", amountOre: 9800, feesOre: 0, refundsOre: 4900 },
      ]),
    );
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["refund", -4900]]);
    expect(norm(p.deviations[0]!.explanation)).toContain("drog 49,00 kr i återbetalningar");
    checkIdentity(p);
  });

  it("oförklarad rest och avrundning inom toleransen", () => {
    const unexplained = only(
      run([{ reference: "U", period: "2026-11", amountOre: 14_823, feesOre: 0 }]),
    );
    expect(unexplained.deviations.map((d) => [d.kind, d.impactOre])).toEqual([
      ["unexplained", 123],
    ]);
    expect(norm(unexplained.deviations[0]!.title)).toBe("+1,23 kr är oförklarat");

    const rounding = only(
      run([{ reference: "U", period: "2026-11", amountOre: 14_702, feesOre: 0 }], {
        options: { toleranceOre: 2 },
      }),
    );
    expect(rounding.status).toBe("matched");
    expect(rounding.roundingOre).toBe(2);
    expect(norm(rounding.summary)).toContain("Stämmer (avrundning +0,02 kr).");
    checkIdentity(rounding);
  });

  it("specifikation som inte summerar till utbetalningen ger oförklarad rest", () => {
    const p = only(
      run([
        {
          reference: "U",
          period: "2026-11",
          amountOre: 14_800,
          feesOre: 0,
          lines: NOV.map((o) => ({ externalId: o.externalId, amountOre: o.amountOre })),
        },
      ]),
    );
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["unexplained", 100]]);
    expect(norm(p.deviations[0]!.explanation)).toContain("Specifikationen summerar till 147,00 kr");
  });
});

describe("avvikelse: tidsförskjutning över periodgräns (tidszon)", () => {
  // 31 okt. 17:30 svensk tid (CET) = 16:30Z = 1 nov. 00:30 i Asia/Shanghai.
  const late = order("o-late", "42780", "2026-10-31", 4900, "2026-10-31T16:30:00Z");
  // 30 nov. 18:00 svensk tid = 17:00Z = 1 dec. 01:00 i Asia/Shanghai.
  const lateNov = order("o-late-nov", "42999", "2026-11-30", 5900, "2026-11-30T17:00:00Z");
  // 1 nov. 17:17 svensk tid = 2 nov. 00:17 i Shanghai: samma period, ingen förskjutning.
  const doc = order("o-doc", "42781", "2026-11-01", 4900, "2026-11-01T16:17:00Z");
  const orders = [late, doc, lateNov];
  const options = { providerTimeZone: "Asia/Shanghai" };

  it("utan specifikation: oktober saknar en order, november får den, båda förklaras", () => {
    // Leverantören (Shanghai): okt = inget, nov = late + doc = 9 800, dec = lateNov.
    // Hos oss: okt = late (4 900), nov = doc + lateNov (10 800).
    const res = reconcilePayouts({
      orders,
      payouts: [
        { reference: "U-10", period: "2026-10", amountOre: 0, feesOre: 0 },
        { reference: "U-11", period: "2026-11", amountOre: 9800, feesOre: 0 },
      ],
      settings: SETTINGS,
      options,
    });
    const [oct, nov] = res.payouts;
    expect(oct!.differenceOre).toBe(-4900);
    expect(oct!.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["timezone-shift", -4900]]);
    expect(oct!.status).toBe("explained");
    expect(nov!.differenceOre).toBe(9800 - 10_800);
    expect(nov!.deviations.map((d) => [d.kind, d.impactOre])).toEqual([
      ["timezone-shift", 4900 - 5900],
    ]);
    expect(nov!.deviations[0]!.evidence.orderIds).toEqual(["o-late", "o-late-nov"]);
    expect(nov!.deviations[0]!.requiresAction).toBe(false);
    expect(nov!.status).toBe("explained");
    const text = norm(oct!.deviations[0]!.explanation);
    expect(text).toContain("Asia/Shanghai");
    expect(text).toContain(
      "order 42780 betalades 31 okt. 17:30 svensk tid = 1 nov. 00:30 i Asia/Shanghai",
    );
    expect(norm(nov!.summary)).toContain("beror på tidszonen");
    expect(res.totals.openDeviations).toBe(0);
    checkIdentity(oct!);
    checkIdentity(nov!);
  });

  it("med specifikation: raden för 42780 i novemberutbetalningen förklaras av tidszonen", () => {
    const p = reconcilePayouts({
      orders,
      payouts: [
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 9800,
          feesOre: 0,
          lines: [
            { externalId: "42780", amountOre: 4900 },
            { externalId: "42781", amountOre: 4900 },
          ],
        },
      ],
      settings: SETTINGS,
      options: { ...options, coverage: { start: "2026-11-01", end: "2026-11-30" } },
    }).payouts[0]!;
    const tz = p.deviations.find((d) => d.kind === "timezone-shift")!;
    expect(tz.impactOre).toBe(4900 - 5900);
    expect(tz.orderCount).toBe(2);
    expect(p.deviations.map((d) => d.kind)).toEqual(["timezone-shift"]);
    checkIdentity(p);
  });

  it("utan leverantörens tidszon letas ingen förskjutning", () => {
    const res = reconcilePayouts({
      orders,
      payouts: [{ reference: "U-11", period: "2026-11", amountOre: 9800, feesOre: 0 }],
      settings: SETTINGS,
    });
    expect(res.payouts[0]!.deviations.map((d) => d.kind)).not.toContain("timezone-shift");
  });

  it("leverantör i UTC: order 1 nov. 00:30 svensk tid hör till oktober hos leverantören", () => {
    // 1 nov. 00:30 CET = 31 okt. 23:30Z.
    const early = order("o-early", "43000", "2026-11-01", 4900, "2026-10-31T23:30:00Z");
    const res = reconcilePayouts({
      orders: [early],
      payouts: [
        { reference: "U-10", period: "2026-10", amountOre: 4900, feesOre: 0 },
        { reference: "U-11", period: "2026-11", amountOre: 0, feesOre: 0 },
      ],
      settings: SETTINGS,
      options: { providerTimeZone: "UTC" },
    });
    expect(res.payouts.map((p) => [p.reference, p.status, p.differenceOre])).toEqual([
      ["U-10", "explained", 4900],
      ["U-11", "explained", -4900],
    ]);
  });
});

describe("försäljning utan utbetalning", () => {
  it("oktober har försäljning men ingen utbetalning mellan september och november", () => {
    const orders = [
      order("s1", "41001", "2026-09-10"),
      order("x1", "41501", "2026-10-05"),
      order("x2", "41502", "2026-10-06", 5900),
      ...NOV,
    ];
    const res = reconcilePayouts({
      orders,
      payouts: [
        { reference: "U-09", period: "2026-09", amountOre: 4900, feesOre: 0 },
        { reference: "U-11", period: "2026-11", amountOre: 14_700, feesOre: 0 },
      ],
      settings: SETTINGS,
    });
    expect(res.uncovered).toHaveLength(1);
    const d = res.uncovered[0]!;
    expect(d.key).toBe("missing-payout:2026-10");
    expect(d.payoutKey).toBeNull();
    expect(d.impactOre).toBe(-10_800);
    expect(d.evidence.dates).toEqual(["2026-10-05", "2026-10-06"]);
    expect(norm(d.title)).toBe("Ingen utbetalning för 2 dagar med försäljning (5–6 okt.)");
    expect(norm(res.summary)).toContain("Försäljning 108 kr på 2 dagar saknar utbetalning.");
    expect(res.totals.openDeviations).toBe(1);
  });

  it("försäljning efter sista utbetalningen räknas inte som saknad utan `coverage`", () => {
    const orders = [...NOV, order("d1", "43001", "2026-12-02")];
    const res = reconcilePayouts({
      orders,
      payouts: [{ reference: "U-11", period: "2026-11", amountOre: 14_700, feesOre: 0 }],
      settings: SETTINGS,
    });
    expect(res.uncovered).toEqual([]);
    const withCoverage = reconcilePayouts({
      orders,
      payouts: [{ reference: "U-11", period: "2026-11", amountOre: 14_700, feesOre: 0 }],
      settings: SETTINGS,
      options: { coverage: "2026-12" },
    });
    expect(withCoverage.uncovered.map((d) => d.key)).toEqual(["missing-payout:2026-12"]);
  });
});

describe("status utredd", () => {
  const payouts: Payout[] = [
    { reference: "U-11", period: "2026-11", amountOre: 14_400, feesOre: 300 },
  ];

  it("en utredning med rätt fingerprint gör avvikelsen och utbetalningen utredd", () => {
    const first = only(run(payouts));
    const fee = first.deviations[0]!;
    expect(fee.key).toBe("U-11:fee");
    expect(fee.fingerprint).toBe("-300|0");
    const res = run(payouts, {
      resolutions: [
        {
          key: fee.key,
          fingerprint: fee.fingerprint,
          note: "Ny prislista från Awish",
          resolvedBy: "u1",
        },
      ],
    });
    const p = only(res);
    expect(p.deviations[0]!.status).toBe("investigated");
    expect(p.deviations[0]!.resolution?.note).toBe("Ny prislista från Awish");
    expect(p.status).toBe("investigated");
    expect(res.totals.investigatedDeviations).toBe(1);
    expect(res.totals.openDeviations).toBe(0);
    expect(res.staleResolutions).toEqual([]);
    expect(norm(p.summary)).toContain("Skillnaden -3,00 kr är utredd.");
  });

  it("ändras avvikelsen gäller inte utredningen längre", () => {
    const res = run([{ ...payouts[0]!, amountOre: 14_200, feesOre: 500 }], {
      resolutions: [{ key: "U-11:fee", fingerprint: "-300|0", note: "x" }],
    });
    expect(only(res).status).toBe("deviation");
    expect(res.staleResolutions.map((r) => r.key)).toEqual(["U-11:fee"]);
  });

  it("utredning utan fingerprint gäller alltid; okänd nyckel blir inaktuell", () => {
    const res = run(payouts, {
      resolutions: [
        { key: "U-11:fee", note: "ok" },
        { key: "U-99:fee", note: "gammal" },
      ],
    });
    expect(only(res).status).toBe("investigated");
    expect(res.staleResolutions.map((r) => r.key)).toEqual(["U-99:fee"]);
  });
});

describe("alla avvikelsetyper på en gång", () => {
  it("varje utbetalning går ihop exakt och resultatet beror inte på ordningen i indata", () => {
    const orders: AnalyticsOrder[] = [
      order("a1", "50001", "2026-10-02"),
      order("a2", "50002", "2026-10-12", 5900),
      order("a3", "50003", "2026-10-31", 4900, "2026-10-31T20:00:00Z"),
      order("a4", "50004", "2026-10-20"),
      order("a4b", "50004", "2026-10-20"),
      order("b1", "50101", "2026-11-03"),
      order("b2", "50102", "2026-11-04", 12_900),
      order("b3", "50103", "2026-11-30", 5900, "2026-11-30T22:00:00Z"),
      order("b4", "50104", "2026-11-10"),
      order("c1", "50201", "2026-12-24"),
    ];
    const payouts: Payout[] = [
      {
        reference: "OKT",
        period: "2026-10",
        // Leverantören: a1 + a2 + a4 (a3 räknas till november i Shanghai) − 500 avgift + 1,23 kr.
        amountOre: 4900 + 5900 + 4900 - 500 + 123,
        feesOre: 500,
      },
      {
        reference: "NOV",
        period: "2026-11",
        amountOre: 30_000,
        feesOre: 0,
        refundsOre: 0,
        lines: [
          { externalId: "50003", amountOre: 4900 },
          { externalId: "50101", amountOre: 4900 },
          { externalId: "50102", amountOre: 12_000 },
          { externalId: "50101", amountOre: 4900 },
          { externalId: "59999", amountOre: 3300 },
        ],
      },
      // Samma referens igen (för december): dubblett. December-ordern saknar då utbetalning.
      { reference: "OKT", period: "2026-12", amountOre: 100, feesOre: 0 },
    ];
    const input: ReconciliationInput = {
      orders,
      payouts,
      settings: SETTINGS,
      refunds: [{ id: "r1", date: "2026-11-15", amountOre: 1000 }],
      options: {
        providerTimeZone: "Asia/Shanghai",
        coverage: { start: "2026-10-01", end: "2026-12-31" },
      },
    };
    const res = reconcilePayouts(input);
    for (const p of res.payouts) checkIdentity(p);
    // NOV: väntat 4 900 + 12 900 + 5 900 + 4 900 − 1 000 = 27 600; utbetalt 30 000 → +2 400.
    // +4 900 tidszon (50003) − 5 900 tidszon (50103) − 900 belopp (50102) + 4 900 dubblettrad
    // (50101) + 3 300 saknas i import (59999) − 4 900 saknas i utbetalning (50104)
    // + 1 000 återbetalning som leverantören inte drog = 2 400.
    // OKT: väntat 25 500 (a1, a2, a3, a4, a4b); utbetalt 15 323 → −10 177 = −500 avgift
    // − 4 900 dubblett (a4b) − 4 900 tidszon (a3) + 123 oförklarat.
    const okt = res.payouts.find((p) => p.key === "OKT")!;
    expect(okt.deviations.map((d) => [d.kind, d.impactOre])).toEqual([
      ["duplicate-order", -4900],
      ["fee", -500],
      ["timezone-shift", -4900],
      ["unexplained", 123],
    ]);
    const nov = res.payouts.find((p) => p.reference === "NOV")!;
    expect(nov.differenceOre).toBe(2400);
    expect(nov.deviations.map((d) => [d.kind, d.impactOre])).toEqual([
      ["missing-in-payout", -4900],
      ["missing-in-sales", 3300],
      ["duplicate-payout", 4900],
      ["amount-mismatch", -900],
      ["refund", 1000],
      ["timezone-shift", -1000],
    ]);
    const kinds = new Set([
      ...res.payouts.flatMap((p) => p.deviations.map((d) => d.kind)),
      ...res.uncovered.map((d) => d.kind),
    ]);
    for (const k of [
      "fee",
      "refund",
      "missing-in-sales",
      "missing-in-payout",
      "duplicate-order",
      "duplicate-payout",
      "amount-mismatch",
      "timezone-shift",
      "missing-payout",
      "unexplained",
    ]) {
      expect(kinds, k).toContain(k);
    }

    const reversed = reconcilePayouts({
      ...input,
      orders: [...orders].reverse(),
      payouts: [...payouts].reverse(),
    });
    expect(reversed).toEqual(res);
  });
});

describe("ogiltig indata", () => {
  it("kastar tydliga fel", () => {
    expect(() => run([{ reference: "U", period: "2026-13", amountOre: 0, feesOre: 0 }])).toThrow(
      /ÅÅÅÅ-MM/,
    );
    expect(() =>
      run([
        {
          reference: "U",
          period: { start: "2026-11-30", end: "2026-11-01" },
          amountOre: 0,
          feesOre: 0,
        },
      ]),
    ).toThrow(/slutar/);
    expect(() => run([{ reference: "U", period: "2026-11", amountOre: 1.5, feesOre: 0 }])).toThrow(
      /heltal/,
    );
    expect(() => run([{ reference: "", period: "2026-11", amountOre: 0, feesOre: 0 }])).toThrow(
      /referens/,
    );
    expect(() =>
      reconcilePayouts({ orders: [NOV[0]!, NOV[0]!], payouts: [], settings: SETTINGS }),
    ).toThrow(/två gånger/);
    expect(() =>
      run([{ reference: "U", period: "2026-11", amountOre: 0, feesOre: 0 }], {
        options: { feeBp: 20_000 },
      }),
    ).toThrow(/baspunkter/);
  });

  it("inga utbetalningar", () => {
    const res = run([]);
    expect(res.payouts).toEqual([]);
    expect(res.summary).toBe("Inga utbetalningar att stämma av.");
  });
});

describe("rättningar efter revisionen", () => {
  // 31 okt. 17:30 svensk tid = 1 nov. 00:30 i Asia/Shanghai; 1 nov. 17:17 = 2 nov. 00:17.
  const late = order("o-late", "42780", "2026-10-31", 4900, "2026-10-31T16:30:00Z");
  const doc = order("o-doc", "42781", "2026-11-01", 4900, "2026-11-01T16:17:00Z");
  const tz = { providerTimeZone: "Asia/Shanghai" };

  it("tidszon: en utbetalning som stämmer exakt får inga påhittade avvikelser", () => {
    // Leverantören betalar oktober på svenska dagar: late = 4 900 = väntat, skillnad 0.
    const res = reconcilePayouts({
      orders: [late, doc],
      payouts: [{ reference: "U-10", period: "2026-10", amountOre: 4900, feesOre: 0 }],
      settings: SETTINGS,
      options: tz,
    });
    const p = res.payouts[0]!;
    expect(p.differenceOre).toBe(0);
    expect(p.deviations).toEqual([]);
    expect(p.status).toBe("matched");
  });

  it("tidszon utan specifikation är härledd, med specifikation belagd", () => {
    const without = reconcilePayouts({
      orders: [late, doc],
      payouts: [{ reference: "U-10", period: "2026-10", amountOre: 0, feesOre: 0 }],
      settings: SETTINGS,
      options: tz,
    }).payouts[0]!;
    expect(without.deviations.map((d) => [d.kind, d.confidence])).toEqual([
      ["timezone-shift", "inferred"],
    ]);
    const withLines = reconcilePayouts({
      orders: [late, doc],
      payouts: [
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 9800,
          feesOre: 0,
          lines: [
            { externalId: "42780", amountOre: 4900 },
            { externalId: "42781", amountOre: 4900 },
          ],
        },
      ],
      settings: SETTINGS,
      options: { ...tz, coverage: "2026-11" },
    }).payouts[0]!;
    expect(withLines.deviations.map((d) => [d.kind, d.confidence])).toEqual([
      ["timezone-shift", "confirmed"],
    ]);
  });

  it("chooseTimezoneShift: förskjutningen antas bara när den minskar skillnaden", () => {
    const a = { amountOre: 4900 };
    const b = { amountOre: 5900 };
    // Skillnad 0: ingen förskjutning (inte ens om in och ut tar ut varandra).
    expect(chooseTimezoneShift(0, [a], [a])).toEqual({ inOrders: [], outOrders: [] });
    // −4 900 och en order ut à 4 900: ut förklarar allt.
    expect(chooseTimezoneShift(-4900, [], [a])).toEqual({ inOrders: [], outOrders: [a] });
    // −1 000 = +4 900 − 5 900: båda riktningarna.
    expect(chooseTimezoneShift(-1000, [a], [b])).toEqual({ inOrders: [a], outOrders: [b] });
    // +4 900: bara in (rest 0); båda ger rest 5 900.
    expect(chooseTimezoneShift(4900, [a], [b])).toEqual({ inOrders: [a], outOrders: [] });
    // +100: ingen förskjutning gör det bättre (|100| < |100 − 4 900|).
    expect(chooseTimezoneShift(100, [a], [])).toEqual({ inOrders: [], outOrders: [] });
  });

  it("splitRounding: toleransen gäller avgift och rest tillsammans", () => {
    expect(splitRounding(1, 0, 5)).toEqual({
      roundingOre: 1,
      feeIsRounding: true,
      residualIsRounding: false,
    });
    expect(splitRounding(-37, 0, 5)).toEqual({
      roundingOre: 0,
      feeIsRounding: false,
      residualIsRounding: false,
    });
    // Rest 4 är avrundning; avgift 3 + 4 = 7 > 5 → avgiften visas.
    expect(splitRounding(3, 4, 5)).toEqual({
      roundingOre: 4,
      feeIsRounding: false,
      residualIsRounding: true,
    });
    // −3 + 4 = 1 ≤ 5 → båda är avrundning.
    expect(splitRounding(-3, 4, 5)).toEqual({
      roundingOre: 1,
      feeIsRounding: true,
      residualIsRounding: true,
    });
    expect(splitRounding(0, 0, 0)).toEqual({
      roundingOre: 0,
      feeIsRounding: false,
      residualIsRounding: false,
    });
    expect(splitRounding(1, 0, 0).feeIsRounding).toBe(false);
  });

  it("avgift avrundad på totalen (1 öre) är avrundning med tolerans, avvikelse utan", () => {
    // 3 × 4 900, 250 bp: vi 3 × 123 = 369, leverantören round(367,5) = 368.
    // Utbetalt 14 700 − 368 = 14 332, väntat 14 331, skillnad +1.
    const settings: Settings = { vatRateBp: 0, cardFeeBp: 250 };
    const payout: Payout = {
      reference: "U-11",
      period: "2026-11",
      amountOre: 14_332,
      feesOre: 368,
    };
    const tolerant = run([payout], { settings, options: { toleranceOre: 5 } });
    const p = only(tolerant);
    expect(p.differenceOre).toBe(1);
    expect(p.status).toBe("matched");
    expect(p.roundingOre).toBe(1);
    expect(p.deviations).toEqual([]);
    expect(norm(p.summary)).toBe(
      "U-11 (1–30 nov.): utbetalt 143,32 kr, väntat 143,31 kr. Stämmer (avrundning +0,01 kr).",
    );
    // Toleransen per referens gäller bara den utbetalningen: en annan referens (t.ex. en
    // importerad rad bredvid en som är inskriven för hand) visar fortfarande skillnaden.
    const other = only(
      run([payout], { settings, options: { toleranceOreByReference: { "U-99": 500 } } }),
    );
    expect(other.status).not.toBe("matched");
    expect(other.roundingOre).toBe(0);
    const own = only(
      run([payout], { settings, options: { toleranceOreByReference: { "U-11": 500 } } }),
    );
    expect(own.status).toBe("matched");
    expect(own.roundingOre).toBe(1);
    const strict = only(run([payout], { settings }));
    expect(strict.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["fee", 1]]);
    expect(strict.status).toBe("deviation");
  });

  it("toleransen döljer inte saknade order även om nettot är 0", () => {
    // 42003 saknas i utbetalningen (−4 900), 42999 saknas hos oss (+4 900): skillnad 0.
    const p = only(
      run(
        [
          {
            reference: "U-11",
            period: "2026-11",
            amountOre: 14_700,
            feesOre: 0,
            lines: [
              { externalId: "42001", amountOre: 4900 },
              { externalId: "42002", amountOre: 4900 },
              { externalId: "42999", amountOre: 4900 },
            ],
          },
        ],
        { options: { toleranceOre: 100 } },
      ),
    );
    expect(p.differenceOre).toBe(0);
    expect(p.deviations.map((d) => d.kind)).toEqual(["missing-in-payout", "missing-in-sales"]);
    expect(p.status).toBe("deviation");
  });

  it("underlaget bär leverantörens ordernummer, även för order som saknas hos oss", () => {
    const p = only(
      run([
        {
          reference: "U-11",
          period: "2026-11",
          amountOre: 14_700,
          feesOre: 0,
          lines: [
            { externalId: "42001", amountOre: 4900 },
            { externalId: "42002", amountOre: 4900 },
            { externalId: "42999", amountOre: 4900 },
            { externalId: "42999", amountOre: 4900 },
          ],
        },
      ]),
    );
    const ms = p.deviations.find((d) => d.kind === "missing-in-sales")!;
    expect(ms.evidence.orderIds).toEqual([]);
    expect(ms.evidence.externalOrderIds).toEqual(["42999"]);
    const dup = p.deviations.find((d) => d.kind === "duplicate-payout")!;
    expect(dup.evidence.externalOrderIds).toEqual(["42999"]);
    const mp = p.deviations.find((d) => d.kind === "missing-in-payout")!;
    expect(mp.evidence.orderIds).toEqual(["o3"]);
    expect(mp.evidence.externalOrderIds).toEqual(["42003"]);
    checkIdentity(p);
  });
});

describe("läsbar formatering i avstämningens texter", () => {
  it("avgiften i procent, aldrig i baspunkter", () => {
    expect(norm(feeBasisText(175, 0))).toBe("1,75 % av försäljningen");
    expect(norm(feeBasisText(150, 0))).toBe("1,5 % av försäljningen");
    expect(norm(feeBasisText(200, 200))).toBe("2 % av försäljningen plus 2,00 kr per order");
    expect(norm(feeBasisText(0, 200))).toBe("2,00 kr per order");
    expect(feeBasisText(0, 0)).toBe("ingen avgift");
    expect(feeBasisText(0, 0)).not.toMatch(/bp/);
  });

  it("sammanfattningen i hela kronor, med ören bara när skillnaden är under en krona", () => {
    const n = (s: { actual: string; expected: string; difference: string }) =>
      `${norm(s.actual)} / ${norm(s.expected)} / ${norm(s.difference)}`;
    expect(n(summaryAmounts(7_391_200, 7_462_500))).toBe("73 912 kr / 74 625 kr / -713 kr");
    expect(n(summaryAmounts(19_600, 19_600))).toBe("196 kr / 196 kr / ±0 kr");
    expect(n(summaryAmounts(37_500, 37_437))).toBe("375,00 kr / 374,37 kr / +0,63 kr");
  });
});
