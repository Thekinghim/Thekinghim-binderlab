import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import { agreement, placement, price } from "@/domain/testing/fixtures";
import { Ratio } from "./common";
import {
  annualReturnBp,
  estimateConfidence,
  estimateSite,
  listText,
  paybackTenths,
  paybackText,
  totalInvestment,
} from "./estimate";
import { expansionPipeline, type ExpansionLead } from "./pipeline";
import { siteHistories } from "./site-history";
import {
  dailyOrders,
  INVESTMENT,
  OCTOBER,
  octoberSources,
  STORES,
} from "./test-fixtures";

const histories = siteHistories(octoberSources());
const target = STORES[0]!;

function estimate(overrides: Partial<Parameters<typeof estimateSite>[0]> = {}) {
  return estimateSite({
    target,
    targetName: "en butik som liknar Ica Nära Söder",
    stores: STORES,
    histories,
    period: OCTOBER,
    investment: INVESTMENT,
    ...overrides,
  });
}

describe("siteHistories", () => {
  const h = (id: string) => histories.find((x) => x.storeId === id)!;

  it("lönsamhet per butik och automatdagar från placeringarna", () => {
    expect(histories.map((x) => x.storeId)).toEqual(["s-1", "s-2", "s-3", "s-4"]);
    expect(h("s-1")).toMatchObject({
      machineIds: ["m-1"],
      machineDays: 31,
      firstDay: "2026-10-01",
      lastDay: "2026-10-31",
      orders: 62,
      revenueOre: 62 * 4900,
      costOre: 62 * 2000,
      commissionOre: 62 * 490,
      contributionOre: 62 * 2900,
      profitOre: 62 * 2410,
      unpricedShareBp: 0,
    });
  });

  it("placering som börjar mitt i perioden räknar bara dagarna i perioden", () => {
    expect(h("s-4")).toMatchObject({ machineDays: 12, firstDay: "2026-10-20", orders: 12 });
  });

  it("en butik med automat men utan försäljning finns med (och drar ned snittet)", () => {
    const src = octoberSources();
    const res = siteHistories({
      ...src,
      placements: [...src.placements, placement("m-9", "s-9", "2026-10-25", "2026-11-30")],
      agreements: [...src.agreements, agreement("s-9", "2026-10-25", null, { monthlyRentOre: 31_000 })],
    });
    const s9 = res.find((x) => x.storeId === "s-9")!;
    // 25–31 okt. = 7 dagar; hyra 310 kr × 7/31 = 70 kr, ej fördelad men en kostnad.
    expect(s9).toMatchObject({ machineDays: 7, orders: 0, revenueOre: 0, rentOre: 7_000, profitOre: -7_000 });
    expect(s9.unpricedShareBp).toBeNull();
  });

  it("placeringar helt utanför perioden räknas inte", () => {
    const src = octoberSources();
    const res = siteHistories({
      ...src,
      placements: [...src.placements, placement("m-8", "s-8", "2026-11-01", null)],
    });
    expect(res.find((x) => x.storeId === "s-8")).toBeUndefined();
  });

  it("order utan inköpspris ger andel utan pris", () => {
    const src = octoberSources();
    const res = siteHistories({
      ...src,
      orders: [...src.orders, ...dailyOrders("m-3", "2026-10-01", 31, 1, 4900, "t-utan")],
    });
    expect(res.find((x) => x.storeId === "s-3")!.unpricedShareBp).toBe(5_000);
  });
});

