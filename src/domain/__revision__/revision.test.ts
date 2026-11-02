/**
 * Oberoende revision av beräkningslagret (src/domain).
 *
 * Alla förväntade värden nedan är uträknade FÖR HAND (uträkningen står i kommentaren
 * vid varje scenario) utifrån reglerna i docs/berakningar.md. Inget facit hämtas från
 * funktionerna som testas; de enda generiska kontrollerna är identiteter (rader
 * summerar till totalen, vattenfallet går ihop) som gäller oberoende av siffrorna.
 *
 * Byggarna nedan är egna (inte testing/fixtures.ts) så att revisionen inte delar
 * hjälpkod med det som granskas.
 *
 * Kör under tre tidszoner:
 *   for tz in UTC Europe/Stockholm Asia/Shanghai; do
 *     TZ=$tz npx vitest run -c src/domain/testing/vitest.tz.config.ts src/domain/__revision__
 *   done
 */

import { describe, expect, it } from "vitest";
import {
  DomainError,
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  UNALLOCATED_KEY,
  priceChangeImpact,
  priceHistory,
  profitability,
  profitabilityViews,
  titleEconomics,
  topContributor,
  type GroupBy,
  type OrderLine,
  type Placement,
  type ProfitabilityInput,
  type ProfitabilityResult,
  type ProfitabilityRow,
  type PurchasePrice,
  type Settings,
  type StoreAgreement,
} from "../index";

// ---------------------------------------------------------------------------
// Egna byggare
// ---------------------------------------------------------------------------

const NO_TAX: Settings = { vatRateBp: 0, cardFeeBp: 0 };
const VAT25_FEE250: Settings = { vatRateBp: 2500, cardFeeBp: 250 };

function o(
  id: string,
  titleId: string,
  machineId: string | null,
  businessDate: string,
  amountOre: number,
): OrderLine {
  return { id, externalId: `X-${id}`, titleId, machineId, businessDate, amountOre };
}

function p(titleId: string, unitCostOre: number, validFrom: string): PurchasePrice {
  return { titleId, unitCostOre, validFrom };
}

function ag(
  storeId: string,
  validFrom: string,
  validTo: string | null,
  commissionBp: number | null,
  monthlyRentOre: number | null,
): StoreAgreement {
  return { storeId, validFrom, validTo, commissionBp, monthlyRentOre };
}

function pl(machineId: string, storeId: string, from: string, to: string | null): Placement {
  return { machineId, storeId, from, to };
}

/** Plockar ut de fält revisionen räknat för hand. */
interface Expected {
  revenueOre: number;
  costOre: number;
  feesOre?: number;
  commissionOre: number;
  rentOre: number;
  profitOre: number;
  orders?: number;
  marginBp?: number | null;
}

function pick(row: ProfitabilityRow | undefined, e: Expected): Expected {
  if (!row) throw new Error("raden saknas");
  const out: Expected = {
    revenueOre: row.revenueOre,
    costOre: row.costOre,
    commissionOre: row.commissionOre,
    rentOre: row.rentOre,
    profitOre: row.profitOre,
  };
  if (e.feesOre !== undefined) out.feesOre = row.feesOre;
  if (e.orders !== undefined) out.orders = row.orders;
  if (e.marginBp !== undefined) out.marginBp = row.marginBp;
  return out;
}

function rowOf(r: ProfitabilityResult, key: string): ProfitabilityRow | undefined {
  return r.rows.find((x) => x.key === key);
}

const SUM_FIELDS = [
  "orders",
  "pricedOrders",
  "unpricedOrders",
  "grossOre",
  "vatOre",
  "revenueOre",
  "costOre",
  "feesOre",
  "commissionOre",
  "rentOre",
  "compensationOre",
  "profitOre",
  "unallocatedRentOre",
  "unpricedRevenueOre",
  "unpricedVatOre",
  "unpricedFeesOre",
  "unpricedCommissionOre",
  "unpricedRentOre",
  "unpricedCompensationOre",
] as const satisfies readonly (keyof ProfitabilityRow)[];

const ALL_VIEWS: readonly GroupBy[] = ["title", "machine", "store", "day", "week", "month"];

/**
 * Identiteter som måste gälla oavsett siffror:
 *  - raderna summerar exakt till totalen i varje fält, i varje vy
 *  - totalen är densamma i alla vyer
 *  - varje rad: vinst = intäkt − inköp − avgifter − (provision + hyra)
 *  - betalt = moms + intäkt + moms utan pris + intäkt utan pris
 *  - all hyra = Σ storeMonthRent
 *  - vattenfallet: intäkt + avdrag = vinst
 */
function assertIdentities(input: ProfitabilityInput): Record<GroupBy, ProfitabilityResult> {
  const views = profitabilityViews(input, ALL_VIEWS);
  const ref = views.title.totals;
  for (const g of ALL_VIEWS) {
    const r = views[g];
    for (const f of SUM_FIELDS) {
      let s = 0;
      for (const row of r.rows) s += row[f];
      expect(s, `${g}: Σ rader.${f} = totals.${f}`).toBe(r.totals[f]);
      expect(r.totals[f], `${g}: totals.${f} = title.totals.${f}`).toBe(ref[f]);
    }
    for (const row of [...r.rows, r.totals]) {
      expect(row.compensationOre).toBe(row.commissionOre + row.rentOre);
      expect(row.profitOre).toBe(
        row.revenueOre - row.costOre - row.feesOre - row.compensationOre,
      );
      expect(row.grossOre).toBe(
        row.vatOre + row.revenueOre + row.unpricedVatOre + row.unpricedRevenueOre,
      );
    }
    const rentAll = r.storeMonthRent.reduce((a, x) => a + x.rentOre, 0);
    expect(r.totals.rentOre + r.totals.unpricedRentOre).toBe(rentAll);

    const steps = r.waterfall.steps;
    expect(steps.map((s) => s.key)).toEqual(["revenue", "cost", "fees", "compensation", "profit"]);
    const deltas = steps.filter((s) => !s.total).reduce((a, s) => a + s.valueOre, 0);
    expect(deltas).toBe(steps[4]!.valueOre);
    expect(steps[4]!.valueOre).toBe(r.totals.profitOre);
  }
  return views;
}

// ---------------------------------------------------------------------------
// 1) Prisändring mitt i perioden
// ---------------------------------------------------------------------------

