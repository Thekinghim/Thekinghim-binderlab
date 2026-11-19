/**
 * Avtalsperioder i följd i samma kalendermånad med samma villkor visas som en period i
 * uträkningen. Ingenting räknas om: summorna och förlustgolvet per avtal och månad är exakt
 * de som liggaren räknar.
 *
 * Ägarens fall: en butik med vinstdelning 50 %, ett avtal 14 okt.–2 nov. och ett nytt från
 * 3 nov. med samma villkor, rapport för 14 okt.–14 nov. Förut stod tre perioder (14–31 okt.,
 * 1–2 nov., 3–14 nov.); nu står oktober och november.
 */

import { describe, expect, it } from "vitest";

import { buildLedger, type Period, type StoreAgreement } from "@/domain";

import { buildStoreReport, splitsOf } from "./store-report";
import { ord, price, sources } from "./testing/fixtures";

const plain = (s: string) => s.replace(/ | /g, " ");

const split = (
  validFrom: string,
  validTo: string | null,
  extra: Partial<StoreAgreement> = {},
): StoreAgreement => ({
  storeId: "s-1",
  validFrom,
  validTo,
  commissionBp: 5_000,
  monthlyRentOre: null,
  commissionBase: "profit_after_costs",
  lossTreatment: "zero",
  ...extra,
});

const PERIOD: Period = { start: "2026-10-14", end: "2026-11-14" };
/** Inköp 130,01 kr: vinsten per pack blir ett udda antal ören, så avrundningen syns. */
const prices = [price("t-a", 13_001, "2026-01-01")];
const orders = [
  // 14–31 okt.: två pack.
  ord("2026-10-14", { amountOre: 19_900 }),
  ord("2026-10-31", { amountOre: 19_900 }),
  // 1–2 nov. (första avtalet): ett pack.
  ord("2026-11-02", { amountOre: 19_900 }),
  // 3–14 nov. (nya avtalet): tre pack.
  ord("2026-11-03", { amountOre: 19_900 }),
  ord("2026-11-10", { amountOre: 19_900 }),
  ord("2026-11-14", { amountOre: 19_900 }),
  // Utanför rapporten.
  ord("2026-11-15", { amountOre: 19_900 }),
];
const REAL = [split("2026-10-14", "2026-11-02"), split("2026-11-03", null)];

function build(agreements: StoreAgreement[], extra: Partial<Parameters<typeof sources>[0]> = {}) {
  const src = sources({ orders, prices, agreements, ...extra });
  const report = buildStoreReport(src, "s-1", PERIOD);
  // "Dagens resultat": liggarens vinstdelningar, en per avtal och kalendermånad.
  const ledger = buildLedger({ ...src, period: PERIOD }).profitSplits.filter(
    (x) => x.storeId === "s-1",
  );
  return { report, c: report.compensation, ledger };
}