describe("hjälpfunktioner", () => {
  it("totalInvestment summerar och kontrollerar", () => {
    expect(totalInvestment({ purchaseOre: 100, installationOre: 20, otherOre: 3 })).toBe(123);
    expect(() => totalInvestment({ purchaseOre: -1, installationOre: 0 })).toThrow(DomainError);
    expect(() => totalInvestment({ purchaseOre: 1.5, installationOre: 0 })).toThrow(DomainError);
  });

  it("paybackTenths: investering / vinst per månad, en decimal", () => {
    expect(paybackTenths(2_100_000, new Ratio(100_000))).toBe(210);
    // 2 100 000 / 87 966,67 = 23,87 → 23,9
    expect(paybackTenths(2_100_000, new Ratio(263_900, 3))).toBe(239);
    expect(paybackTenths(0, new Ratio(-5))).toBe(0);
    expect(paybackTenths(1000, new Ratio(0))).toBeNull();
    expect(paybackTenths(1000, new Ratio(-1))).toBeNull();
  });

  it("annualReturnBp: vinst per år / investering", () => {
    // 100 kr per dag × 365 / 36 500 kr = 100 %
    expect(annualReturnBp(3_650_000, new Ratio(10_000))).toBe(10_000);
    expect(annualReturnBp(0, new Ratio(10_000))).toBeNull();
  });

  it("estimateConfidence", () => {
    expect(estimateConfidence([])).toBeNull();
    expect(estimateConfidence([10_000])).toBe("low");
    expect(estimateConfidence([9_000, 7_000])).toBe("medium");
    expect(estimateConfidence([9_000, 6_999])).toBe("low");
    expect(estimateConfidence([9_000, 8_500, 8_000])).toBe("high");
    expect(estimateConfidence([9_000, 8_500, 7_999])).toBe("medium");
  });

  it("listText och paybackText", () => {
    expect(listText(["A"])).toBe("A");
    expect(listText(["A", "B", "C"])).toBe("A, B och C");
    expect(paybackText({ low: 72, expected: 72, high: 72 })).toBe("återbetald på 7,2 månader");
    expect(paybackText({ low: 50, expected: 72, high: 143 })).toBe(
      "återbetald på 7,2 månader (5,0–14,3)",
    );
    expect(paybackText({ low: 50, expected: 72, high: null })).toBe(
      "återbetald på 7,2 månader (5,0 i bästa fallet, inte alls i sämsta fallet)",
    );
    expect(paybackText({ low: 50, expected: null, high: null })).toBe(
      "återbetalas inte med den vinsten",
    );
  });
});

