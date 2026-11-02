/**
 * Oberoende revision av expansion, scenarier, mål och effekt.
 *
 * Alla förväntade värden är uträknade för hand (exakta bråk, halva bort från noll) innan
 * koden kördes. Uträkningen står i kommentaren vid varje fall. Oktober 2026 har 31 dagar,
 * november 30. Inköp 20,00 kr per pack i alla fall.
 */

import { describe, expect, it } from "vitest";
import { addDays, type OrderLine, type ProfitabilityInput } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import {
  compareUnitEconomics,
  estimateSite,
  expansionPipeline,
  siteHistories,
  storeSimilarity,
  type StoreProfile,
} from "@/analytics/expansion";
import { newMachineScenario, priceChangeScenario } from "@/analytics/scenarios";
import { goalProgress } from "@/analytics/goals";
import { binderlabEffect } from "@/analytics/effect";

const OCT = { start: "2026-10-01", end: "2026-10-31" } as const;
const INVESTMENT = { purchaseOre: 2_000_000, installationOre: 100_000 } as const; // 21 000 kr

/** Mellanslag av alla slag (NBSP, smalt NBSP) → vanligt mellanslag, för textjämförelser. */
const plain = (s: string) => s.replace(/[\s  ]+/g, " ");

function daily(
  machineId: string,
  from: string,
  days: number,
  perDay = 1,
  amountOre = 4900,
  titleId = "t-a",
): OrderLine[] {
  const out: OrderLine[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    for (let k = 0; k < perDay; k++) {
      const id = `rev:${machineId}:${titleId}:${date}:${k}`;
      out.push({ id, externalId: id, titleId, machineId, businessDate: date, amountOre });
    }
  }
  return out;
}

const store = (
  id: string,
  name: string,
  storeType: string | null,
  city: string | null,
  openHoursPerWeek: number | null,
  areaSqm: number | null,
): StoreProfile => ({ id, name, storeType, city, openHoursPerWeek, areaSqm });

// ---------------------------------------------------------------------------
// Fall 1: likhet, urval (alla fem skäl) och viktad uppskattning
// ---------------------------------------------------------------------------
//
// Målplats: livs, Malmö, 98 h, 400 m².
// Likhet för hand (vikter 40/25/20/15 %):
//  A  livs  Malmö 98 h 400 m²            → 10 000
//  E  livs  Malmö 98 400 (bara pris saknas) → 10 000
//  F  livs  Malmö 98 400 (automat, ingen försäljning) → 10 000
//  G  livs  Malmö 98 h 450 m²: yta 10 000 − round(50·10 000/450)=8 889 → 4 000+2 500+2 000+1 333,35 = 9 833
//  B  "Livs " "malmö" 84 h 350 m²: tim 10 000 − round(1 428,57)=8 571, yta 8 750
//     → 4 000+2 500+1 714,2+1 312,5 = 9 526,7 → 9 527
//  D  livs Lund 98 400 → 7 500, men bara 12 automatdagar
//  C  kiosk Malmö 112 h 60 m²: 2 500 + 2 000·8 750/10 000 + 1 500·1 500/10 000 = 4 475
//
// Urval (minst 60 %, minst 28 dagar, högst 10 % utan pris, högst 3): rangordning
// A, E, F (10 000, id-ordning), G, B, D, C. E utesluts (100 % utan pris), D (12 dagar),
// C (45 % lik). Valda A, F, G; B blir "beyond-max".
//
// Takt per automat och dag (provision 10 % i A, ingen provision i G):
//  A: 2 pack/dag → vinst 2·(4 900 − 2 000 − 490) = 4 820, intäkt 9 800
//  F: 0 och 0
//  G: 1 pack/dag → vinst 2 900, intäkt 4 900
// Förväntad vinst/dag = (10 000·4 820 + 10 000·0 + 9 833·2 900)/29 833 = 76 715 700/29 833
// Per månad (×365/12): förväntad 78 217, lägsta 0, högsta 146 608.
// Intäkt per månad: förväntad 149 042, lägsta 0, högsta 298 083.
// Månad = dagar i kalendermånaden (domänens regel för aktiva månader, se docs/berakningar.md), inte 365/12.
// Talen uppdaterade 2 nov. så att enhetsekonomi, scenario och uppskattning ger samma svar (jfr fall 6).
// Återbetalning 2 100 000·10 / per månad: bästa 141 (A), förväntad 263, sämsta null (F = 0).
// Avkastning per år: förväntad round(76 715 700/29 833·365·10 000/2 100 000) = 4 470 bp,
// lägsta 0, högsta 8 378.
function case1(): { sources: ProfitabilityInput; stores: StoreProfile[] } {
  return {
    stores: [
      store("s-a", "A", "livs", "Malmö", 98, 400),
      store("s-b", "B", "Livs ", "malmö", 84, 350),
      store("s-c", "C", "kiosk", "Malmö", 112, 60),
      store("s-d", "D", "livs", "Lund", 98, 400),
      store("s-e", "E", "livs", "Malmö", 98, 400),
      store("s-f", "F", "livs", "Malmö", 98, 400),
      store("s-g", "G", "livs", "Malmö", 98, 450),
    ],
    sources: {
      orders: [
        ...daily("m-a", OCT.start, 31, 2),
        ...daily("m-b", OCT.start, 31),
        ...daily("m-c", OCT.start, 31),
        ...daily("m-d", "2026-10-20", 12),
        ...daily("m-e", OCT.start, 31, 1, 4900, "t-x"), // titel utan inköpspris
        ...daily("m-g", OCT.start, 31),
      ],
      prices: [price("t-a", 2000, "2026-01-01")],
      agreements: [
        agreement("s-a", "2026-01-01", null, { commissionBp: 1000 }),
        agreement("s-b", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 31_000 }),
      ],
      placements: [
        placement("m-a", "s-a", "2026-09-01", null),
        placement("m-b", "s-b", "2026-09-01", null),
        placement("m-c", "s-c", "2026-09-01", null),
        placement("m-d", "s-d", "2026-10-20", null),
        placement("m-e", "s-e", "2026-09-01", null),
        placement("m-f", "s-f", "2026-09-01", null),
        placement("m-g", "s-g", "2026-09-01", null),
      ],
      settings: NO_TAX,
      period: OCT,
    },
  };
}