describe("ägarens fall: 14–31 okt., 1–2 nov. och 3–14 nov. med 50 %", () => {
  const { c, ledger } = build(REAL);

  it("liggaren räknar tre vinstdelningar, som förut", () => {
    expect(ledger.map((x) => [x.validFrom, x.month])).toEqual([
      ["2026-10-14", "2026-10"],
      ["2026-10-14", "2026-11"],
      ["2026-11-03", "2026-11"],
    ]);
  });

  it("uträkningen visar oktober och november", () => {
    const splits = splitsOf(c);
    expect(splits.map((x) => x.range)).toEqual([
      { start: "2026-10-14", end: "2026-10-31" },
      { start: "2026-11-01", end: "2026-11-14" },
    ]);
    expect(c.steps.map((s) => plain(s.label))).toEqual([
      "Er andel 50 % (14–31 okt. 2026)",
      "Er andel 50 % (1–14 nov. 2026)",
      "Er ersättning",
    ]);
    expect(splits.map((x) => x.orders)).toEqual([2, 4]);
  });

  it("varje belopp är summan av liggarens delar, exakt", () => {
    const [oct, nov] = splitsOf(c);
    const of = (month: string) => ledger.filter((x) => x.month === month).map((x) => x.result);
    for (const [row, parts] of [
      [oct!, of("2026-10")],
      [nov!, of("2026-11")],
    ] as const) {
      const sum = (pick: (r: (typeof parts)[number]) => number) =>
        parts.reduce((n, r) => n + pick(r), 0);
      expect(row.salesInclVatOre).toBe(sum((r) => r.salesInclVatOre));
      expect(row.purchasesOre).toBe(sum((r) => r.purchasesOre));
      expect(row.cardFeesOre).toBe(sum((r) => r.cardFeesOre));
      expect(row.vmbVatOre).toBe(sum((r) => r.vmbVatOre));
      expect(row.profitOre).toBe(sum((r) => r.profitOre));
      expect(row.storeShareOre).toBe(sum((r) => r.storeShareOre));
      expect(row.operatorShareOre).toBe(row.profitOre - row.storeShareOre);
    }
    // Handräknat. Vinst per pack 19 900 − 13 001 = 6 899 öre.
    // Oktober: 2 pack, vinst 13 798, andel 6 899.
    expect(oct).toMatchObject({ profitOre: 13_798, storeShareOre: 6_899 });
    // November: 1–2 nov. vinst 6 899 → 3 450 (3 449,5 avrundas uppåt); 3–14 nov. vinst
    // 20 697 → 10 349 (10 348,5 uppåt). Summa 13 799, ett öre mer än 50 % av 27 596.
    expect(nov).toMatchObject({ profitOre: 27_596, storeShareOre: 13_799 });
    expect(c.shareOre).toBe(6_899 + 13_799);
    expect(c.totalOre).toBe(ledger.reduce((n, x) => n + x.result.storeShareOre, 0));
  });

  it("öresavrundningen per avtalsperiod står i uträkningen", () => {
    expect(c.steps.map((s) => plain(s.calculation))).toEqual([
      "50 % av 137,98 kr = 68,99 kr",
      "50 % av 275,96 kr = 137,99 kr (avrundat per avtalsperiod)",
      "Andel 206,98 kr",
    ]);
  });

  it("avtalet står en gång, från första dagen", () => {
    expect(plain(c.modelText)).toBe(
      "50 % av vinsten efter kostnader, giltigt från 14 oktober 2026.",
    );
  });

  it("villkoren utan datum (raden om ett muntligt avtal)", () => {
    expect(plain(c.termsText ?? "")).toBe("50 % av vinsten efter kostnader");
  });

  it("underlaget säger att perioden är flera avtalsperioder", () => {
    const nov = splitsOf(c)[1]!;
    expect(plain(nov.evidence.rule)).toContain(
      "Perioden är 2 avtalsperioder i följd med samma villkor (1–2 nov. 2026, 3–14 nov. 2026)",
    );
    expect(nov.evidence.orderCount).toBe(4);
  });
});

describe("samma resultat som utan sammanslagning", () => {
  it("ett enda avtal hela tiden ger samma månadsrader", () => {
    const one = build([split("2026-10-14", null)]);
    const two = build(REAL);
    expect(splitsOf(two.c).map((x) => x.range)).toEqual(splitsOf(one.c).map((x) => x.range));
    expect(splitsOf(two.c).map((x) => x.profitOre)).toEqual(
      splitsOf(one.c).map((x) => x.profitOre),
    );
    // Andelen kan skilja på öret (avrundat per avtalsperiod), aldrig mer.
    expect(Math.abs(two.c.totalOre - one.c.totalOre)).toBeLessThanOrEqual(1);
  });

  it("hela november: de två avtalen blir en rad utan datum", () => {
    const src = sources({ orders, prices, agreements: REAL });
    const c = buildStoreReport(src, "s-1", "2026-11").compensation;
    expect(splitsOf(c)).toHaveLength(1);
    expect(splitsOf(c)[0]!.range).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(plain(c.steps[0]!.label)).toBe("Er andel 50 %");
    const ledger = buildLedger({ ...src, period: { start: "2026-11-01", end: "2026-11-30" } });
    expect(c.totalOre).toBe(
      ledger.profitSplits
        .filter((x) => x.storeId === "s-1")
        .reduce((n, x) => n + x.result.storeShareOre, 0),
    );
  });
});

