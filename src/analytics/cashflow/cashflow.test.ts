/**
 * Kassaflöde. Förväntade belopp är uträknade för hand i kommentarerna.
 *
 * Scenario: i dag 15 nov. 2026. En order à 49,00 kr om dagen 1 okt.–14 nov. (45 order).
 * Automat m1 står i butik s1: provision 10 %, hyra 1 000 kr/månad. Oktober betalades ut 5 nov.
 */

import { describe, expect, it } from "vitest";
import { addDays, eachDay, type OrderLine } from "@/domain";
import { cashflow, inferPayoutCycle, storePaymentMonth, sumCashItems } from "./cashflow";
import type { CashflowInput } from "./types";

const norm = (s: string) => s.replace(/ /g, " ").replace(/−/g, "-");

const ORDERS: OrderLine[] = eachDay("2026-10-01", "2026-11-14").map((d, i) => ({
  id: `o${i}`,
  externalId: String(42000 + i),
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
      monthlyRentOre: 100_000,
    },
  ],
  placements: [{ machineId: "m1", storeId: "s1", from: "2026-01-01", to: null }],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
  payouts: [
    { reference: "U-10", period: "2026-10", amountOre: 151_900, feesOre: 0, paidOn: "2026-11-05" },
  ],
  purchases: [
    { id: "p1", date: "2026-10-10", amountOre: 50_000, status: "paid", label: "Pokémon Nordic" },
    { id: "p2", date: "2026-11-20", amountOre: 80_000, status: "planned" },
    { id: "p3", date: "2026-11-01", amountOre: 20_000, status: "planned" },
  ],
  fixedCosts: [
    {
      id: "ins",
      name: "Försäkring",
      amountOre: 300_000,
      interval: "quarter",
      start: "2026-10-01",
      end: null,
    },
    {
      id: "sw",
      name: "Kassasystem",
      amountOre: 10_000,
      interval: "month",
      start: "2026-01-15",
      end: null,
    },
  ],
  asOf: "2026-11-15",
  range: { start: "2026-10-01", end: "2026-12-31" },
  granularity: "month",
  options: { openingBalanceOre: 500_000 },
};