/**
 * Period 1–30 nov. 2026 (30 dagar). Ingen moms, ingen kortavgift.
 *
 * Butiker och avtal (gäller hela året):
 *   S1: provision 12 %                       (1 200 bp, ingen hyra)
 *   S2: hyra 1 500 kr/mån                    (150 000 öre, ingen provision)
 *   S3: provision 8 % + hyra 750 kr/mån      (800 bp, 75 000 öre)
 * Automater: M1 i S1, M2 i S2, M3 i S3, hela månaden.
 *
 * Priser:
 *   A: 20,00 från 1 sep., 25,00 från 16 nov.   (ändras mitt i perioden)
 *   B: 30,00 från 1 okt., 28,00 från 10 nov.   (ändras mitt i perioden)
 *
 *  order  titel automat datum   belopp  inköp  provision  hyra
 *  a1     A     M1      11-05   4 900   2 000    588         0
 *  a2     A     M1      11-16   4 900   2 500    588         0   (A:s ändringsdag → nytt pris)
 *  a3     B     M1      11-09   5 900   3 000    708         0   (dagen före B:s ändring)
 *  a4     B     M1      11-10   5 900   2 800    708         0   (B:s ändringsdag)
 *  b1     A     M2      11-15   4 900   2 000      0    44 012   (sista dagen med gamla A)
 *  b2     A     M2      11-20   4 900   2 500      0    44 012
 *  b3     B     M2      11-25   6 900   2 800      0    61 976
 *  c1     A     M3      11-01   4 900   2 000    392    22 006
 *  c2     B     M3      11-30   5 900   2 800    472    26 497
 *  c3     A     M3      11-30   5 900   2 500    472    26 497
 *
 * Hyra S2 = 150 000 på b1, b2, b3 efter netto 4 900/4 900/6 900 (Σ 16 700):
 *   b1 = 735 000 000 / 16 700 = 44 011 rest 16 300
 *   b2 = 44 011 rest 16 300
 *   b3 = 1 035 000 000 / 16 700 = 61 976 rest 800
 *   heltal 149 998, 2 öre över → b1, b2 (störst rest) → 44 012, 44 012, 61 976
 * Hyra S3 = 75 000 på c1, c2, c3 efter netto 4 900/5 900/5 900 (Σ 16 700):
 *   c1 = 367 500 000 / 16 700 = 22 005 rest 16 500
 *   c2 = c3 = 442 500 000 / 16 700 = 26 497 rest 100
 *   heltal 74 999, 1 öre över → c1 → 22 006, 26 497, 26 497
 *
 * Per butik (= per automat):
 *   S1: intäkt 21 600, inköp 10 300, prov 2 592, hyra 0,       vinst   8 708, marg 4 031
 *   S2: intäkt 16 700, inköp  7 300, prov     0, hyra 150 000, vinst −140 600, marg −84 192
 *   S3: intäkt 16 700, inköp  7 300, prov 1 336, hyra 75 000,  vinst −66 936,  marg −40 081
 * Per titel:
 *   A: intäkt 30 400, inköp 13 500, prov 2 040, hyra 136 527, vinst −121 667, marg −40 022
 *   B: intäkt 24 600, inköp 11 400, prov 1 888, hyra  88 473, vinst  −77 161, marg −31 366
 * Totalt: intäkt 55 000, inköp 24 900, prov 3 928, hyra 225 000, ers. 228 928,
 *   vinst 55 000 − 24 900 − 0 − 228 928 = −198 828, marginal −36 150,5 → −36 151 bp
 */
const NOV = { start: "2026-11-01", end: "2026-11-30" };

const S1_AGREEMENT = ag("S1", "2026-01-01", null, 1200, null);
const S2_AGREEMENT = ag("S2", "2026-01-01", null, null, 150_000);
const S3_AGREEMENT = ag("S3", "2026-01-01", null, 800, 75_000);

const SC1_PRICES = [
  p("A", 2000, "2026-09-01"),
  p("A", 2500, "2026-11-16"),
  p("B", 3000, "2026-10-01"),
  p("B", 2800, "2026-11-10"),
];

const SC1_ORDERS = [
  o("a1", "A", "M1", "2026-11-05", 4900),
  o("a2", "A", "M1", "2026-11-16", 4900),
  o("a3", "B", "M1", "2026-11-09", 5900),
  o("a4", "B", "M1", "2026-11-10", 5900),
  o("b1", "A", "M2", "2026-11-15", 4900),
  o("b2", "A", "M2", "2026-11-20", 4900),
  o("b3", "B", "M2", "2026-11-25", 6900),
  o("c1", "A", "M3", "2026-11-01", 4900),
  o("c2", "B", "M3", "2026-11-30", 5900),
  o("c3", "A", "M3", "2026-11-30", 5900),
];

const SC1: ProfitabilityInput = {
  orders: SC1_ORDERS,
  prices: SC1_PRICES,
  agreements: [S1_AGREEMENT, S2_AGREEMENT, S3_AGREEMENT],
  placements: [
    pl("M1", "S1", "2026-01-01", null),
    pl("M2", "S2", "2026-01-01", null),
    pl("M3", "S3", "2026-01-01", null),
  ],
  settings: NO_TAX,
  period: NOV,
};

