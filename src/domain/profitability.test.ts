import { describe, expect, it } from "vitest";
import { orderEconomics } from "./economics";
import { DomainError } from "./errors";
import {
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  profitability,
  profitabilityViews,
  UNALLOCATED_KEY,
  type ProfitabilityRow,
} from "./profitability";
import { agreement, NO_TAX, order, placement, price } from "./testing/fixtures";
import type { ProfitabilityInput } from "./types";

const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };

/**
 * Prisändring mitt i perioden.
 *
 * Titel A kostar 20,00 kr från 1 sep. och 25,00 kr från 16 okt.
 * Automat 1 står i butik 1 hela oktober. Avtal: provision 10 %, hyra 62,00 kr/mån.
 * Ingen moms, ingen kortavgift. Sex order i oktober:
 *
 *   order  datum   belopp   inköp
 *   o1     5 okt   49,00    20,00   (före ändringen)
 *   o2    10 okt   49,00    20,00
 *   o3    15 okt   49,00    20,00   (sista dagen med gamla priset)
 *   o4    16 okt   49,00    25,00   (ändringsdagen: nya priset)
 *   o5    20 okt   49,00    25,00
 *   o6    31 okt   59,00    25,00
 *
 * Handräkning (öre):
 *   Intäkt            5 × 4 900 + 5 900                  = 30 400
 *   Inköp             3 × 2 000 + 3 × 2 500              = 13 500
 *   Avgifter          0                                  =      0
 *   Provision 10 %    5 × 490 + 590                      =  3 040
 *   Hyra              hel månad                          =  6 200
 *   Butiksersättning  3 040 + 6 200                      =  9 240
 *   Vinst             30 400 − 13 500 − 0 − 9 240        =  7 660
 *   Marginal          7 660 / 30 400 = 25,197 %          →  2 520 bp
 *
 * Hyran fördelas efter nettointäkt (största-restmetoden):
 *   6 200 × 4 900 / 30 400 = 999,34 (×5), 6 200 × 5 900 / 30 400 = 1 203,29
 *   heltal: 5 × 999 + 1 203 = 6 198, 2 öre kvar → o1 och o2 (störst rest, först)
 *   → o1 1 000, o2 1 000, o3 999, o4 999, o5 999, o6 1 203
 */
function priceChangeScenario(settings = NO_TAX): ProfitabilityInput {
  return {
    orders: [
      order({ id: "o1", businessDate: "2026-10-05", amountOre: 4900 }),
      order({ id: "o2", businessDate: "2026-10-10", amountOre: 4900 }),
      order({ id: "o3", businessDate: "2026-10-15", amountOre: 4900 }),
      order({ id: "o4", businessDate: "2026-10-16", amountOre: 4900 }),
      order({ id: "o5", businessDate: "2026-10-20", amountOre: 4900 }),
      order({ id: "o6", businessDate: "2026-10-31", amountOre: 5900 }),
    ],
    prices: [price("t-a", 2000, "2026-09-01"), price("t-a", 2500, "2026-10-16")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
    ],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings,
    period: OCTOBER,
  };
}