describe("cashflow: per månad", () => {
  const r = cashflow(BASE);

  it("prognosunderlaget: 28 dagar 18 okt.–14 nov., 28 order à 49 kr; utbetalning månadsvis 5 dagar efter", () => {
    expect(r.basis).toEqual({
      window: { start: "2026-10-18", end: "2026-11-14" },
      windowDays: 28,
      windowOrders: 28,
      windowSalesOre: 137_200,
      windowCommissionOre: 13_720,
      payoutCycle: "month",
      payoutLagDays: 5,
    });
    expect(norm(r.assumptions[0]!)).toBe(
      "Prognosen bygger på försäljningen 18 okt. –\u2060 14 nov. (28 dagar): 1 372 kr, i snitt 49 kr per dag.",
    );
    expect(norm(r.assumptions[1]!)).toBe(
      "Utbetalningar kommer månadsvis, 5 dagar efter periodens slut (som U-10).",
    );
  });

  it("väntad novemberutbetalning 5 dec.: 14 kända order + round(137 200 × 16 / 28) = 68 600 + 78 400", () => {
    const item = r.items.find((i) => i.key === "payout-forecast:2026-11-01")!;
    expect(item.date).toBe("2026-12-05");
    expect(item.amountOre).toBe(147_000);
    expect(item.phase).toBe("forecast");
    expect(item.evidence.orderIds).toHaveLength(14);
    expect(item.evidence.figures.find((f) => f.key === "forecastSalesOre")?.value).toBe(78_400);
    // Decemberutbetalningen kommer 5 jan., utanför intervallet.
    expect(r.items.some((i) => i.key === "payout-forecast:2026-12-01")).toBe(false);
  });

  it("butiksersättning betalas sista dagen månaden efter: sep. 1 000 kr, okt. 1 151,90 kr, nov. 1 147 kr", () => {
    const comp = r.items.filter((i) => i.kind === "store-compensation");
    expect(comp.map((i) => [i.key, i.date, i.amountOre, i.phase])).toEqual([
      ["store-compensation:2026-09", "2026-10-31", 100_000, "actual"],
      // 31 order × 490 provision + 100 000 hyra.
      ["store-compensation:2026-10", "2026-11-30", 115_190, "forecast"],
      // 14 × 490 kända + round(13 720 × 16 / 28) = 7 840 prognos + 100 000 hyra.
      ["store-compensation:2026-11", "2026-12-31", 114_700, "forecast"],
    ]);
    expect(norm(comp[1]!.label)).toBe(
      "Butiksersättning för oktober (provision 152 kr, hyra 1 000 kr)",
    );
  });

  it("inköp: betalt på sitt datum, planerat som prognos, försenat planerat flyttas till i morgon", () => {
    const p = r.items.filter((i) => i.kind === "purchase");
    expect(p.map((i) => [i.key, i.date, i.phase, i.overdue])).toEqual([
      ["purchase:p1", "2026-10-10", "actual", false],
      ["purchase:p3", "2026-11-16", "forecast", true],
      ["purchase:p2", "2026-11-20", "forecast", false],
    ]);
    expect(p[0]!.label).toBe("Inköp Pokémon Nordic");
  });

  it("fasta kostnader på betalningsdagarna", () => {
    const f = r.items.filter((i) => i.kind === "fixed-cost");
    expect(f.map((i) => [i.key, i.amountOre, i.phase])).toEqual([
      ["fixed:ins:2026-10-01", 300_000, "actual"],
      ["fixed:sw:2026-10-15", 10_000, "actual"],
      ["fixed:sw:2026-11-15", 10_000, "actual"],
      ["fixed:sw:2026-12-15", 10_000, "forecast"],
    ]);
    expect(norm(f[0]!.label)).toBe("Försäkring 3 000 kr per kvartal");
  });

  it("buckets: oktober faktisk, november blandad, december prognos; saldot går under noll i november", () => {
    expect(
      r.buckets.map((b) => [b.key, b.phase, b.total.inOre, b.total.outOre, b.total.netOre]),
    ).toEqual([
      // Ut: 100 000 butik + 50 000 inköp + 300 000 + 10 000 fasta.
      ["2026-10", "actual", 0, 460_000, -460_000],
      // In: U-10 151 900. Ut: 10 000 + 20 000 + 80 000 + 115 190.
      ["2026-11", "mixed", 151_900, 225_190, -73_290],
      // In: 147 000. Ut: 10 000 + 114 700.
      ["2026-12", "forecast", 147_000, 124_700, 22_300],
    ]);
    const nov = r.buckets[1]!;
    expect(nov.actual.netOre).toBe(141_900);
    expect(nov.forecast.netOre).toBe(-215_190);
    expect(r.buckets.map((b) => b.closingBalanceOre)).toEqual([40_000, -33_290, -10_990]);
    expect(r.lowestBalance).toEqual({ bucketKey: "2026-11", balanceOre: -33_290 });
    expect(norm(nov.summary)).toBe(
      "November 2026 (prognos från 16 nov.): in 1 519 kr, ut 2 252 kr, netto -733 kr, saldo -333 kr.",
    );
    expect(nov.evidence.payoutReferences).toEqual(["U-10"]);
    expect(nov.evidence.purchaseIds).toEqual(["p2", "p3"]);
    expect(norm(r.summary)).toContain("Saldot blir negativt i november 2026: -333 kr.");
    expect(norm(r.summary)).toContain("1 post är försenad (Planerat inköp)");
  });

  it("summan av buckets = totalen = faktiskt + prognos", () => {
    const sum = r.buckets.reduce((s, b) => s + b.total.netOre, 0);
    expect(sum).toBe(r.totals.total.netOre);
    expect(r.totals.actual.netOre + r.totals.forecast.netOre).toBe(r.totals.total.netOre);
    expect(sumCashItems(r.items)).toEqual(r.totals.total);
  });

  it("resultatet beror inte på ordningen i indata", () => {
    const shuffled = cashflow({
      ...BASE,
      orders: [...ORDERS].reverse(),
      purchases: [...BASE.purchases].reverse(),
      fixedCosts: [...BASE.fixedCosts].reverse(),
    });
    expect(shuffled).toEqual(r);
  });
});