describe(`revision 1: prisändring mitt i perioden (TZ=${process.env.TZ ?? "?"})`, () => {
  it("totalen stämmer med handräkningen", () => {
    const r = profitability(SC1, "title");
    expect(r.totals.orders).toBe(10);
    expect(r.totals.grossOre).toBe(55_000);
    expect(pick(r.totals, { marginBp: 0 } as Expected)).toEqual({
      revenueOre: 55_000,
      costOre: 24_900,
      commissionOre: 3_928,
      rentOre: 225_000,
      profitOre: -198_828,
      marginBp: -36_151,
    });
    expect(r.totals.feesOre).toBe(0);
    expect(r.totals.compensationOre).toBe(228_928);
    expect(r.unpriced.orders).toBe(0);
    expect(r.unpriced.shareBp).toBe(0);
  });

  it("per titel", () => {
    const r = profitability(SC1, "title");
    expect(r.rows.map((x) => x.key).sort()).toEqual(["A", "B"]);
    expect(pick(rowOf(r, "A"), { marginBp: 0 } as Expected)).toEqual({
      revenueOre: 30_400,
      costOre: 13_500,
      commissionOre: 2_040,
      rentOre: 136_527,
      profitOre: -121_667,
      marginBp: -40_022,
    });
    expect(pick(rowOf(r, "B"), { marginBp: 0 } as Expected)).toEqual({
      revenueOre: 24_600,
      costOre: 11_400,
      commissionOre: 1_888,
      rentOre: 88_473,
      profitOre: -77_161,
      marginBp: -31_366,
    });
  });

  it("per automat och per butik (samma siffror, en automat per butik)", () => {
    const v = profitabilityViews(SC1, ["machine", "store"]);
    const expected: Record<string, Expected> = {
      "1": {
        revenueOre: 21_600,
        costOre: 10_300,
        commissionOre: 2_592,
        rentOre: 0,
        profitOre: 8_708,
        marginBp: 4_031,
      },
      "2": {
        revenueOre: 16_700,
        costOre: 7_300,
        commissionOre: 0,
        rentOre: 150_000,
        profitOre: -140_600,
        marginBp: -84_192,
      },
      "3": {
        revenueOre: 16_700,
        costOre: 7_300,
        commissionOre: 1_336,
        rentOre: 75_000,
        profitOre: -66_936,
        marginBp: -40_081,
      },
    };
    for (const n of ["1", "2", "3"]) {
      const exp = expected[n]!;
      expect(pick(rowOf(v.machine, `M${n}`), exp), `M${n}`).toEqual(exp);
      expect(pick(rowOf(v.store, `S${n}`), exp), `S${n}`).toEqual(exp);
    }
    expect(v.machine.rows).toHaveLength(3);
    expect(v.store.rows).toHaveLength(3);
  });

  it("utan prisändringarna skulle vinsten vara exakt inköpsskillnaden högre/lägre", () => {
    // Utan A:s höjning 16 nov.: a2, b2, c3 kostar 2 000 i stället för 2 500 → inköp −1 500.
    const noAChange = profitability(
      { ...SC1, prices: SC1_PRICES.filter((x) => !(x.titleId === "A" && x.validFrom > "2026-11-01")) },
      "title",
    );
    expect(noAChange.totals.costOre).toBe(23_400);
    expect(noAChange.totals.profitOre).toBe(-197_328);
    // Utan B:s sänkning 10 nov.: a4, b3, c2 kostar 3 000 i stället för 2 800 → inköp +600.
    const noBChange = profitability(
      { ...SC1, prices: SC1_PRICES.filter((x) => !(x.titleId === "B" && x.validFrom > "2026-11-01")) },
      "title",
    );
    expect(noBChange.totals.costOre).toBe(25_500);
    expect(noBChange.totals.profitOre).toBe(-199_428);
    // Hyra och provision påverkas inte av inköpspriset.
    expect(noAChange.totals.compensationOre).toBe(228_928);
    expect(noBChange.totals.compensationOre).toBe(228_928);
  });

  it("förhandsvisningen av prisändringen stämmer", () => {
    const impact = priceChangeImpact({
      orders: SC1_ORDERS,
      prices: SC1_PRICES.filter((x) => !(x.titleId === "A" && x.validFrom === "2026-11-16")),
      change: { kind: "upsert", price: p("A", 2500, "2026-11-16") },
      closedMonths: ["2026-10"],
    });
    expect(impact.affectedOrders).toBe(3); // a2, b2, c3
    expect(impact.firstDate).toBe("2026-11-16");
    expect(impact.lastDate).toBe("2026-11-30");
    expect(impact.costBeforeOre).toBe(6_000);
    expect(impact.costAfterOre).toBe(7_500);
    expect(impact.costDeltaOre).toBe(1_500);
    expect(impact.closedMonthsAffected).toEqual([]);
  });

  it("prishistoriken: giltig till = dagen före nästa pris", () => {
    expect(priceHistory(SC1_PRICES, "A")).toEqual([
      { titleId: "A", unitCostOre: 2500, validFrom: "2026-11-16", validTo: null },
      { titleId: "A", unitCostOre: 2000, validFrom: "2026-09-01", validTo: "2026-11-15" },
    ]);
  });

  it("ett pris inlagt i efterhand för oktober påverkar inte november", () => {
    const r = profitability(
      { ...SC1, prices: [...SC1_PRICES, p("A", 9_999, "2026-10-15")] },
      "title",
    );
    // A:s pris 15 okt. ersätts av 25,00 först 16 nov.; order 1–15 nov. får 99,99.
    // a1 (11-05), b1 (11-15), c1 (11-01): 3 × (9 999 − 2 000) = +23 997 i inköp.
    expect(r.totals.costOre).toBe(24_900 + 23_997);
    expect(r.totals.profitOre).toBe(-198_828 - 23_997);
  });

  it("identiteterna håller i alla vyer", () => {
    const v = assertIdentities(SC1);
    expect(v.day.rows).toHaveLength(30);
    expect(v.month.rows).toHaveLength(1);
    expect(v.month.rows[0]!.partial).toBe(false);
  });

  it("samma scenario med moms 25 % och kortavgift 2,5 %", () => {
    /*
     * Per order (moms ur beloppet, kortavgift på belopp inkl. moms, provision på netto):
     *   4 900: moms 980,   netto 3 920, avgift round(122,5)=123, prov 12 % 470 (470,4), 8 % 314 (313,6)
     *   5 900: moms 1 180, netto 4 720, avgift round(147,5)=148, prov 12 % 566 (566,4), 8 % 378 (377,6)
     *   6 900: moms 1 380, netto 5 520, avgift round(172,5)=173
     * Netto = 0,8 × brutto för alla order, så hyresfördelningen blir densamma som utan moms.
     *
     * S1: netto 17 280, inköp 10 300, avg 542, prov 2 072, hyra 0       → vinst   4 366
     * S2: netto 13 360, inköp  7 300, avg 419, prov 0,     hyra 150 000 → vinst −144 359
     * S3: netto 13 360, inköp  7 300, avg 419, prov 1 070, hyra 75 000  → vinst  −70 429
     * A:  netto 24 320, inköp 13 500, avg 763, prov 1 632, hyra 136 527 → vinst −128 102
     * B:  netto 19 680, inköp 11 400, avg 617, prov 1 510, hyra 88 473  → vinst  −82 320
     * Totalt: netto 44 000, moms 11 000, inköp 24 900, avg 1 380, prov 3 142, hyra 225 000
     *   vinst 44 000 − 24 900 − 1 380 − 228 142 = −210 422, marginal −47 823,2 → −47 823 bp
     */
    const input = { ...SC1, settings: VAT25_FEE250 };
    const v = assertIdentities(input);
    const t = v.title.totals;
    expect(t.grossOre).toBe(55_000);
    expect(t.vatOre).toBe(11_000);
    expect(pick(t, { feesOre: 0, marginBp: 0 } as Expected)).toEqual({
      revenueOre: 44_000,
      costOre: 24_900,
      feesOre: 1_380,
      commissionOre: 3_142,
      rentOre: 225_000,
      profitOre: -210_422,
      marginBp: -47_823,
    });
    const st = (k: string) => pick(rowOf(v.store, k), { feesOre: 0 } as Expected);
    expect(st("S1")).toEqual({
      revenueOre: 17_280,
      costOre: 10_300,
      feesOre: 542,
      commissionOre: 2_072,
      rentOre: 0,
      profitOre: 4_366,
    });
    expect(rowOf(v.store, "S1")!.marginBp).toBe(2_527); // 43 660 000 / 17 280 = 2 526,6
    expect(st("S2")).toEqual({
      revenueOre: 13_360,
      costOre: 7_300,
      feesOre: 419,
      commissionOre: 0,
      rentOre: 150_000,
      profitOre: -144_359,
    });
    expect(st("S3")).toEqual({
      revenueOre: 13_360,
      costOre: 7_300,
      feesOre: 419,
      commissionOre: 1_070,
      rentOre: 75_000,
      profitOre: -70_429,
    });
    const ti = (k: string) => pick(rowOf(v.title, k), { feesOre: 0 } as Expected);
    expect(ti("A")).toEqual({
      revenueOre: 24_320,
      costOre: 13_500,
      feesOre: 763,
      commissionOre: 1_632,
      rentOre: 136_527,
      profitOre: -128_102,
    });
    expect(ti("B")).toEqual({
      revenueOre: 19_680,
      costOre: 11_400,
      feesOre: 617,
      commissionOre: 1_510,
      rentOre: 88_473,
      profitOre: -82_320,
    });
  });
});

// ---------------------------------------------------------------------------
// 2) Avtalsbyte mitt i månad, automat som flyttar, period över två månader
// ---------------------------------------------------------------------------