describe("prisändring mitt i perioden", () => {
  it("order före och efter ändringsdatumet får rätt pris", () => {
    const input = priceChangeScenario();
    const costs = input.orders.map((o) => [o.id, orderEconomics(o, input).costOre]);
    expect(costs).toEqual([
      ["o1", 2000],
      ["o2", 2000],
      ["o3", 2000],
      ["o4", 2500],
      ["o5", 2500],
      ["o6", 2500],
    ]);
  });

  it("vinsten stämmer med handräkningen", () => {
    const r = profitability(priceChangeScenario(), "title");
    const handräkning = {
      revenueOre: 5 * 4900 + 5900,
      costOre: 3 * 2000 + 3 * 2500,
      feesOre: 0,
      commissionOre: 5 * 490 + 590,
      rentOre: 6200,
    };
    const compensation = handräkning.commissionOre + handräkning.rentOre;
    const vinst = handräkning.revenueOre - handräkning.costOre - handräkning.feesOre - compensation;
    expect([handräkning.revenueOre, handräkning.costOre, compensation, vinst]).toEqual([
      30_400, 13_500, 9_240, 7_660,
    ]);
    expect(r.totals).toMatchObject({
      ...handräkning,
      compensationOre: 9_240,
      profitOre: 7_660,
      marginBp: 2_520,
      orders: 6,
      pricedOrders: 6,
      unpricedOrders: 0,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ key: "t-a", profitOre: 7_660 });
  });

  it("per vecka: veckan med ändringen har ett gammalt och ett nytt pris", () => {
    const r = profitability(priceChangeScenario(), "week");
    const w42 = r.rows.find((x) => x.key === "2026-W42")!;
    // o3 (15 okt, 20,00) + o4 (16 okt, 25,00); hyra 999 + 999
    // vinst = 9 800 − 4 500 − 980 − 1 998 = 2 322
    expect(w42).toMatchObject({
      orders: 2,
      revenueOre: 9_800,
      costOre: 4_500,
      commissionOre: 980,
      rentOre: 1_998,
      profitOre: 2_322,
    });
    expect(r.rows.map((x) => x.key)).toEqual([
      "2026-W40",
      "2026-W41",
      "2026-W42",
      "2026-W43",
      "2026-W44",
    ]);
    expect(r.rows[0]).toMatchObject({
      partial: true,
      range: { start: "2026-10-01", end: "2026-10-04" },
      orders: 0,
    });
  });

  it("samma scenario med moms 25 % och kortavgift 2,5 %", () => {
    // Per order à 49,00: moms 980, netto 3 920, avgift round(122,5) = 123, provision 392
    // Order à 59,00:     moms 1 180, netto 4 720, avgift round(147,5) = 148, provision 472
    //   Intäkt      5 × 3 920 + 4 720  = 24 320
    //   Inköp                          = 13 500
    //   Avgifter    5 × 123 + 148      =    763
    //   Provision   5 × 392 + 472      =  2 432
    //   Hyra                           =  6 200
    //   Vinst  24 320 − 13 500 − 763 − 8 632 = 1 425
    //   Marginal 1 425 / 24 320 = 5,859 % → 586 bp
    const r = profitability(priceChangeScenario({ vatRateBp: 2500, cardFeeBp: 250 }), "machine");
    expect(r.totals).toMatchObject({
      grossOre: 30_400,
      vatOre: 6_080,
      revenueOre: 24_320,
      costOre: 13_500,
      feesOre: 763,
      commissionOre: 2_432,
      rentOre: 6_200,
      compensationOre: 8_632,
      profitOre: 1_425,
      marginBp: 586,
    });
  });

  it("ett pris som läggs in i efterhand slår igenom direkt på gamla perioder", () => {
    const input = priceChangeScenario();
    const before = profitability(input, "title").totals.profitOre;
    // Nytt pris från 1 okt. ersätter 20,00 för o1–o3: +3 × 300 i inköp
    const after = profitability(
      { ...input, prices: [...input.prices, price("t-a", 2300, "2026-10-01")] },
      "title",
    ).totals.profitOre;
    expect(before - after).toBe(900);
    // Ett pris som börjar efter perioden påverkar inte perioden.
    const later = profitability(
      { ...input, prices: [...input.prices, price("t-a", 9999, "2026-11-01")] },
      "title",
    ).totals.profitOre;
    expect(later).toBe(before);
  });
});