describe("Revision fall 1: likhet, urval och uppskattning", () => {
  it("likheten följer vikterna 40/25/20/15 och normaliserar text", () => {
    const { stores } = case1();
    const target = { storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400 };
    const scores = Object.fromEntries(
      stores.map((s) => [s.id, storeSimilarity(target, s).scoreBp]),
    );
    expect(scores).toEqual({
      "s-a": 10_000,
      "s-b": 9_527,
      "s-c": 4_475,
      "s-d": 7_500,
      "s-e": 10_000,
      "s-f": 10_000,
      "s-g": 9_833,
    });
  });

  it("urvalet, skälen och de viktade talen stämmer med handräkningen", () => {
    const { sources, stores } = case1();
    const est = estimateSite({
      target: { storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400 },
      targetName: "Ny plats",
      stores,
      histories: siteHistories(sources),
      period: OCT,
      investment: INVESTMENT,
    });
    expect(est.kind).toBe("estimate");
    expect(est.status).toBe("ok");
    expect(est.basis.map((b) => b.storeId)).toEqual(["s-a", "s-f", "s-g"]);
    expect(Object.fromEntries(est.excluded.map((e) => [e.storeId, e.reason]))).toEqual({
      "s-e": "unpriced",
      "s-b": "beyond-max",
      "s-d": "short-history",
      "s-c": "low-similarity",
    });
    expect(est.investmentOre).toBe(2_100_000);
    expect(est.profitPerMonthOre).toEqual({ low: 0, expected: 79_717, high: 149_420 });
    expect(est.revenuePerMonthOre).toEqual({ low: 0, expected: 151_900, high: 303_800 });
    expect(est.paybackTenths).toEqual({ low: 141, expected: 263, high: null });
    expect(est.annualReturnBp).toEqual({ low: 0, expected: 4_555, high: 8_538 });
    expect(est.confidence).toBe("high");
    // Platsens egen återbetalning: G 2 900/dag → 88 208/mån → 238 tiondelar.
    expect(est.basis.find((b) => b.storeId === "s-g")!.paybackTenths).toBe(234);
    expect(est.basis.find((b) => b.storeId === "s-f")!.paybackTenths).toBeNull();

    // Märkt som uppskattning, med intervall och platser.
    const t = plain(est.text);
    expect(t.startsWith("Uppskattning för Ny plats:")).toBe(true);
    expect(t).toContain("797 kr (0 kr till 1 494 kr) vinst per månad");
    expect(t).toContain("26,3 månader");
    expect(t).toContain("A (100 % lik), F (100 %) och G (98 %)");

    // Underlaget pekar ut platser och automater.
    expect(est.evidence.storeIds).toEqual(["s-a", "s-f", "s-g"]);
    expect(est.evidence.machineIds).toEqual(["m-a", "m-f", "m-g"]);
    expect(est.evidence.period).toEqual(OCT);
  });

  it("newMachineScenario ('liknar butik A') ger samma uppskattning som direkt anrop", () => {
    const { sources, stores } = case1();
    const res = newMachineScenario({ sources, stores, likeStoreId: "s-a", investment: INVESTMENT });
    expect(res.profitPerMonthOre).toEqual({ low: 0, expected: 79_717, high: 149_420 });
    expect(res.paybackTenths).toEqual({ low: 141, expected: 263, high: null });
    expect(plain(res.text).startsWith("Uppskattning för en butik som liknar A:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fall 2: expansionspipeline med villkor, egen butik undantagen och avvisad lead
// ---------------------------------------------------------------------------
//
// Befintliga: P (livs, Malmö, 98 h, 400 m²) 2 pack/dag, provision 10 %;
//             Q (livs, malmö, 84 h, 350 m²) 1 pack/dag, provision 10 %, hyra 310 kr/mån.
// L1 livs Malmö 98/400 med villkor 15 % provision, ingen hyra:
//   P: bidrag 9 800 − 4 000 = 5 800 − 15 %·9 800 = 4 330/dag (likhet 10 000)
//   Q: 4 900 − 2 000 = 2 900 − 735 = 2 165/dag (likhet 9 527)
//   förväntad = (10 000·4 330 + 9 527·2 165)/19 527 → 3 274/dag, 99 576/mån
//   återbetalning bästa 159, förväntad 211, sämsta 319.
// L3 livs Malmö 84/350, gäller Q (storeId s-q) → Q undantas, bara P (likhet 9 527):
//   4 820/dag → 146 608/mån → 143 tiondelar, säkerhet låg.
// L2 kiosk Stockholm 40/30 → likhet 929 resp. 1 081 → inget underlag, sist.
// L4 avvisad → inte med.
// Rang: L3 (143) före L1 (211) före L2 (inget underlag).
describe("Revision fall 2: expansionspipeline", () => {
  const stores = [
    store("s-p", "P", "livs", "Malmö", 98, 400),
    store("s-q", "Q", "livs", "malmö", 84, 350),
  ];
  const sources: ProfitabilityInput = {
    orders: [...daily("m-p", OCT.start, 31, 2), ...daily("m-q", OCT.start, 31)],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-p", "2026-01-01", null, { commissionBp: 1000 }),
      agreement("s-q", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 31_000 }),
    ],
    placements: [
      placement("m-p", "s-p", "2026-09-01", null),
      placement("m-q", "s-q", "2026-09-01", null),
    ],
    settings: NO_TAX,
    period: OCT,
  };

  it("rangordnar efter återbetalningstid och räknar villkor och undantag rätt", () => {
    const res = expansionPipeline({
      leads: [
        {
          id: "l-1",
          name: "L1",
          storeType: "livs",
          city: "Malmö",
          openHoursPerWeek: 98,
          areaSqm: 400,
          terms: { commissionBp: 1500, monthlyRentOre: 0 },
        },
        {
          id: "l-2",
          name: "L2",
          storeType: "kiosk",
          city: "Stockholm",
          openHoursPerWeek: 40,
          areaSqm: 30,
        },
        {
          id: "l-3",
          name: "L3",
          storeType: "livs",
          city: "Malmö",
          openHoursPerWeek: 84,
          areaSqm: 350,
          storeId: "s-q",
        },
        {
          id: "l-4",
          name: "L4",
          storeType: "livs",
          city: "Malmö",
          openHoursPerWeek: 98,
          areaSqm: 400,
          stage: "rejected",
        },
      ],
      stores,
      sources,
      period: OCT,
      defaultInvestment: INVESTMENT,
    });
    expect(res.map((r) => [r.leadId, r.rank])).toEqual([
      ["l-3", 1],
      ["l-1", 2],
      ["l-2", 3],
    ]);
    const l3 = res[0]!.estimate;
    expect(l3.basis.map((b) => [b.storeId, b.similarity.scoreBp])).toEqual([["s-p", 9_527]]);
    expect(l3.excluded.map((e) => [e.storeId, e.reason])).toEqual([["s-q", "excluded"]]);
    expect(l3.paybackTenths).toEqual({ low: 141, expected: 141, high: 141 });
    expect(l3.confidence).toBe("low");

    const l1 = res[1]!.estimate;
    expect(l1.usesTerms).toBe(true);
    expect(l1.profitPerDayOre).toEqual({ low: 2_165, expected: 3_274, high: 4_330 });
    expect(l1.profitPerMonthOre!.expected).toBe(101_485);
    expect(l1.paybackTenths).toEqual({ low: 156, expected: 207, high: 313 });

    const l2 = res[2]!.estimate;
    expect(l2.status).toBe("insufficient-data");
    expect(l2.paybackTenths).toBeNull();
    expect(l2.text.startsWith("Uppskattning saknas")).toBe(true);
    expect(l2.excluded.map((e) => [e.storeId, e.scoreBp])).toEqual([
      ["s-q", 1_081],
      ["s-p", 929],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fall 3: prisändring med moms 25 % (provision på belopp exkl. moms)
// ---------------------------------------------------------------------------
//
// 10 order à 49 kr i oktober, provision 10 %, moms 25 %, inköp 20 kr, ingen hyra.
// Före: moms round(4 900·2 500/12 500) = 980, netto 3 920, provision 392 → bidrag 1 528/order,
//       totalt 15 280.
// +10 kr: belopp 5 900, moms 1 180, netto 4 720, provision 472 → 2 248/order, 22 480.
// Volymfaktor = 1 + e·1 000·10/(100·49 000) = 1 + e/490.
//   e = 0:    22 480, +7 200 (4 712 bp)
//   e = −0,5: 44/49 → 20 186, +4 906, volym −1 020 bp, 9 pack
//   e = −1:   39/49 → 17 892, +2 612, volym −2 041 bp, 8 pack, intäkt 37 567
//   e = −1,5: 34/49 → 15 598, +318
//   e = −2:   29/49 → 13 304, −1 976
// Brytpunkt: 15 280/22 480 − 1 → −3 203 bp, elasticitet −157 (hundradelar).
describe("Revision fall 3: prisändring", () => {
  const input = {
    orders: daily("m-1", "2026-10-01", 10),
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    placements: [placement("m-1", "s-1", "2026-09-01", null)],
    settings: { vatRateBp: 2500, cardFeeBp: 0 },
    period: OCT,
    titleId: "t-a",
    titleName: "30th Celebration",
    deltaOre: 1000,
  };

  it("räknar om varje order med moms och provision och ger tabellen för elasticiteter", () => {
    const res = priceChangeScenario({ ...input, elasticityHundredths: -100 });
    expect(res.base.contributionOre).toBe(15_280);
    expect(res.base.profitOre).toBe(15_280);
    expect(res.table.map((r) => [r.elasticityHundredths, r.profitChangeOre])).toEqual([
      [0, 7_200],
      [-50, 4_906],
      [-100, 2_612],
      [-150, 318],
      [-200, -1_976],
    ]);
    expect(res.selected).toMatchObject({
      elasticityHundredths: -100,
      volumeChangeBp: -2_041,
      units: 8,
      revenueOre: 37_567,
      contributionOre: 17_892,
      profitChangeOre: 2_612,
      profitChangeBp: 1_709,
    });
    expect(res.breakEvenVolumeChangeBp).toBe(-3_203);
    expect(res.breakEvenElasticityHundredths).toBe(-157);
    expect(plain(res.text)).toContain(
      "Höjer du priset på 30th Celebration med 10 kr ökar vinsten med 26 kr",
    );
    expect(res.evidence.orderIds).toHaveLength(10);
    expect(res.evidence.titleIds).toEqual(["t-a"]);
  });

  it("standardelasticiteten är 0 (oförändrad volym)", () => {
    const res = priceChangeScenario(input);
    expect(res.selected.elasticityHundredths).toBe(0);
    expect(res.selected.units).toBe(10);
    expect(res.selected.profitChangeOre).toBe(7_200);
  });
});

// ---------------------------------------------------------------------------
// Fall 4: mål (run-rate, trailing, avslutad månad, automater)
// ---------------------------------------------------------------------------
//
// m-1 i s-1 från 1 sep., 1 pack/dag à 49 kr, provision 10 %, hyra 310 kr/mån.
// asOf 10 okt.: intäkt 10·4 900 = 49 000. Prognos 49 000 + 49 000·21/10 = 151 900.
//   Mål 150 000 → i fas. Behov: ceil(101 000/21) = 4 810 (visas inte när i fas).
// Vinst 10·2 410 − round(31 000·10/31) = 24 100 − 10 000 = 14 100. Prognos 14 100 + 29 610
//   = 43 710. Mål 50 000 → efter med 6 290, behov ceil(35 900/21) = 1 710.
// Automater: m-2 placeras 20 okt. Utfall 10 okt. 1, prognos 31 okt. 2, mål 2 → i fas.
// asOf 3 nov. (order 1 okt.–3 nov.): november har gått 3 dagar < 7 → trailing 7 okt.–3 nov.
//   = 28·4 900 = 137 200. Prognos 14 700 + 137 200·27/28 = 147 000. Mål 147 000 → i fas (lika).
//   Oktober är slut: 31·4 900 = 151 900 mot 152 000 → missat med 1 kr.
describe("Revision fall 4: mål", () => {
  const base = {
    orders: daily("m-1", "2026-10-01", 34),
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 31_000 }),
    ],
    placements: [
      placement("m-1", "s-1", "2026-09-01", null),
      placement("m-2", "s-1", "2026-10-20", null),
    ],
    settings: NO_TAX,
  };

  it("mitt i månaden: run-rate, i fas/efter och behov per dag", () => {
    const res = goalProgress({
      ...base,
      orders: base.orders.filter((o) => o.businessDate <= "2026-10-10"),
      asOf: "2026-10-10",
      goals: [
        { id: "g-r", month: "2026-10", metric: "revenue", target: 150_000, scope: "organization" },
        { id: "g-p", month: "2026-10", metric: "profit", target: 50_000, scope: "organization" },
        {
          id: "g-m",
          month: "2026-10",
          metric: "active_machines",
          target: 2,
          scope: "organization",
        },
      ],
    });
    const by = Object.fromEntries(res.map((g) => [g.goalId, g]));
    expect(by["g-r"]).toMatchObject({
      actual: 49_000,
      forecast: 151_900,
      forecastMethod: "run-rate",
      status: "on-track",
      requiredPerDay: 4_810,
      elapsedDays: 10,
      remainingDays: 21,
    });
    expect(by["g-p"]).toMatchObject({
      actual: 14_100,
      forecast: 43_710,
      status: "behind",
      gap: -6_290,
      requiredPerDay: 1_710,
    });
    expect(plain(by["g-p"]!.text)).toContain("efter med 63 kr");
    expect(plain(by["g-p"]!.detail)).toContain("Behöver 17 kr per dag");
    expect(by["g-m"]).toMatchObject({
      actual: 1,
      forecast: 2,
      forecastMethod: "placements",
      status: "on-track",
    });
    expect(by["g-m"]!.evidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(by["g-r"]!.evidence.period).toEqual({ start: "2026-10-01", end: "2026-10-10" });
  });

  it("tidigt i månaden: snittet för de senaste 28 dagarna; avslutad månad: utfallet", () => {
    const res = goalProgress({
      ...base,
      asOf: "2026-11-03",
      goals: [
        {
          id: "g-nov",
          month: "2026-11",
          metric: "revenue",
          target: 147_000,
          scope: "organization",
        },
        {
          id: "g-oct",
          month: "2026-10",
          metric: "revenue",
          target: 152_000,
          scope: "store",
          storeId: "s-1",
        },
      ],
    });
    const by = Object.fromEntries(res.map((g) => [g.goalId, g]));
    expect(by["g-nov"]).toMatchObject({
      actual: 14_700,
      forecast: 147_000,
      forecastMethod: "trailing",
      status: "on-track",
    });
    expect(by["g-oct"]).toMatchObject({
      actual: 151_900,
      forecast: 151_900,
      forecastMethod: "final",
      status: "missed",
      requiredPerDay: null,
    });
    expect(plain(by["g-oct"]!.text)).toContain("målet missat med 1 kr");
  });
});

// ---------------------------------------------------------------------------
// Fall 5: effekt mot utgångsläget
// ---------------------------------------------------------------------------
//
// Okt.: m-1 hela månaden och m-2 från 17 okt. (15 dagar), 1 pack/dag, provision 10 %.
//   Vinst 46·2 410 = 110 860, automatdagar 46 → per automatmånad round(110 860·31/46) = 74 710.
//   Utgångsläge 50 000 → +24 710, 4 942 bp, kronor round(24 710·46/31) = 36 666.
// Nov. till och med 10 nov.: 2 automater · 10 dagar → 48 200, 20 automatdagar
//   → round(48 200·30/20) = 72 300, kronor round(22 300·20/30) = 14 867, "hittills".
// Slutsålda dagar: utgångsläge 10/mån, okt. 4 → 6 färre, 6 000 bp, kronor 6·round(110 860/46)
//   = 6·2 410 = 14 460 (uppskattat). Påfyllning: 600 min → 420 min, 300 kr/h → 180·30 000/60 = 90 000.
describe("Revision fall 5: effekt av Binderlab", () => {
  const sources = {
    orders: [...daily("m-1", "2026-10-01", 41), ...daily("m-2", "2026-10-17", 25)],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    placements: [
      placement("m-1", "s-1", "2026-09-01", null),
      placement("m-2", "s-1", "2026-10-17", null),
    ],
    settings: NO_TAX,
  };

  const run = (observations: Parameters<typeof binderlabEffect>[0]["observations"]) =>
    binderlabEffect({
      ...sources,
      months: ["2026-10", "2026-11"],
      asOf: "2026-11-10",
      baselines: [
        {
          id: "b-p",
          metric: "profit_per_machine_month",
          value: 50_000,
          unit: "ore",
          scope: "organization",
        },
        {
          id: "b-s",
          metric: "stockout_days_month",
          value: 10,
          unit: "days",
          scope: "organization",
        },
        {
          id: "b-r",
          metric: "refill_hours_month",
          value: 600,
          unit: "minutes",
          scope: "organization",
        },
      ],
      observations,
      options: { hourlyCostOre: 30_000 },
    });

  it("vinst per automat, slutsålda dagar och påfyllningstid mot utgångsläget", () => {
    const [p, s, r] = run([
      {
        metric: "stockout_days_month",
        month: "2026-10",
        value: 4,
        scope: "organization",
        dates: ["2026-10-05"],
      },
      { metric: "refill_hours_month", month: "2026-10", value: 420, scope: "organization" },
    ]);
    expect(
      p!.points.map((x) => [x.month, x.value, x.improvementBp, x.improvementOre, x.partial]),
    ).toEqual([
      ["2026-10", 74_710, 4_942, 36_666, false],
      ["2026-11", 72_300, 4_460, 14_867, true],
    ]);
    expect(p!.points[0]!.machineDays).toBe(46);
    expect(p!.points[0]!.evidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(plain(p!.text)).toContain("(hittills)");

    expect(s!.points[0]).toMatchObject({
      value: 4,
      improvement: 6,
      improvementBp: 6_000,
      improvementOre: 14_460,
    });
    expect(s!.points[0]!.evidence.dates).toEqual(["2026-10-05"]);
    expect(r!.points[0]).toMatchObject({
      value: 420,
      improvement: 180,
      improvementBp: 3_000,
      improvementOre: 90_000,
    });
  });

  it("pågående månad: mätvärdet hittills jämförs mot utgångsläget för samma antal dagar", () => {
    // 1 slutsåld dag 1–10 nov. Utgångsläget 10 per hel månad motsvarar 10·10/30 = 3,33 dagar
    // på 10 dagar. Rättvis förbättring (3,33 − 1)/3,33 = 7 000 bp, inte 9 000 bp
    // (som om 1 dag vore hela novembers utfall).
    const [, s] = run([
      { metric: "stockout_days_month", month: "2026-11", value: 1, scope: "organization" },
    ]);
    const nov = s!.points.find((x) => x.month === "2026-11")!;
    expect(nov.partial).toBe(true);
    expect(nov.improvementBp).toBe(7_000);
  });
});

// ---------------------------------------------------------------------------
// Fall 6: enhetsekonomi sida vid sida
// ---------------------------------------------------------------------------
//
// m-1 hela oktober, 1 pack/dag, provision 10 % → 74 710 = 1 aktiv månad, investering
// 21 000 kr → återbetalning round(21 000 000/74 710) = 281 tiondelar, avkastning
// round(74 710·12·10 000/2 100 000) = 4 269 bp, vinst/dag 2 410.
// m-2 från 17 okt. (15 dagar), 2 pack/dag → 72 300, 4 820/dag, per månad round(72 300·31/15)
// = 149 420, ingen investering.
// Snitt (72 300 + 74 710)/46 = 3 195,87 → 3 196. m-2 +5 081 bp, m-1 −2 459 bp. Rang m-2, m-1.
describe("Revision fall 6: enhetsekonomi-jämförelse", () => {
  const input = {
    orders: [...daily("m-1", "2026-10-01", 31), ...daily("m-2", "2026-10-17", 15, 2)],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000 }),
      agreement("s-2", "2026-01-01", null, { commissionBp: 1000 }),
    ],
    placements: [
      placement("m-1", "s-1", "2026-09-01", null),
      placement("m-2", "s-2", "2026-10-17", null),
    ],
    settings: NO_TAX,
    period: OCT,
    investments: [
      {
        machineId: "m-1",
        kind: "purchase" as const,
        amountOre: 2_000_000,
        date: "2026-09-01",
        depreciationMonths: 36,
      },
      {
        machineId: "m-1",
        kind: "installation" as const,
        amountOre: 100_000,
        date: "2026-09-01",
        depreciationMonths: null,
      },
    ],
  };

  it("vinst och intäkt per dag, återbetalning, avkastning och rang", () => {
    const res = compareUnitEconomics(input, [
      { id: "m-1", name: "Automat 1" },
      { id: "m-2", name: "Automat 2" },
    ]);
    expect(
      res.rows.map((r) => [r.machineId, r.rank, r.profitPerDayOre, r.revenuePerDayOre]),
    ).toEqual([
      ["m-2", 1, 4_820, 9_800],
      ["m-1", 2, 2_410, 4_900],
    ]);
    const m1 = res.rows[1]!;
    expect(m1.paybackTenths).toBe(281);
    expect(m1.annualReturnBp).toBe(4_269);
    expect(m1.vsAverageBp).toBe(-2_459);
    expect(res.rows[0]!.vsAverageBp).toBe(5_081);
    expect(res.rows[0]!.profitPerMonthOre).toBe(149_420);
    expect(res.rows[0]!.paybackTenths).toBeNull();
    expect(res.averageProfitPerDayOre).toBe(3_196);
    expect(plain(m1.text)).toBe("Automat 1: 24 kr vinst per dag, återbetald på 28,1 månader");
    expect(m1.evidence.machineIds).toEqual(["m-1"]);
  });

  it("samma automat och period ger samma återbetalningstid i jämförelsen och i scenariot", () => {
    // Planen: panel, rapporter och assistent ska visa samma svar. Butik s-1 har bara m-1 hela
    // oktober. Jämförelsen räknar en kalendermånad (31 dagar = 1 månad): 281 tiondelar.
    // Scenariot räknar 365/12 dagar per månad: 2 410·365/12 = 73 304 → 286 tiondelar.
    const cmp = compareUnitEconomics(input);
    const est = estimateSite({
      target: { storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400 },
      targetName: "s-1",
      stores: [store("s-1", "S1", "livs", "Malmö", 98, 400)],
      histories: siteHistories(input),
      period: OCT,
      investment: INVESTMENT,
    });
    const fromCompare = cmp.rows.find((r) => r.machineId === "m-1")!.paybackTenths;
    expect(est.basis[0]!.paybackTenths).toBe(fromCompare);
  });
});