/**
 * Period 20 okt.–10 nov. 2026 (12 dagar i okt. av 31, 10 dagar i nov. av 30). Ingen moms.
 *
 * Avtal:
 *   S1: t.o.m. 4 nov. provision 12 %, ingen hyra; från 5 nov. provision 10 % + hyra 300 kr/mån.
 *   S2: hyra 1 500 kr/mån hela tiden.
 *   S3: t.o.m. 24 okt. 8 % + 750 kr/mån; från 25 okt. 8 % + 800 kr/mån.
 * Placeringar:
 *   M1 i S1 hela tiden. M3 i S3 hela tiden.
 *   M2 i S2 t.o.m. 31 okt., oplacerad 1–2 nov., i S3 från 3 nov.
 * Priser: A 20,00 från 1 sep.; B 30,00 från 1 sep., 33,00 från 1 nov.
 *
 * Hyra per butik och månad (avrundas en gång per butik-månad):
 *   S1 okt.: ingen hyra
 *   S1 nov.: 30 000 × 6 (5–10 nov.) / 30 = 6 000
 *   S2 okt.: 150 000 × 12 / 31 = 1 800 000 / 31 = 58 064,52 → 58 065
 *   S2 nov.: 150 000 × 10 / 30 = 50 000  (ingen automat där i nov. → ej fördelad)
 *   S3 okt.: (75 000 × 5 + 80 000 × 7) / 31 = 935 000 / 31 = 30 161,29 → 30 161
 *            (avrundat per avtal hade det blivit 12 097 + 18 065 = 30 162)
 *   S3 nov.: 80 000 × 10 / 30 = 26 666,67 → 26 667
 *
 *  order titel automat butik datum  belopp inköp prov   hyra
 *  p1    A     M1      S1    10-20  4 900  2 000  588       0
 *  p2    B     M1      S1    11-04  5 900  3 300  708   2 120  (sista dagen med 12 %)
 *  p3    A     M1      S1    11-05  4 900  2 000  490   1 760  (nytt avtal 10 %)
 *  p4    B     M1      S1    11-10  5 900  3 300  590   2 120
 *  q1    A     M2      S2    10-25  4 900  2 000    0  26 344
 *  q2    B     M2      S2    10-31  5 900  3 000    0  31 721  (sista dagen i S2)
 *  q3    A     M2      –     11-02  4 900  2 000    0       0  (oplacerad)
 *  q4    B     M2      S3    11-03  5 900  3 300  472  14 568  (efter flytten)
 *  r1    A     M3      S3    10-24  4 900  2 000  392  13 684
 *  r2    B     M3      S3    10-25  5 900  3 000  472  16 477
 *  r3    A     M3      S3    11-10  4 900  2 000  392  12 099
 *  + två order utanför perioden (19 okt. och 11 nov.) som inte räknas.
 *
 * Fördelning (största rest):
 *   S1 nov. 6 000 på p2/p3/p4 (5 900/4 900/5 900, Σ 16 700):
 *     2 119 r 12 700, 1 760 r 8 000, 2 119 r 12 700 → 5 998, +1 p2, +1 p4 → 2 120, 1 760, 2 120
 *   S2 okt. 58 065 på q1/q2 (4 900/5 900, Σ 10 800):
 *     26 344 r 3 300, 31 720 r 7 500 → +1 q2 → 26 344, 31 721
 *   S3 okt. 30 161 på r1/r2: 13 684 r 1 700, 16 476 r 9 100 → +1 r2 → 13 684, 16 477
 *   S3 nov. 26 667 på q4/r3 (5 900/4 900): 14 568 r 900, 12 098 r 9 900 → +1 r3 → 14 568, 12 099
 *
 * Totalt: intäkt 58 900, inköp 27 900, prov 4 104, hyra 120 893 + 50 000 ej fördelad = 170 893
 *   vinst 58 900 − 27 900 − 174 997 = −143 997, marginal −24 447,7 → −24 448 bp
 */
const SC2_PERIOD = { start: "2026-10-20", end: "2026-11-10" };
const SC2: ProfitabilityInput = {
  orders: [
    o("p0", "A", "M1", "2026-10-19", 4900), // utanför perioden
    o("p1", "A", "M1", "2026-10-20", 4900),
    o("p2", "B", "M1", "2026-11-04", 5900),
    o("p3", "A", "M1", "2026-11-05", 4900),
    o("p4", "B", "M1", "2026-11-10", 5900),
    o("p5", "B", "M1", "2026-11-11", 5900), // utanför perioden
    o("q1", "A", "M2", "2026-10-25", 4900),
    o("q2", "B", "M2", "2026-10-31", 5900),
    o("q3", "A", "M2", "2026-11-02", 4900),
    o("q4", "B", "M2", "2026-11-03", 5900),
    o("r1", "A", "M3", "2026-10-24", 4900),
    o("r2", "B", "M3", "2026-10-25", 5900),
    o("r3", "A", "M3", "2026-11-10", 4900),
  ],
  prices: [p("A", 2000, "2026-09-01"), p("B", 3000, "2026-09-01"), p("B", 3300, "2026-11-01")],
  agreements: [
    ag("S1", "2026-01-01", "2026-11-04", 1200, null),
    ag("S1", "2026-11-05", null, 1000, 30_000),
    ag("S2", "2026-01-01", null, null, 150_000),
    ag("S3", "2026-01-01", "2026-10-24", 800, 75_000),
    ag("S3", "2026-10-25", null, 800, 80_000),
  ],
  placements: [
    pl("M1", "S1", "2026-01-01", null),
    pl("M2", "S2", "2026-01-01", "2026-10-31"),
    pl("M2", "S3", "2026-11-03", null),
    pl("M3", "S3", "2026-01-01", null),
  ],
  settings: NO_TAX,
  period: SC2_PERIOD,
};