describe("saknade inköpspriser", () => {
  // t-a har pris, t-b och t-c saknar. Butik 1: provision 10 %, hyra 100,00 kr. November.
  const input: ProfitabilityInput = {
    orders: [
      ...[3, 4, 5, 6].map((d) =>
        order({ titleId: "t-a", businessDate: `2026-11-0${d}`, amountOre: 4900 }),
      ),
      ...[7, 8, 9].map((d) =>
        order({ titleId: "t-b", businessDate: `2026-11-0${d}`, amountOre: 5900 }),
      ),
      order({ titleId: "t-c", businessDate: "2026-11-20", amountOre: 12_900 }),
    ],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 10_000 }),
    ],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("order utan pris räknas inte in i vinsten men redovisas separat; hyran dras ändå", () => {
    const r = profitability(input, "title");
    // Hyran 10 000 fördelas på alla 8 order efter netto (50 200):
    //   t-a: 4 × 976 (rest 0,09) = 3 904, resten 6 096 på t-b och t-c
    // Hyran på t-b och t-c (6 096) är ej fördelad hyra och dras ändå från vinsten.
    // Vinst (bara t-a:s intäkt) = 19 600 − 8 000 − 1 960 − (3 904 + 6 096) = −360
    expect(r.totals).toMatchObject({
      orders: 8,
      pricedOrders: 4,
      unpricedOrders: 4,
      revenueOre: 19_600,
      costOre: 8_000,
      commissionOre: 1_960,
      rentOre: 10_000,
      unallocatedRentOre: 6_096,
      profitOre: -360,
      unpricedRevenueOre: 30_600,
      unpricedCommissionOre: 3_060,
      unpricedRentOre: 6_096,
      unpricedCompensationOre: 9_156,
    });
    // Titelraderna: t-a bär sin egen hyra, t-b och t-c visar vinst 0, hyran på 'unallocated'.
    const rows = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(rows["t-a"]).toMatchObject({ rentOre: 3_904, profitOre: 5_736 });
    expect(rows["t-b"]!.profitOre).toBe(0);
    expect(rows["t-c"]!.profitOre).toBe(0);
    expect(rows[UNALLOCATED_KEY]).toMatchObject({ rentOre: 6_096, profitOre: -6_096 });
  });

  it("en saknad inköpspris gör aldrig vinsten bättre", () => {
    // Utan order bär ingen order hyran: vinst −10 000. Med en order utan pris: fortfarande
    // −10 000 (provisionen och intäkten på ordern ingår inte, hyran gör det).
    const empty = profitability({ ...input, orders: [] }, "store").totals.profitOre;
    const oneUnpriced = profitability(
      {
        ...input,
        orders: [order({ titleId: "t-b", businessDate: "2026-11-07", amountOre: 5900 })],
      },
      "store",
    ).totals.profitOre;
    expect(empty).toBe(-10_000);
    expect(oneUnpriced).toBe(-10_000);
  });

  it("andelen oprissatt intäkt och vilka titlar det gäller", () => {
    const r = profitability(input, "title");
    // 30 600 / 50 200 = 60,96 %
    expect(r.unpriced).toEqual({
      orders: 4,
      revenueOre: 30_600,
      shareBp: 6_096,
      titleIds: ["t-b", "t-c"],
      byTitle: [
        {
          titleId: "t-b",
          orders: 3,
          revenueOre: 17_700,
          firstDate: "2026-11-07",
          lastDate: "2026-11-09",
        },
        {
          titleId: "t-c",
          orders: 1,
          revenueOre: 12_900,
          firstDate: "2026-11-20",
          lastDate: "2026-11-20",
        },
      ],
    });
    const tb = r.rows.find((x) => x.key === "t-b")!;
    expect(tb).toMatchObject({
      revenueOre: 0,
      costOre: 0,
      profitOre: 0,
      marginBp: null,
      unpricedOrders: 3,
      unpricedRevenueOre: 17_700,
    });
    expect(r.waterfall.excluded).toMatchObject({ orders: 4, revenueOre: 30_600, shareBp: 6_096 });
  });
});

describe("automat som flyttar butik mitt i perioden", () => {
  // m-1 i butik 1 till 15 okt., i butik 2 från 16 okt.
  // Butik 1: provision 10 %. Butik 2 (avtal från 16 okt.): provision 20 % och hyra 31,00 kr/mån.
  const input: ProfitabilityInput = {
    orders: [
      order({ businessDate: "2026-10-05" }),
      order({ businessDate: "2026-10-15" }),
      order({ businessDate: "2026-10-16" }),
      order({ businessDate: "2026-10-30" }),
    ],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000 }),
      agreement("s-2", "2026-10-16", null, { commissionBp: 2000, monthlyRentOre: 3100 }),
    ],
    placements: [
      placement("m-1", "s-1", "2026-01-01", "2026-10-15"),
      placement("m-1", "s-2", "2026-10-16", null),
    ],
    settings: NO_TAX,
    period: OCTOBER,
  };

  it("varje order följer butiken och avtalet den dagen", () => {
    const r = profitability(input, "store");
    // Butik 1: 9 800 − 4 000 − 980 = 4 820
    // Butik 2: hyra 3 100 × 16 / 31 = 1 600; 9 800 − 4 000 − 1 960 − 1 600 = 2 240
    expect(r.rows.map((x) => [x.key, x.orders, x.commissionOre, x.rentOre, x.profitOre])).toEqual([
      ["s-1", 2, 980, 0, 4_820],
      ["s-2", 2, 1_960, 1_600, 2_240],
    ]);
    const m = profitability(input, "machine");
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ key: "m-1", profitOre: 7_060 });
  });
});