describe("estimateSite", () => {
  it("väljer de mest lika platserna med tillräcklig historik", () => {
    const e = estimate();
    expect(e.kind).toBe("estimate");
    expect(e.status).toBe("ok");
    expect(e.basis.map((b) => [b.storeId, b.similarity.scoreBp])).toEqual([
      ["s-1", 10_000],
      ["s-3", 9_527],
    ]);
    expect(e.excluded.map((x) => [x.storeId, x.reason])).toEqual([
      ["s-4", "short-history"],
      ["s-2", "low-similarity"],
    ]);
    expect(e.excluded[0]!.text).toBe("Ica Lund: bara 12 automatdagar (minst 28)");
    expect(e.excluded[1]!.text).toBe("Pressbyrån C: 45 % lik (minst 60 %)");
  });

  it("viktat snitt, intervall, återbetalning och avkastning", () => {
    const e = estimate();
    // Vinst per dag: 48,20 (s-1) och 24,10 (s-3); viktat (10 000 × 4 820 + 9 527 × 2 410) / 19 527.
    expect(e.profitPerDayOre).toEqual({ low: 2_410, expected: 3_644, high: 4_820 });
    // × 365 / 12
    expect(e.profitPerMonthOre).toEqual({ low: 73_304, expected: 110_844, high: 146_608 });
    expect(e.revenuePerMonthOre).toEqual({ low: 149_042, expected: 225_368, high: 298_083 });
    expect(e.investmentOre).toBe(2_100_000);
    expect(e.paybackTenths).toEqual({ low: 143, expected: 189, high: 286 });
    expect(e.annualReturnBp).toEqual({ low: 4_189, expected: 6_334, high: 8_378 });
    expect(e.confidence).toBe("medium");
    expect(e.basis[0]).toMatchObject({
      machineDays: 31,
      profitPerDayOre: 4_820,
      profitPerMonthOre: 146_608,
      paybackTenths: 143,
    });
  });

  it("texten är märkt som uppskattning och nämner platserna", () => {
    const e = estimate();
    expect(e.text).toBe(
      "Uppskattning för en butik som liknar Ica Nära Söder: 1 108 kr (733 kr till 1 466 kr) vinst per månad, återbetald på 18,9 månader (14,3–28,6). Bygger på Ica Nära Söder (100 % lik) och Coop Väster (95 %).",
    );
    expect(e.detail).toContain("62 automatdagar");
    expect(e.detail).toContain("butiksersättning enligt platsernas egna avtal");
    expect(e.detail).toContain("Säkerhet: medel");
  });

  it("underlaget länkar till platserna och automaterna", () => {
    const e = estimate();
    expect(e.evidence.storeIds).toEqual(["s-1", "s-3"]);
    expect(e.evidence.machineIds).toEqual(["m-1", "m-3"]);
    expect(e.evidence.period).toEqual(OCTOBER);
    const keys = e.evidence.figures.map((f) => f.key);
    expect(keys).toContain("site:s-3:profitPerMonthOre");
    expect(e.evidence.figures.find((f) => f.key === "paybackTenths")!.value).toBe(189);
  });

  it("villkor för den nya platsen ersätter platsernas provision och hyra", () => {
    const e = estimate({ terms: { commissionBp: 1_500, monthlyRentOre: 30_000 } });
    expect(e.usesTerms).toBe(true);
    // s-1: (58,00 − 15 % × 98,00) × 365/12 − 300 = 1 017,04 kr
    expect(e.profitPerMonthOre).toEqual({ low: 35_852, expected: 69_576, high: 101_704 });
    expect(e.detail).toContain("provision 15 %, hyra 300 kr per månad");
  });

  it("maxSites begränsar urvalet; resten markeras", () => {
    const e = estimate({ options: { maxSites: 1 } });
    expect(e.basis.map((b) => b.storeId)).toEqual(["s-1"]);
    expect(e.excluded.find((x) => x.storeId === "s-3")!.reason).toBe("beyond-max");
    // En plats: intervallet är en punkt.
    expect(e.profitPerMonthOre).toEqual({ low: 146_608, expected: 146_608, high: 146_608 });
    expect(e.text).toContain("1 466 kr vinst per månad, återbetald på 14,3 månader.");
    expect(e.confidence).toBe("low");
  });

  it("undantagna butiker och lägre krav på historik", () => {
    const e = estimate({ options: { excludeStoreIds: ["s-1"], minMachineDays: 10 } });
    expect(e.basis.map((b) => b.storeId)).toEqual(["s-3", "s-4"]);
    expect(e.excluded.find((x) => x.storeId === "s-1")!.reason).toBe("excluded");
  });

  it("platser med stor andel order utan inköpspris tas inte med", () => {
    const src = octoberSources();
    const h = siteHistories({
      ...src,
      orders: [...src.orders, ...dailyOrders("m-3", "2026-10-01", 31, 1, 4900, "t-utan")],
    });
    const e = estimate({ histories: h });
    expect(e.basis.map((b) => b.storeId)).toEqual(["s-1"]);
    expect(e.excluded.find((x) => x.storeId === "s-3")).toMatchObject({
      reason: "unpriced",
      text: "Coop Väster: 50 % av intäkten saknar inköpspris (högst 10 %)",
    });
  });

  it("ingen tillräckligt lik plats: ingen siffra, bara förklaring", () => {
    const e = estimate({ target: STORES[4]! });
    expect(e.status).toBe("insufficient-data");
    expect(e.profitPerMonthOre).toBeNull();
    expect(e.paybackTenths).toBeNull();
    expect(e.confidence).toBeNull();
    expect(e.text).toMatch(/^Uppskattning saknas för en butik som liknar Ica Nära Söder: ingen befintlig butik uppfyller kraven/);
    expect(e.detail).toMatch(/^Mest lik: /);
  });

  it("utan historik alls", () => {
    const e = estimate({ histories: [] });
    expect(e.status).toBe("insufficient-data");
    expect(e.text).toContain("det finns inga befintliga butiker med historik");
  });

  it("förlust på sämsta platsen: återbetalas inte i sämsta fallet", () => {
    const e = estimate({ terms: { commissionBp: 0, monthlyRentOre: 100_000 } });
    // s-3: 29,00 × 365/12 − 1 000 kr < 0
    expect(e.profitPerMonthOre!.low).toBeLessThan(0);
    expect(e.paybackTenths!.high).toBeNull();
    expect(e.text).toContain("inte alls i sämsta fallet");
  });

  it("utan investering är återbetalningstiden 0 och avkastningen saknas", () => {
    const e = estimate({ investment: { purchaseOre: 0, installationOre: 0 } });
    expect(e.paybackTenths).toEqual({ low: 0, expected: 0, high: 0 });
    expect(e.annualReturnBp).toBeNull();
  });

  it("kastar för ogiltiga villkor och inställningar", () => {
    expect(() => estimate({ terms: { commissionBp: 20_000, monthlyRentOre: null } })).toThrow(
      DomainError,
    );
    expect(() => estimate({ options: { minScoreBp: -1 } })).toThrow(DomainError);
  });

  it("deterministiskt: samma resultat oavsett ordning på butiker och historik", () => {
    const a = estimate();
    const b = estimate({ stores: [...STORES].reverse(), histories: [...histories].reverse() });
    expect(b).toEqual(a);
  });
});