describe(`revision 2: avtalsbyte, flytt och period över två månader (TZ=${process.env.TZ ?? "?"})`, () => {
  it("hyra per butik och månad, avrundad en gång per butik-månad", () => {
    const r = profitability(SC2, "store");
    expect(r.storeMonthRent.map((x) => [x.storeId, x.month, x.rentOre, x.days])).toEqual([
      ["S1", "2026-11", 6_000, 6],
      ["S2", "2026-10", 58_065, 12],
      ["S2", "2026-11", 50_000, 10],
      ["S3", "2026-10", 30_161, 12],
      ["S3", "2026-11", 26_667, 10],
    ]);
  });

  it("totalen och diagnostiken", () => {
    const r = profitability(SC2, "title");
    expect(r.totals.orders).toBe(11);
    expect(pick(r.totals, { marginBp: 0 } as Expected)).toEqual({
      revenueOre: 58_900,
      costOre: 27_900,
      commissionOre: 4_104,
      rentOre: 170_893,
      profitOre: -143_997,
      marginBp: -24_448,
    });
    expect(r.totals.unallocatedRentOre).toBe(50_000);
    expect(r.diagnostics.ordersOutsidePeriod).toBe(2);
    expect(r.diagnostics.ordersWithoutStore).toBe(1);
    expect(r.diagnostics.machinesWithoutPlacement).toEqual(["M2"]);
  });

  it("per titel", () => {
    const r = profitability(SC2, "title");
    expect(pick(rowOf(r, "A"), {} as Expected)).toEqual({
      revenueOre: 29_400,
      costOre: 12_000,
      commissionOre: 1_862,
      rentOre: 53_887,
      profitOre: -38_349,
    });
    expect(pick(rowOf(r, "B"), {} as Expected)).toEqual({
      revenueOre: 29_500,
      costOre: 15_900,
      commissionOre: 2_242,
      rentOre: 67_006,
      profitOre: -55_648,
    });
    expect(pick(rowOf(r, UNALLOCATED_KEY), {} as Expected)).toEqual({
      revenueOre: 0,
      costOre: 0,
      commissionOre: 0,
      rentOre: 50_000,
      profitOre: -50_000,
    });
    expect(r.rows).toHaveLength(3);
  });

  it("per automat (flytten: M2:s order följer butiken för dagen)", () => {
    const r = profitability(SC2, "machine");
    expect(pick(rowOf(r, "M1"), { marginBp: 0 } as Expected)).toEqual({
      revenueOre: 21_600,
      costOre: 10_600,
      commissionOre: 2_376,
      rentOre: 6_000,
      profitOre: 2_624,
      marginBp: 1_215,
    });
    expect(pick(rowOf(r, "M2"), {} as Expected)).toEqual({
      revenueOre: 21_600,
      costOre: 10_300,
      commissionOre: 472,
      rentOre: 72_633,
      profitOre: -61_805,
    });
    expect(pick(rowOf(r, "M3"), {} as Expected)).toEqual({
      revenueOre: 15_700,
      costOre: 7_000,
      commissionOre: 1_256,
      rentOre: 42_260,
      profitOre: -34_816,
    });
    expect(rowOf(r, UNALLOCATED_KEY)?.profitOre).toBe(-50_000);
    expect(r.rows).toHaveLength(4);
  });

  it("per butik (ej fördelad hyra på butikens rad, oplacerad order på no-store)", () => {
    const r = profitability(SC2, "store");
    expect(pick(rowOf(r, "S1"), {} as Expected)).toEqual({
      revenueOre: 21_600,
      costOre: 10_600,
      commissionOre: 2_376,
      rentOre: 6_000,
      profitOre: 2_624,
    });
    expect(pick(rowOf(r, "S2"), {} as Expected)).toEqual({
      revenueOre: 10_800,
      costOre: 5_000,
      commissionOre: 0,
      rentOre: 108_065,
      profitOre: -102_265,
    });
    expect(rowOf(r, "S2")!.unallocatedRentOre).toBe(50_000);
    expect(pick(rowOf(r, "S3"), {} as Expected)).toEqual({
      revenueOre: 21_600,
      costOre: 10_300,
      commissionOre: 1_728,
      rentOre: 56_828,
      profitOre: -47_256,
    });
    expect(pick(rowOf(r, NO_STORE_KEY), {} as Expected)).toEqual({
      revenueOre: 4_900,
      costOre: 2_000,
      commissionOre: 0,
      rentOre: 0,
      profitOre: 2_900,
    });
    expect(r.rows).toHaveLength(4);
    expect(rowOf(r, UNALLOCATED_KEY)).toBeUndefined();
  });

  it("per månad (båda delvisa, ej fördelad hyra på november)", () => {
    const r = profitability(SC2, "month");
    expect(r.rows.map((x) => [x.key, x.range, x.partial])).toEqual([
      ["2026-10", { start: "2026-10-20", end: "2026-10-31" }, true],
      ["2026-11", { start: "2026-11-01", end: "2026-11-10" }, true],
    ]);
    expect(pick(rowOf(r, "2026-10"), {} as Expected)).toEqual({
      revenueOre: 26_500,
      costOre: 12_000,
      commissionOre: 1_452,
      rentOre: 88_226,
      profitOre: -75_178,
    });
    expect(pick(rowOf(r, "2026-11"), {} as Expected)).toEqual({
      revenueOre: 32_400,
      costOre: 15_900,
      commissionOre: 2_652,
      rentOre: 82_667,
      profitOre: -68_819,
    });
  });

  it("per vecka (ISO, delvisa veckor i kanterna)", () => {
    const r = profitability(SC2, "week");
    expect(r.rows.map((x) => [x.key, x.partial])).toEqual([
      ["2026-W43", true],
      ["2026-W44", false],
      ["2026-W45", false],
      ["2026-W46", true],
      [UNALLOCATED_KEY, false],
    ]);
    expect(rowOf(r, "2026-W43")!.range).toEqual({ start: "2026-10-20", end: "2026-10-25" });
    expect(rowOf(r, "2026-W46")!.range).toEqual({ start: "2026-11-09", end: "2026-11-10" });
    const profits = r.rows.map((x) => x.profitOre);
    expect(profits).toEqual([-46_357, -28_821, -9_118, -9_701, -50_000]);
    expect(r.rows.map((x) => x.rentOre)).toEqual([56_505, 31_721, 18_448, 14_219, 50_000]);
  });

  it("identiteterna håller i alla vyer", () => {
    assertIdentities(SC2);
  });

  it("resultatet beror inte på orderns ordning i indata", () => {
    const a = profitabilityViews(SC2, ALL_VIEWS);
    const b = profitabilityViews({ ...SC2, orders: [...SC2.orders].reverse() }, ALL_VIEWS);
    for (const g of ALL_VIEWS) expect(b[g].rows).toEqual(a[g].rows);
  });
});

// ---------------------------------------------------------------------------
// 3) Två titlar saknar pris
// ---------------------------------------------------------------------------

/**
 * November. M1 i S1 (12 %), M3 i S3 (8 % + 750 kr/mån).
 * Priser: A 20,00; B 30,00; C 35,00 först från 20 nov.; D saknar pris helt.
 *
 *  order titel automat datum belopp  pris?          prov  hyra
 *  u1    A     M1      11-02  4 900  ja, 2 000      588       0
 *  u2    C     M1      11-03  5 900  nej            708       0
 *  u3    D     M1      11-04 12 900  nej          1 548       0
 *  u4    A     M3      11-05  4 900  ja, 2 000      392  15 572
 *  u5    C     M3      11-06  5 900  nej            472  18 750
 *  u6    B     M3      11-07  6 900  ja, 3 000      552  21 928
 *  u7    C     M3      11-25  5 900  ja, 3 500      472  18 750
 *
 * Hyra S3 75 000 på u4/u5/u6/u7 (4 900/5 900/6 900/5 900, Σ 23 600):
 *   15 572 r 800, 18 750 r 0, 21 927 r 22 800, 18 750 r 0 → 74 999, +1 u6
 *
 * Prissatta (u1, u4, u6, u7): intäkt 22 600, inköp 10 500, prov 2 004, hyra 56 250
 *   vinst 22 600 − 10 500 − 58 254 = −46 154, marginal −20 422,1 → −20 422
 * Utan pris (u2, u3, u5): intäkt 24 700, prov 2 728, hyra 18 750 (C och D)
 * Andel utan pris: 24 700 × 10 000 / 47 300 = 5 221,99 → 5 222 bp
 */
const SC3: ProfitabilityInput = {
  orders: [
    o("u1", "A", "M1", "2026-11-02", 4900),
    o("u2", "C", "M1", "2026-11-03", 5900),
    o("u3", "D", "M1", "2026-11-04", 12900),
    o("u4", "A", "M3", "2026-11-05", 4900),
    o("u5", "C", "M3", "2026-11-06", 5900),
    o("u6", "B", "M3", "2026-11-07", 6900),
    o("u7", "C", "M3", "2026-11-25", 5900),
  ],
  prices: [p("A", 2000, "2026-01-01"), p("B", 3000, "2026-01-01"), p("C", 3500, "2026-11-20")],
  agreements: [S1_AGREEMENT, S3_AGREEMENT],
  placements: [pl("M1", "S1", "2026-01-01", null), pl("M3", "S3", "2026-01-01", null)],
  settings: NO_TAX,
  period: NOV,
};