describe("provision, hyra eller båda", () => {
  const input: ProfitabilityInput = {
    orders: [
      order({ machineId: "m-1", businessDate: "2026-11-10", amountOre: 10_000 }),
      order({ machineId: "m-2", businessDate: "2026-11-10", amountOre: 10_000 }),
      order({ machineId: "m-3", businessDate: "2026-11-10", amountOre: 10_000 }),
    ],
    prices: [price("t-a", 4000, "2026-01-01")],
    agreements: [
      agreement("bara-provision", "2026-01-01", null, { commissionBp: 1500 }),
      agreement("bara-hyra", "2026-01-01", null, { monthlyRentOre: 3000 }),
      agreement("bada", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 2000 }),
    ],
    placements: [
      placement("m-1", "bara-provision", "2026-01-01", null),
      placement("m-2", "bara-hyra", "2026-01-01", null),
      placement("m-3", "bada", "2026-01-01", null),
    ],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("räknar rätt per butik", () => {
    const r = profitability(input, "store");
    const row = (k: string) => r.rows.find((x) => x.key === k)!;
    expect(row("bara-provision")).toMatchObject({
      commissionOre: 1500,
      rentOre: 0,
      profitOre: 4500,
    });
    expect(row("bara-hyra")).toMatchObject({ commissionOre: 0, rentOre: 3000, profitOre: 3000 });
    expect(row("bada")).toMatchObject({
      commissionOre: 1000,
      rentOre: 2000,
      compensationOre: 3000,
      profitOre: 3000,
    });
    expect(r.totals.profitOre).toBe(10_500);
  });
});