describe("cashflow: varianter", () => {
  it("per vecka: ISO-veckor med delvisa veckor i kanterna", () => {
    const r = cashflow({
      ...BASE,
      granularity: "week",
      range: { start: "2026-11-01", end: "2026-11-30" },
    });
    expect(r.buckets.map((b) => [b.key, b.partial])).toEqual([
      ["2026-W44", true],
      ["2026-W45", false],
      ["2026-W46", false],
      ["2026-W47", false],
      ["2026-W48", false],
      ["2026-W49", true],
    ]);
    // v. 46 slutar i dag (15 nov.) och är faktisk; v. 47 är prognos.
    expect(r.buckets.map((b) => b.phase)).toEqual([
      "actual",
      "actual",
      "actual",
      "forecast",
      "forecast",
      "forecast",
    ]);
    expect(norm(r.buckets[1]!.summary)).toMatch(/^Vecka 45 \(2–8 nov\.\)/);
  });

  it("utbetalning som uteblivit: oktober väntades 5 nov. men saknas → försenad i morgon", () => {
    const r = cashflow({
      ...BASE,
      payouts: [
        { reference: "U-09", period: "2026-09", amountOre: 0, feesOre: 0, paidOn: "2026-10-05" },
      ],
    });
    const late = r.items.find((i) => i.key === "payout-forecast:2026-10-01")!;
    expect(late.overdue).toBe(true);
    expect(late.date).toBe("2026-11-16");
    expect(late.amountOre).toBe(31 * 4900);
    expect(norm(late.label)).toBe("Utbetalning för 1–31 okt. väntades 5 nov. men saknas");
  });

  it("faktiska butiksbetalningar ersätter avtalsberäkningen för det som har hänt", () => {
    const r = cashflow({
      ...BASE,
      storePayments: [{ id: "sp1", storeId: "s1", paidOn: "2026-10-28", amountOre: 99_000 }],
    });
    const comp = r.items.filter((i) => i.kind === "store-compensation");
    expect(comp.map((i) => [i.key, i.amountOre])).toEqual([
      ["store-payment:sp1", 99_000],
      ["store-compensation:2026-10", 115_190],
      ["store-compensation:2026-11", 114_700],
    ]);
  });

  it("utan försäljning finns ingen prognos för utbetalningar", () => {
    const r = cashflow({ ...BASE, orders: [], payouts: [] });
    expect(r.basis.window).toBeNull();
    expect(r.items.filter((i) => i.kind === "payout")).toEqual([]);
    expect(r.assumptions[0]).toContain("ingen försäljning");
    expect(r.lowestBalance).not.toBeNull();
  });

  it("utan ingående saldo visas inget saldo", () => {
    const r = cashflow({ ...BASE, options: {} });
    expect(r.buckets.every((b) => b.closingBalanceOre === null)).toBe(true);
    expect(r.lowestBalance).toBeNull();
  });

  it("veckovis utbetalning med kortavgift", () => {
    const r = cashflow({
      ...BASE,
      settings: { vatRateBp: 0, cardFeeBp: 250 },
      payouts: [
        {
          reference: "W45",
          period: { start: "2026-11-02", end: "2026-11-08" },
          amountOre: 7 * (4900 - 123),
          feesOre: 7 * 123,
          paidOn: "2026-11-10",
        },
      ],
      range: { start: "2026-11-01", end: "2026-11-30" },
      granularity: "week",
    });
    expect(r.basis.payoutCycle).toBe("week");
    expect(r.basis.payoutLagDays).toBe(2);
    // v. 46 (9–15 nov.): 6 kända order (9–14 nov.) à 4 900 − 123 + prognos 1 dag (15 nov.):
    // round(137 200 × 1 / 28) = 4 900 − round(4 900 × 250 / 10 000) = 123.
    const w46 = r.items.find((i) => i.key === "payout-forecast:2026-11-09")!;
    expect(w46.date).toBe("2026-11-17");
    expect(w46.amountOre).toBe(7 * (4900 - 123));
  });

  it("utbetalningsrytm ur perioden", () => {
    expect(inferPayoutCycle({ start: "2026-11-01", end: "2026-11-30" })).toBe("month");
    expect(inferPayoutCycle({ start: "2026-11-02", end: "2026-11-08" })).toBe("week");
    expect(inferPayoutCycle({ start: "2026-11-01", end: "2026-11-14" })).toEqual({ days: 14 });
  });

  it("ogiltig indata", () => {
    expect(() => cashflow({ ...BASE, granularity: "day" as "week" })).toThrow(/Indelningen/);
    expect(() => cashflow({ ...BASE, asOf: "2026-02-30" })).toThrow();
    expect(() =>
      cashflow({ ...BASE, purchases: [...BASE.purchases, { ...BASE.purchases[0]! }] }),
    ).toThrow(/två gånger/);
    expect(() => cashflow({ ...BASE, options: { payoutCycle: { days: 0 } } })).toThrow(/rytmen/);
    expect(() => cashflow({ ...BASE, options: { storeCompensationDueDay: 32 } })).toThrow(/1–31/);
  });

  it("i dag i början av intervallet: allt efter är prognos", () => {
    const r = cashflow({ ...BASE, asOf: addDays("2026-10-01", -1) });
    expect(r.buckets.every((b) => b.phase === "forecast")).toBe(true);
  });
});