describe(`revision 3: två titlar saknar pris (TZ=${process.env.TZ ?? "?"})`, () => {
  it("vinsten exkluderar order utan pris", () => {
    const r = profitability(SC3, "title");
    expect(pick(r.totals, { marginBp: 0, orders: 0 } as Expected)).toEqual({
      revenueOre: 22_600,
      costOre: 10_500,
      commissionOre: 2_004,
      rentOre: 56_250,
      profitOre: -46_154,
      marginBp: -20_422,
      orders: 7,
    });
    expect(r.totals.pricedOrders).toBe(4);
    expect(r.totals.unpricedOrders).toBe(3);
    expect(r.totals.unpricedRevenueOre).toBe(24_700);
    expect(r.totals.unpricedCommissionOre).toBe(2_728);
    expect(r.totals.unpricedRentOre).toBe(18_750);
    expect(r.totals.grossOre).toBe(47_300);
  });

  it("andelen oprissatt intäkt och listan över titlar", () => {
    const r = profitability(SC3, "title");
    expect(r.unpriced.orders).toBe(3);
    expect(r.unpriced.revenueOre).toBe(24_700);
    expect(r.unpriced.shareBp).toBe(5_222);
    expect(r.unpriced.titleIds).toEqual(["C", "D"]);
    expect(r.unpriced.byTitle).toEqual([
      { titleId: "D", orders: 1, revenueOre: 12_900, firstDate: "2026-11-04", lastDate: "2026-11-04" },
      { titleId: "C", orders: 2, revenueOre: 11_800, firstDate: "2026-11-03", lastDate: "2026-11-06" },
    ]);
    expect(r.waterfall.excluded.revenueOre).toBe(24_700);
    expect(r.waterfall.excluded.shareBp).toBe(5_222);
    expect(r.waterfall.steps.map((s) => s.valueOre)).toEqual([
      22_600, -10_500, 0, -58_254, -46_154,
    ]);
  });

  it("per titel: D helt utan pris ger vinst 0 och marginal –", () => {
    const r = profitability(SC3, "title");
    expect(pick(rowOf(r, "A"), {} as Expected)).toEqual({
      revenueOre: 9_800,
      costOre: 4_000,
      commissionOre: 980,
      rentOre: 15_572,
      profitOre: -10_752,
    });
    expect(pick(rowOf(r, "B"), {} as Expected)).toEqual({
      revenueOre: 6_900,
      costOre: 3_000,
      commissionOre: 552,
      rentOre: 21_928,
      profitOre: -18_580,
    });
    const c = rowOf(r, "C")!;
    expect(pick(c, {} as Expected)).toEqual({
      revenueOre: 5_900,
      costOre: 3_500,
      commissionOre: 472,
      rentOre: 18_750,
      profitOre: -16_822,
    });
    // C:s order utan pris är u2 (S1, prov 708, hyra 0) och u5 (S3, prov 472, hyra 18 750).
    expect([c.unpricedRevenueOre, c.unpricedCommissionOre, c.unpricedRentOre]).toEqual([
      11_800, 1_180, 18_750,
    ]);
    const d = rowOf(r, "D")!;
    expect([d.revenueOre, d.profitOre, d.marginBp, d.unpricedRevenueOre]).toEqual([
      0, 0, null, 12_900,
    ]);
    expect(d.unpricedCommissionOre).toBe(1_548);
  });

  it("per titel på sidan Inköpspriser (C: aktuellt pris 35,00 för alla tre orderna)", () => {
    const t = titleEconomics(SC3);
    const c = t.find((x) => x.titleId === "C")!;
    // C = u2, u5, u7: n = 3, netto 17 700, prov 708 + 472 + 472 = 1 652, aktuellt pris 3 500:
    //   kvar = (17 700 − 0 − 1 652 − 3 × 3 500) / 3 = 5 548 / 3 = 1 849,3 → 1 849
    //   hyra per order = (0 + 18 750 + 18 750) / 3 = 12 500
    //   kvar efter hyra = (5 548 − 37 500) / 3 = −10 650,7 → −10 651
    //   marginal = 55 480 000 / 17 700 = 3 134,5 → 3 134 bp (3 134,46)
    expect(c.orders).toBe(3);
    expect(c.unpricedOrders).toBe(2);
    expect(c.averagePriceOre).toBe(5_900);
    expect(c.leftPerOrderOre).toBe(1_849);
    expect(c.rentPerOrderOre).toBe(12_500);
    expect(c.leftPerOrderAfterRentOre).toBe(-10_651);
    expect(c.marginBp).toBe(3_134);
    expect(c.lossWarning).toBe(false);
    expect(c.lossAfterRentWarning).toBe(true);
    expect(c.averageCostOre).toBe(3_500);
    const d = t.find((x) => x.titleId === "D")!;
    expect(d.missingPrice).toBe(true);
    expect(d.leftPerOrderOre).toBeNull();
    expect(d.lossWarning).toBe(false);
  });

  it("identiteterna håller i alla vyer", () => {
    assertIdentities(SC3);
  });

  it("när priset för D läggs in slår det igenom direkt och andelen faller", () => {
    // D 100,00 från 1 nov.: u3 blir prissatt. Prissatt intäkt 22 600 + 12 900 = 35 500,
    // inköp 10 500 + 10 000 = 20 500, prov 2 004 + 1 548 = 3 552, hyra oförändrad 56 250.
    // Vinst 35 500 − 20 500 − 59 802 = −44 802. Utan pris: 11 800 / 47 300 → 2 494,7 → 2 495 bp.
    const r = profitability({ ...SC3, prices: [...SC3.prices, p("D", 10_000, "2026-11-01")] }, "title");
    expect(r.totals.profitOre).toBe(-44_802);
    expect(r.unpriced.shareBp).toBe(2_495);
    expect(r.unpriced.titleIds).toEqual(["C"]);
  });
});

// ---------------------------------------------------------------------------
// 4) Vyerna stämmer mot varandra (samlat över alla scenarier ovan + kombinerat)
// ---------------------------------------------------------------------------