describe("hyran bärs bara av order på dagar med hyresavtal", () => {
  // Butik 1: 1–14 nov. bara provision 10 %; från 15 nov. hyra 300,00 kr/mån (16 dagar).
  // Hyra nov. = round(30 000 × 16 / 30) = 16 000.
  const agreements = [
    agreement("s-1", "2026-01-01", "2026-11-14", { commissionBp: 1000 }),
    agreement("s-1", "2026-11-15", null, { monthlyRentOre: 30_000 }),
  ];
  const base: ProfitabilityInput = {
    orders: [],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements,
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("en order före avtalsbytet bär ingen hyra", () => {
    const r = profitability(
      {
        ...base,
        orders: [
          order({ id: "f1", titleId: "t-a", businessDate: "2026-11-10", amountOre: 4900 }),
          order({ id: "f2", titleId: "t-b", businessDate: "2026-11-20", amountOre: 4900 }),
        ],
        prices: [...base.prices, price("t-b", 2000, "2026-01-01")],
      },
      "title",
    );
    const row = (k: string) => r.rows.find((x) => x.key === k)!;
    // f1 (10 nov., inget hyresavtal) bär 0; f2 (20 nov.) bär hela 16 000.
    expect(row("t-a")).toMatchObject({ rentOre: 0, commissionOre: 490, profitOre: 2410 });
    expect(row("t-b")).toMatchObject({ rentOre: 16_000, commissionOre: 0, profitOre: -13_100 });
    expect(r.totals.rentOre).toBe(16_000);
  });

  it("bara order på dagar utan hyra: hyran är ej fördelad", () => {
    const r = profitability(
      { ...base, orders: [order({ businessDate: "2026-11-10", amountOre: 4900 })] },
      "machine",
    );
    expect(r.rows.find((x) => x.key === "m-1")).toMatchObject({ rentOre: 0, profitOre: 2410 });
    expect(r.rows.find((x) => x.key === UNALLOCATED_KEY)).toMatchObject({
      rentOre: 16_000,
      unallocatedRentOre: 16_000,
    });
    expect(r.totals.profitOre).toBe(2410 - 16_000);
  });

  it("två hyresnivåer i samma månad vägs efter dagens hyra", () => {
    // 1–15 nov. 30 000/mån, 16–30 nov. 60 000/mån: hyra = (30 000 × 15 + 60 000 × 15) / 30 = 45 000.
    // Två lika stora order, en i varje halva: vikter 1 : 2 → 15 000 och 30 000.
    const r = profitability(
      {
        ...base,
        agreements: [
          agreement("s-1", "2026-01-01", "2026-11-15", { monthlyRentOre: 30_000 }),
          agreement("s-1", "2026-11-16", null, { monthlyRentOre: 60_000 }),
        ],
        orders: [
          order({ id: "h1", businessDate: "2026-11-05", amountOre: 4900 }),
          order({ id: "h2", businessDate: "2026-11-25", amountOre: 4900 }),
        ],
      },
      "day",
    );
    const rent = (d: string) => r.rows.find((x) => x.key === d)!.rentOre;
    expect(rent("2026-11-05")).toBe(15_000);
    expect(rent("2026-11-25")).toBe(30_000);
  });
});

describe("särskilda rader och diagnostik", () => {
  const input: ProfitabilityInput = {
    orders: [
      order({ machineId: null, businessDate: "2026-11-10" }), // okopplad automat
      order({ machineId: "m-ghost", businessDate: "2026-11-10" }), // ej placerad
      order({ machineId: "m-2", businessDate: "2026-11-10" }), // butik utan avtal
      order({ machineId: "m-1", businessDate: "2026-11-10" }),
      order({ machineId: "m-1", businessDate: "2026-10-31" }), // utanför perioden
    ],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    placements: [
      placement("m-1", "s-1", "2026-01-01", null),
      placement("m-2", "s-9", "2026-01-01", null),
    ],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("order utan automat och utan butik får egna rader", () => {
    const m = profitability(input, "machine");
    expect(m.rows.map((r) => [r.key, r.kind])).toEqual([
      ["m-1", "item"],
      ["m-2", "item"],
      ["m-ghost", "item"],
      [NO_MACHINE_KEY, "no-machine"],
    ]);
    const s = profitability(input, "store");
    expect(s.rows.map((r) => [r.key, r.orders])).toEqual([
      ["s-1", 1],
      ["s-9", 1],
      [NO_STORE_KEY, 2],
    ]);
    expect(s.diagnostics).toEqual({
      ordersOutsidePeriod: 1,
      ordersWithoutMachine: 1,
      ordersWithoutStore: 1,
      ordersWithoutAgreement: 1,
      machinesWithoutPlacement: ["m-ghost"],
      storesWithoutAgreement: ["s-9"],
    });
  });

  it("dubblerade order-id kastar", () => {
    const o = order({ businessDate: "2026-11-10" });
    expect(() => profitability({ ...input, orders: [o, o] }, "title")).toThrow(
      expect.objectContaining({ code: "duplicate_order" }),
    );
  });

  it("ogiltig period kastar", () => {
    expect(() =>
      profitability({ ...input, period: { start: "2026-11-30", end: "2026-11-01" } }, "title"),
    ).toThrow(DomainError);
  });
});

describe("tidsvyer", () => {
  const input: ProfitabilityInput = {
    orders: [order({ businessDate: "2026-10-29" }), order({ businessDate: "2026-11-09" })],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: NO_TAX,
    period: { start: "2026-10-28", end: "2026-11-10" },
  };

  it("veckor med delveckor i kanterna", () => {
    const r = profitability(input, "week");
    expect(r.rows.map((x) => [x.key, x.range, x.partial, x.orders])).toEqual([
      ["2026-W44", { start: "2026-10-28", end: "2026-11-01" }, true, 1],
      ["2026-W45", { start: "2026-11-02", end: "2026-11-08" }, false, 0],
      ["2026-W46", { start: "2026-11-09", end: "2026-11-10" }, true, 1],
    ]);
  });

  it("månader och dagar fylls ut", () => {
    const m = profitability(input, "month");
    expect(m.rows.map((x) => [x.key, x.range, x.partial])).toEqual([
      ["2026-10", { start: "2026-10-28", end: "2026-10-31" }, true],
      ["2026-11", { start: "2026-11-01", end: "2026-11-10" }, true],
    ]);
    const d = profitability(input, "day");
    expect(d.rows).toHaveLength(14);
    expect(profitability(input, "day", { fillTimeGaps: false }).rows).toHaveLength(2);
  });
});

describe("vattenfall och flera vyer", () => {
  it("stegen summerar till vinsten", () => {
    const r = profitability(priceChangeScenario({ vatRateBp: 2500, cardFeeBp: 250 }), "title");
    const steps = r.waterfall.steps;
    expect(steps.map((s) => s.key)).toEqual(["revenue", "cost", "fees", "compensation", "profit"]);
    expect(steps.map((s) => s.label)).toEqual([
      "Intäkt",
      "Inköp",
      "Avgifter",
      "Butiksersättning",
      "Vinst",
    ]);
    const sum = steps.filter((s) => !s.total).reduce((a, s) => a + s.valueOre, 0);
    expect(sum).toBe(steps[4]!.valueOre);
    expect(r.waterfall.compensation).toEqual({ commissionOre: 2_432, rentOre: 6_200 });
  });

  it("profitabilityViews ger samma som separata anrop", () => {
    const input = priceChangeScenario();
    const views = profitabilityViews(input, ["title", "machine", "store"]);
    for (const g of ["title", "machine", "store"] as const) {
      expect(views[g]).toEqual(profitability(input, g));
    }
  });

  it("resultatet är vanliga, serialiserbara objekt", () => {
    const r = profitability(priceChangeScenario(), "store");
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const row: ProfitabilityRow = r.rows[0]!;
    expect(row.kind).toBe("item");
  });

  it("ej fördelad hyra syns som egen rad per titel och automat", () => {
    const input: ProfitabilityInput = {
      ...priceChangeScenario(),
      agreements: [
        agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
        agreement("s-tom", "2026-10-01", null, { monthlyRentOre: 31_000 }),
      ],
    };
    for (const g of ["title", "machine"] as const) {
      const r = profitability(input, g);
      expect(r.rows.at(-1)).toMatchObject({
        key: UNALLOCATED_KEY,
        kind: "unallocated",
        rentOre: 31_000,
      });
      expect(r.totals.profitOre).toBe(7_660 - 31_000);
    }
  });

  it("per dag och vecka ligger hyran utan order på avtalets dagar: staplarna summerar till totalen", () => {
    const input: ProfitabilityInput = {
      ...priceChangeScenario(),
      agreements: [
        agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
        // 310 kr/mån från 22 okt.: 10 dagar i oktober = 100 kr, 10 kr per dag.
        agreement("s-tom", "2026-10-22", null, { monthlyRentOre: 31_000 }),
      ],
    };
    for (const g of ["day", "week"] as const) {
      const r = profitability(input, g);
      expect(r.rows.some((x) => x.kind === "unallocated")).toBe(false);
      expect(r.rows.every((x) => x.kind === "time")).toBe(true);
      const sum = (k: "profitOre" | "rentOre" | "compensationOre") =>
        r.rows.reduce((n, x) => n + x[k], 0);
      expect(r.totals.profitOre).toBe(7_660 - 10_000);
      expect(sum("profitOre")).toBe(r.totals.profitOre);
      expect(sum("rentOre")).toBe(r.totals.rentOre);
      expect(sum("compensationOre")).toBe(r.totals.compensationOre);
    }
    const days = profitability(input, "day");
    const day = (d: string) => days.rows.find((x) => x.key === d)!;
    // Före avtalet ingen hyra från s-tom; från 22 okt. 10 kr per dag.
    expect(day("2026-10-21").unallocatedRentOre).toBe(0);
    expect(day("2026-10-22").unallocatedRentOre).toBe(1_000);
    expect(day("2026-10-25")).toMatchObject({ orders: 0, profitOre: -1_000, revenueOre: 0 });
    expect(day("2026-10-31").unallocatedRentOre).toBe(1_000);
    // Utan butikernas andel (vyknappen av) dras ingen hyra någonstans.
    const off = profitability(
      { ...input, settings: { ...input.settings, deductStoreShare: false } },
      "day",
    );
    expect(off.rows.find((x) => x.key === "2026-10-25")!.profitOre).toBe(0);
    expect(off.rows.reduce((n, x) => n + x.profitOre, 0)).toBe(off.totals.profitOre);
  });

  it("hyran på en order utan pris ligger på orderns dag", () => {
    const input: ProfitabilityInput = {
      ...priceChangeScenario(),
      prices: [price("t-a", 2500, "2026-10-16")],
    };
    const r = profitability(input, "day");
    expect(r.rows.some((x) => x.kind === "unallocated")).toBe(false);
    expect(r.rows.reduce((n, x) => n + x.profitOre, 0)).toBe(r.totals.profitOre);
    const unpricedDays = ["2026-10-05", "2026-10-10", "2026-10-15"];
    for (const d of unpricedDays) {
      const row = r.rows.find((x) => x.key === d)!;
      expect(row.unallocatedRentOre).toBeGreaterThan(0);
    }
  });
});