describe("cashflow: butiksbetalningar kopplas till butik och månad", () => {
  // Butiksersättning i BASE: sep. 100 000 (hyra, förfaller 31 okt.), okt. 31 × 490 + 100 000
  // = 115 190 (30 nov.), nov. 114 700 (31 dec.).
  it("storePaymentMonth: angiven månad, annars månaden vars ersättning förfaller samma månad", () => {
    const sp = { id: "x", storeId: "s1", paidOn: "2026-11-10", amountOre: 1 };
    expect(storePaymentMonth(sp, 1)).toBe("2026-10");
    expect(storePaymentMonth(sp, 0)).toBe("2026-11");
    expect(storePaymentMonth({ ...sp, paidOn: "2027-01-05" }, 1)).toBe("2026-12");
    expect(storePaymentMonth({ ...sp, month: "2026-08" }, 1)).toBe("2026-08");
    expect(() => storePaymentMonth({ ...sp, month: "2026-13" }, 1)).toThrow(/ÅÅÅÅ-MM/);
  });

  it("ersättning betald i förväg (oktober betald 10 nov.) räknas en gång", () => {
    const r = cashflow({
      ...BASE,
      storePayments: [
        { id: "sp-sep", storeId: "s1", paidOn: "2026-10-31", amountOre: 100_000 },
        { id: "sp-okt", storeId: "s1", paidOn: "2026-11-10", amountOre: 115_190 },
      ],
    });
    const comp = r.items.filter((i) => i.kind === "store-compensation");
    expect(comp.map((i) => [i.key, i.date, i.amountOre, i.overdue])).toEqual([
      ["store-payment:sp-sep", "2026-10-31", 100_000, false],
      ["store-payment:sp-okt", "2026-11-10", 115_190, false],
      ["store-compensation:2026-11", "2026-12-31", 114_700, false],
    ]);
    expect(r.buckets[1]!.total.storeCompensationOre).toBe(115_190);
    expect(norm(comp[1]!.label)).toBe("Betalning till butik för oktober");
    expect(comp[1]!.evidence.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("obetald förfallen ersättning ligger kvar som försenad i morgon", () => {
    const r = cashflow({ ...BASE, storePayments: [] });
    const sep = r.items.find((i) => i.key === "store-compensation:2026-09")!;
    expect(sep).toMatchObject({
      date: "2026-11-16",
      amountOre: 100_000,
      overdue: true,
      phase: "forecast",
    });
    expect(norm(sep.label)).toBe(
      "Butiksersättning för september förföll 31 okt. men är inte betald (1 000 kr)",
    );
    expect(r.totals.total.storeCompensationOre).toBe(100_000 + 115_190 + 114_700);
    expect(norm(r.summary)).toContain("2 poster är försenade");
  });

  it("sen betalning med angiven månad ersätter rätt månad", () => {
    // Septembers ersättning betalades först 10 nov.; utan `month` hade den räknats som oktober.
    const r = cashflow({
      ...BASE,
      storePayments: [
        { id: "late", storeId: "s1", paidOn: "2026-11-10", amountOre: 100_000, month: "2026-09" },
      ],
    });
    const keys = r.items.filter((i) => i.kind === "store-compensation").map((i) => i.key);
    expect(keys).toEqual([
      "store-payment:late",
      "store-compensation:2026-10",
      "store-compensation:2026-11",
    ]);
  });

  it("två butiker: bara den obetalda butikens del ligger kvar", () => {
    // s2 har hyra 30 000/mån men ingen automat. September: s1 100 000 + s2 30 000.
    // s1 betalar 31 okt.; s2:s 30 000 är obetald → försenad i morgon.
    const r = cashflow({
      ...BASE,
      agreements: [
        ...BASE.agreements,
        {
          storeId: "s2",
          validFrom: "2026-01-01",
          validTo: null,
          commissionBp: 0,
          monthlyRentOre: 30_000,
        },
      ],
      storePayments: [{ id: "s1-sep", storeId: "s1", paidOn: "2026-10-31", amountOre: 100_000 }],
    });
    const sep = r.items.find((i) => i.key === "store-compensation:2026-09")!;
    expect(sep).toMatchObject({ amountOre: 30_000, overdue: true, date: "2026-11-16" });
    expect(sep.evidence.storeIds).toEqual(["s2"]);
    expect(sep.evidence.figures.find((f) => f.key === "paidOre")?.value).toBe(100_000);
  });

  it("utan registrerade butiksbetalningar antas ersättningen betald enligt plan", () => {
    const r = cashflow(BASE);
    const sep = r.items.find((i) => i.key === "store-compensation:2026-09")!;
    expect(sep).toMatchObject({ date: "2026-10-31", overdue: false, phase: "actual" });
  });
});