describe(`revision 4: vyerna titel, automat och butik mot varandra (TZ=${process.env.TZ ?? "?"})`, () => {
  it("SC2: summan per titel = per automat = per butik = totalen, fält för fält (handräknat)", () => {
    // Vinst: titel −38 349 − 55 648 − 50 000; automat 2 624 − 61 805 − 34 816 − 50 000;
    //        butik 2 624 − 102 265 − 47 256 + 2 900. Alla = −143 997.
    const v = profitabilityViews(SC2, ["title", "machine", "store"]);
    for (const g of ["title", "machine", "store"] as const) {
      expect(v[g].rows.reduce((a, r) => a + r.profitOre, 0), g).toBe(-143_997);
      expect(v[g].rows.reduce((a, r) => a + r.rentOre, 0), g).toBe(170_893);
      expect(v[g].rows.reduce((a, r) => a + r.revenueOre, 0), g).toBe(58_900);
      expect(v[g].rows.reduce((a, r) => a + r.commissionOre, 0), g).toBe(4_104);
      expect(v[g].rows.reduce((a, r) => a + r.costOre, 0), g).toBe(27_900);
    }
  });

  it("alla scenarier, med och utan moms/kortavgift: identiteterna håller", () => {
    for (const s of [SC1, SC2, SC3]) {
      assertIdentities(s);
      assertIdentities({ ...s, settings: VAT25_FEE250 });
    }
  });

  it("vattenfallet: intäkt − inköp − avgifter − ersättning = vinst (SC1 med moms)", () => {
    const r = profitability({ ...SC1, settings: VAT25_FEE250 }, "store");
    expect(r.waterfall.steps.map((s) => [s.key, s.valueOre])).toEqual([
      ["revenue", 44_000],
      ["cost", -24_900],
      ["fees", -1_380],
      ["compensation", -228_142],
      ["profit", -210_422],
    ]);
    expect(r.waterfall.compensation).toEqual({ commissionOre: 3_142, rentOre: 225_000 });
  });
});

// ---------------------------------------------------------------------------
// 5) Kantfall
// ---------------------------------------------------------------------------