describe("expansionPipeline", () => {
  const leads: ExpansionLead[] = [
    { id: "l-3", name: "Kiosken", storeType: "kiosk", city: "Göteborg", openHoursPerWeek: 168, areaSqm: 20 },
    { id: "l-1", name: "Willys Hyllie", storeType: "livs", city: "Malmö", openHoursPerWeek: 84, areaSqm: 350 },
    { id: "l-2", name: "Ica Kvarnby", storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400, stage: "contacted" },
    { id: "l-4", name: "Nej tack", storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400, stage: "rejected" },
    { id: "l-5", name: "Ica Nära Söder, automat 2", storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400, storeId: "s-1" },
  ];

  it("rangordnar efter återbetalningstid, leads utan underlag sist", () => {
    const res = expansionPipeline({
      leads,
      stores: STORES,
      sources: octoberSources(),
      period: OCTOBER,
      defaultInvestment: INVESTMENT,
    });
    expect(res.map((r) => [r.leadId, r.rank, r.estimate.status])).toEqual([
      ["l-2", 1, "ok"],
      ["l-1", 2, "ok"],
      ["l-5", 3, "ok"],
      ["l-3", 4, "insufficient-data"],
    ]);
    // l-2 liknar s-1 mest (100 %) och får samma uppskattning som scenariot.
    expect(res[0]!.estimate.paybackTenths!.expected).toBe(189);
    expect(res[0]!.stage).toBe("contacted");
  });

  it("en lead i en befintlig butik bygger inte på den butiken", () => {
    const res = expansionPipeline({
      leads,
      stores: STORES,
      histories,
      period: OCTOBER,
      defaultInvestment: INVESTMENT,
    });
    const l5 = res.find((r) => r.leadId === "l-5")!;
    expect(l5.estimate.basis.map((b) => b.storeId)).toEqual(["s-3"]);
    expect(l5.estimate.excluded.find((x) => x.storeId === "s-1")!.reason).toBe("excluded");
  });

  it("leadens egen investering och villkor används", () => {
    const res = expansionPipeline({
      leads: [{ ...leads[2]!, investment: { purchaseOre: 1_000_000, installationOre: 0 }, terms: { commissionBp: 0, monthlyRentOre: 0 } }],
      stores: STORES,
      histories,
      period: OCTOBER,
      defaultInvestment: INVESTMENT,
    });
    expect(res[0]!.estimate.investmentOre).toBe(1_000_000);
    expect(res[0]!.estimate.usesTerms).toBe(true);
  });

  it("avböjda leads tas med på begäran", () => {
    const res = expansionPipeline({
      leads,
      stores: STORES,
      histories,
      period: OCTOBER,
      defaultInvestment: INVESTMENT,
      includeRejected: true,
    });
    expect(res.map((r) => r.leadId)).toContain("l-4");
    // Lika återbetalning och vinst som l-2 → id avgör.
    expect(res.map((r) => r.leadId).slice(0, 2)).toEqual(["l-2", "l-4"]);
  });

  it("kräver historik eller källor", () => {
    expect(() =>
      expansionPipeline({ leads, stores: STORES, period: OCTOBER, defaultInvestment: INVESTMENT }),
    ).toThrow(DomainError);
  });

  it("tom lista ger tomt resultat", () => {
    expect(
      expansionPipeline({ leads: [], stores: STORES, histories, period: OCTOBER, defaultInvestment: INVESTMENT }),
    ).toEqual([]);
  });
});

describe("prislista i underlaget påverkar inte urvalet", () => {
  it("ett senare inköpspris efter perioden ändrar inget", () => {
    const src = octoberSources();
    const h2 = siteHistories({ ...src, prices: [...src.prices, price("t-a", 9_999, "2026-11-01")] });
    expect(h2).toEqual(histories);
  });
});