describe("slås inte ihop", () => {
  it("över ett månadsskifte: oktober och november står alltid var för sig", () => {
    const { c } = build([split("2026-10-14", null)]);
    expect(splitsOf(c)).toHaveLength(2);
  });

  it("olika villkor: andel, förlusthantering, VMB eller hyra", () => {
    for (const other of [
      { commissionBp: 4_000 },
      { lossTreatment: "proportional" as const },
      { vmbBeforeSplit: true },
      { monthlyRentOre: 50_000 },
    ]) {
      const { c, ledger } = build([
        split("2026-10-14", "2026-11-02"),
        split("2026-11-03", null, other),
      ]);
      expect(
        splitsOf(c).map((x) => x.range.start),
        JSON.stringify(other),
      ).toEqual(["2026-10-14", "2026-11-01", "2026-11-03"]);
      expect(c.shareOre).toBe(ledger.reduce((n, x) => n + x.result.storeShareOre, 0));
    }
  });

  it("ett glapp mellan avtalen", () => {
    const { c } = build([split("2026-10-14", "2026-11-02"), split("2026-11-05", null)]);
    expect(splitsOf(c).map((x) => x.range.start)).toEqual([
      "2026-10-14",
      "2026-11-01",
      "2026-11-05",
    ]);
  });

  it("förlust i en avtalsperiod och vinst i nästa: golvet per avtal syns, som förut", () => {
    // 1–2 nov.: ett pack sålt under inköpspriset (förlust, andel 0 kr). 3–14 nov.: vinst.
    const { c, ledger } = build(REAL, {
      orders: [
        ord("2026-10-20", { amountOre: 19_900 }),
        ord("2026-11-02", { amountOre: 10_000 }),
        ord("2026-11-10", { amountOre: 19_900 }),
      ],
    });
    const splits = splitsOf(c);
    expect(splits.map((x) => [x.range.start, x.profitOre, x.storeShareOre])).toEqual([
      ["2026-10-14", 6_899, 3_450],
      ["2026-11-01", -3_001, 0],
      ["2026-11-03", 6_899, 3_450],
    ]);
    // Sammanslaget hade raden sagt "50 % av 38,98 kr = 34,50 kr": den går inte att räkna efter.
    expect(c.shareOre).toBe(6_900);
    expect(c.shareOre).toBe(ledger.reduce((n, x) => n + x.result.storeShareOre, 0));
  });

  it("förlust i båda avtalsperioderna slås ihop: 0 kr går att räkna efter", () => {
    const { c } = build(REAL, {
      orders: [ord("2026-11-02", { amountOre: 10_000 }), ord("2026-11-10", { amountOre: 12_000 })],
    });
    const nov = splitsOf(c).find((x) => x.range.start === "2026-11-01")!;
    expect(nov).toMatchObject({
      range: { start: "2026-11-01", end: "2026-11-14" },
      profitOre: -4_002,
      storeShareOre: 0,
    });
  });

  it("portalen (andelen inte räknad): delarna står kvar", () => {
    const src = sources({ orders, prices: [], agreements: REAL });
    const c = buildStoreReport(src, "s-1", PERIOD, { pendingSplit: true }).compensation;
    expect(splitsOf(c)).toHaveLength(3);
    expect(c.pending).toBe(true);
  });
});

describe("villkoren i klartext", () => {
  it("olika villkor i perioden räknas upp med sina datum", () => {
    const { c } = build([
      split("2026-10-14", "2026-11-02"),
      split("2026-11-03", null, { commissionBp: 4_000, monthlyRentOre: 50_000 }),
    ]);
    expect(plain(c.termsText ?? "")).toBe(
      "14 okt.–2 nov. 2026: 50 % av vinsten efter kostnader; 3–14 nov. 2026: 40 % av vinsten efter kostnader och hyra 500 kr per månad",
    );
  });

  it("utan avtal i perioden finns inga villkor", () => {
    const src = sources({ orders, prices });
    expect(buildStoreReport(src, "s-1", PERIOD).compensation.termsText).toBeUndefined();
  });
});

describe("provision och hyra ändras inte", () => {
  it("avtal med provision i följd står kvar per avtal (provisionen räknas per order)", () => {
    const commission = (from: string, to: string | null): StoreAgreement => ({
      storeId: "s-1",
      validFrom: from,
      validTo: to,
      commissionBp: 1_000,
      monthlyRentOre: null,
    });
    const src = sources({
      orders,
      agreements: [commission("2026-10-14", "2026-11-02"), commission("2026-11-03", null)],
    });
    const c = buildStoreReport(src, "s-1", PERIOD).compensation;
    expect(c.steps.filter((s) => s.kind === "commission")).toHaveLength(2);
    // Villkoren står ändå en gång.
    expect(plain(c.modelText)).toBe("Provision 10 % på kundernas betalning.");
    expect(plain(c.termsText ?? "")).toBe("provision 10 % på kundernas betalning");
  });
});