describe(`revision 5: kantfall (TZ=${process.env.TZ ?? "?"})`, () => {
  it("0 order, butik med hyra: hela hyran är ej fördelad och dras från vinsten", () => {
    const input: ProfitabilityInput = {
      orders: [],
      prices: [],
      agreements: [S2_AGREEMENT],
      placements: [pl("M2", "S2", "2026-01-01", null)],
      settings: NO_TAX,
      period: NOV,
    };
    const v = assertIdentities(input);
    expect(v.title.totals.profitOre).toBe(-150_000);
    expect(v.title.totals.marginBp).toBeNull();
    expect(v.title.unpriced.shareBp).toBe(0);
    expect(v.title.rows.map((r) => r.key)).toEqual([UNALLOCATED_KEY]);
    expect(v.machine.rows.map((r) => r.key)).toEqual([UNALLOCATED_KEY]);
    expect(v.store.rows.map((r) => [r.key, r.rentOre])).toEqual([["S2", 150_000]]);
    expect(v.title.waterfall.steps.map((s) => s.valueOre)).toEqual([0, 0, 0, -150_000, -150_000]);
    // 30 dagar + raden "Ej fördelad hyra".
    expect(v.day.rows).toHaveLength(31);
    expect(v.day.rows.at(-1)?.key).toBe(UNALLOCATED_KEY);
  });

  it("0 order och inga avtal: allt noll, inga −0", () => {
    const input: ProfitabilityInput = {
      orders: [],
      prices: [],
      agreements: [],
      placements: [],
      settings: VAT25_FEE250,
      period: NOV,
    };
    const v = assertIdentities(input);
    expect(v.title.rows).toEqual([]);
    expect(v.title.waterfall.steps.map((s) => s.valueOre)).toEqual([0, 0, 0, 0, 0]);
    for (const s of v.title.waterfall.steps) expect(Object.is(s.valueOre, -0)).toBe(false);
    expect(v.title.totals.profitOre).toBe(0);
    expect(v.title.totals.marginBp).toBeNull();
    expect(topContributor(v.machine)).toBeNull();
  });

  it("en order", () => {
    // S1 12 %: 4 900 − 2 000 − 588 = 2 312; marginal 23 120 000 / 4 900 = 4 718,4 → 4 718
    const input: ProfitabilityInput = {
      orders: [o("x", "A", "M1", "2026-11-15", 4900)],
      prices: [p("A", 2000, "2026-01-01")],
      agreements: [S1_AGREEMENT],
      placements: [pl("M1", "S1", "2026-01-01", null)],
      settings: NO_TAX,
      period: NOV,
    };
    const v = assertIdentities(input);
    expect(pick(v.store.totals, { marginBp: 0 } as Expected)).toEqual({
      revenueOre: 4_900,
      costOre: 2_000,
      commissionOre: 588,
      rentOre: 0,
      profitOre: 2_312,
      marginBp: 4_718,
    });
    // Samma order i S3: hela hyran 75 000 hamnar på den: 4 900 − 2 000 − 392 − 75 000 = −72 492
    //   marginal −724 920 000 / 4 900 = −147 942,9 → −147 943
    const r3 = profitability(
      { ...input, agreements: [S3_AGREEMENT], placements: [pl("M1", "S3", "2026-01-01", null)] },
      "title",
    );
    expect(r3.totals.rentOre).toBe(75_000);
    expect(r3.totals.unallocatedRentOre).toBe(0);
    expect(r3.totals.profitOre).toBe(-72_492);
    expect(r3.totals.marginBp).toBe(-147_943);
  });

  it("öresavrundning: hyran tappar inget öre, extraöret går till första ordern i datumordning", () => {
    // Hyra 10,00 kr på tre lika order: 1 000 / 3 = 333,33 → 333 × 3 = 999; 1 öre över.
    // Lika rest → först i datumordning: z (1 nov.), trots att id "a" sorterar före "z".
    const orders = [
      o("a", "B", "M9", "2026-11-02", 4900),
      o("m", "B", "M9", "2026-11-03", 4900),
      o("z", "A", "M9", "2026-11-01", 4900),
    ];
    const base: ProfitabilityInput = {
      orders,
      prices: [p("A", 2000, "2026-01-01"), p("B", 2000, "2026-01-01")],
      agreements: [ag("S9", "2026-01-01", null, null, 1_000)],
      placements: [pl("M9", "S9", "2026-01-01", null)],
      settings: NO_TAX,
      period: NOV,
    };
    const v = assertIdentities(base);
    expect(rowOf(v.title, "A")!.rentOre).toBe(334);
    expect(rowOf(v.title, "B")!.rentOre).toBe(666);
    expect(v.title.totals.rentOre).toBe(1_000);
    // A: 4 900 − 2 000 − 334 = 2 566; B: 9 800 − 4 000 − 666 = 5 134; Σ 7 700
    expect(rowOf(v.title, "A")!.profitOre).toBe(2_566);
    expect(rowOf(v.title, "B")!.profitOre).toBe(5_134);
    expect(v.day.rows.filter((r) => r.orders > 0).map((r) => [r.key, r.rentOre])).toEqual([
      ["2026-11-01", 334],
      ["2026-11-02", 333],
      ["2026-11-03", 333],
    ]);
    // 10,01 kr: 333 r 2 ×3 → 999, 2 öre över → z och a (datumordning) → 334, 334, 333
    const v2 = profitabilityViews(
      { ...base, agreements: [ag("S9", "2026-01-01", null, null, 1_001)] },
      ["day"],
    );
    expect(v2.day.rows.filter((r) => r.orders > 0).map((r) => r.rentOre)).toEqual([334, 334, 333]);
  });

  it("öresavrundning per order: moms och provision avrundas per order, inte på summan", () => {
    // Tre order à 49,99 kr, moms 25 %: 4 999 × 2 500 / 12 500 = 999,8 → 1 000 per order,
    //   Σ 3 000 (på summan hade det blivit 14 997 / 5 = 2 999,4 → 2 999).
    // Netto 3 999 per order, Σ 11 997. Kortavgift 124,975 → 125 per order, Σ 375.
    // Provision 10 % på netto: 399,9 → 400 per order, Σ 1 200.
    // Inköp 3 × 2 000. Vinst 11 997 − 6 000 − 375 − 1 200 = 4 422.
    const input: ProfitabilityInput = {
      orders: [
        o("v1", "A", "M1", "2026-11-01", 4999),
        o("v2", "A", "M1", "2026-11-02", 4999),
        o("v3", "A", "M1", "2026-11-03", 4999),
      ],
      prices: [p("A", 2000, "2026-01-01")],
      agreements: [ag("S1", "2026-01-01", null, 1000, null)],
      placements: [pl("M1", "S1", "2026-01-01", null)],
      settings: VAT25_FEE250,
      period: NOV,
    };
    const t = assertIdentities(input).title.totals;
    expect([t.grossOre, t.vatOre, t.revenueOre, t.feesOre, t.commissionOre, t.profitOre]).toEqual([
      14_997, 3_000, 11_997, 375, 1_200, 4_422,
    ]);
  });

  it("halva öre avrundas uppåt: provision 10 % på 49,05 kr = 490,5 → 491", () => {
    const r = profitability(
      {
        orders: [o("h", "A", "M1", "2026-11-01", 4905)],
        prices: [p("A", 0, "2026-01-01")],
        agreements: [ag("S1", "2026-01-01", null, 1000, null)],
        placements: [pl("M1", "S1", "2026-01-01", null)],
        settings: NO_TAX,
        period: NOV,
      },
      "title",
    );
    expect(r.totals.commissionOre).toBe(491);
    expect(r.totals.profitOre).toBe(4_414);
    // Inköpspris 0 är ett pris (gratis), inte ett saknat pris.
    expect(r.totals.pricedOrders).toBe(1);
  });

  it("order utan kopplad automat: no-machine per automat, no-store per butik", () => {
    const input: ProfitabilityInput = {
      orders: [o("n", "A", null, "2026-11-01", 4900), o("k", "A", "M1", "2026-11-01", 4900)],
      prices: [p("A", 2000, "2026-01-01")],
      agreements: [S1_AGREEMENT],
      placements: [pl("M1", "S1", "2026-01-01", null)],
      settings: NO_TAX,
      period: NOV,
    };
    const v = assertIdentities(input);
    expect(v.machine.rows.map((r) => [r.key, r.profitOre])).toEqual([
      ["M1", 2_312],
      [NO_MACHINE_KEY, 2_900],
    ]);
    expect(v.store.rows.map((r) => [r.key, r.profitOre])).toEqual([
      ["S1", 2_312],
      [NO_STORE_KEY, 2_900],
    ]);
    expect(v.machine.diagnostics.ordersWithoutMachine).toBe(1);
  });

  it("veckan över årsskiftet är 2026-W53, månaderna delas", () => {
    const input: ProfitabilityInput = {
      orders: [o("y1", "A", "M1", "2026-12-31", 4900), o("y2", "A", "M1", "2027-01-01", 4900)],
      prices: [p("A", 2000, "2026-01-01")],
      agreements: [S1_AGREEMENT],
      placements: [pl("M1", "S1", "2026-01-01", null)],
      settings: NO_TAX,
      period: { start: "2026-12-28", end: "2027-01-03" },
    };
    const v = assertIdentities(input);
    expect(v.week.rows.map((r) => [r.key, r.partial, r.profitOre])).toEqual([
      ["2026-W53", false, 4_624],
    ]);
    expect(v.month.rows.map((r) => [r.key, r.range, r.partial])).toEqual([
      ["2026-12", { start: "2026-12-28", end: "2026-12-31" }, true],
      ["2027-01", { start: "2027-01-01", end: "2027-01-03" }, true],
    ]);
  });

  it("rubriken: största bidragsgivaren och dess andel av vinsten", () => {
    // Alla tre automater i S1 (12 %, ingen hyra).
    // M1: 3 × (4 900 − 2 000 − 588) = 6 936; M2: 2 × 2 312 = 4 624; M3: 5 900 − 3 000 − 708 = 2 192
    // Totalt 13 752 på intäkt 30 400 → marginal 4 523,7 → 4 524 bp.
    // M1:s andel 69 360 000 / 13 752 = 5 043,6 → 5 044 bp ("drygt hälften").
    const input: ProfitabilityInput = {
      orders: [
        o("t1", "A", "M1", "2026-11-01", 4900),
        o("t2", "A", "M1", "2026-11-02", 4900),
        o("t3", "A", "M1", "2026-11-03", 4900),
        o("t4", "A", "M2", "2026-11-04", 4900),
        o("t5", "A", "M2", "2026-11-05", 4900),
        o("t6", "B", "M3", "2026-11-06", 5900),
      ],
      prices: [p("A", 2000, "2026-01-01"), p("B", 3000, "2026-01-01")],
      agreements: [S1_AGREEMENT],
      placements: [
        pl("M1", "S1", "2026-01-01", null),
        pl("M2", "S1", "2026-01-01", null),
        pl("M3", "S1", "2026-01-01", null),
      ],
      settings: NO_TAX,
      period: NOV,
    };
    const r = profitability(input, "machine");
    expect(r.totals.profitOre).toBe(13_752);
    expect(r.totals.marginBp).toBe(4_524);
    expect(topContributor(r)).toEqual({ key: "M1", profitOre: 6_936, shareOfProfitBp: 5_044 });
    // Totalvinst ≤ 0 → ingen andel.
    expect(topContributor(profitability(SC2, "machine"))).toEqual({
      key: "M1",
      profitOre: 2_624,
      shareOfProfitBp: null,
    });
  });

  it("förlustvarning per titel", () => {
    // Pris 48,00, säljs 2 × 49,00 i S1 (12 %): (9 800 − 1 176 − 9 600) / 2 = −488 → varning.
    const t = titleEconomics({
      orders: [o("l1", "L", "M1", "2026-11-01", 4900), o("l2", "L", "M1", "2026-11-02", 4900)],
      prices: [p("L", 4800, "2026-01-01")],
      agreements: [S1_AGREEMENT],
      placements: [pl("M1", "S1", "2026-01-01", null)],
      settings: NO_TAX,
      period: NOV,
    });
    expect(t).toHaveLength(1);
    expect(t[0]!.leftPerOrderOre).toBe(-488);
    expect(t[0]!.lossWarning).toBe(true);
    expect(t[0]!.averagePriceOre).toBe(4_900);
  });

  it("ogiltig indata ger DomainError, inte fel siffror", () => {
    const bad = (patch: Partial<ProfitabilityInput>) => () =>
      profitability({ ...SC1, ...patch }, "title");
    expect(bad({ orders: [...SC1_ORDERS, o("b9", "A", "M1", "2026-11-02", 49.5)] })).toThrow(
      DomainError,
    );
    expect(bad({ orders: [...SC1_ORDERS, SC1_ORDERS[0]!] })).toThrow(DomainError);
    expect(bad({ prices: [...SC1_PRICES, p("A", 2100, "2026-11-16")] })).toThrow(DomainError);
    expect(
      bad({ agreements: [S1_AGREEMENT, ag("S1", "2026-06-01", null, 500, null)] }),
    ).toThrow(DomainError);
  });
});
