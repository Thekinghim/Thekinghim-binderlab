import { describe, expect, it } from "vitest";
import { DomainError, type OrderLine, type ProfitabilityInput } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import { estimateSite } from "../expansion/estimate";
import { siteHistories } from "../expansion/site-history";
import { INVESTMENT, OCTOBER, octoberSources, STORES } from "../expansion/test-fixtures";
import { newMachineScenario } from "./new-machine";
import { DEFAULT_ELASTICITIES, priceChangeScenario } from "./price-change";

describe("newMachineScenario", () => {
  it("målplatsen får butik X:s attribut och samma regler som pipelinen", () => {
    const res = newMachineScenario({
      sources: octoberSources(),
      stores: STORES,
      likeStoreId: "s-1",
      investment: INVESTMENT,
    });
    const direct = estimateSite({
      target: STORES[0]!,
      targetName: "en butik som liknar Ica Nära Söder",
      stores: STORES,
      histories: siteHistories(octoberSources()),
      period: OCTOBER,
      investment: INVESTMENT,
    });
    expect(res).toEqual(direct);
    expect(res.kind).toBe("estimate");
    expect(res.text.startsWith("Uppskattning för en butik som liknar Ica Nära Söder:")).toBe(true);
    expect(res.basis.map((b) => b.storeId)).toEqual(["s-1", "s-3"]);
  });

  it("overrides ändrar målplatsens attribut", () => {
    const res = newMachineScenario({
      sources: octoberSources(),
      stores: STORES,
      likeStoreId: "s-1",
      overrides: { city: "Lund" },
      investment: INVESTMENT,
      options: { minMachineDays: 10 },
    });
    expect(res.target.city).toBe("Lund");
    // Ica Lund blir lika med målplatsen (100 %).
    expect(res.basis[0]!.storeId).toBe("s-4");
    expect(res.basis[0]!.similarity.scoreBp).toBe(10_000);
  });

  it("okänd butik kastar", () => {
    expect(() =>
      newMachineScenario({
        sources: octoberSources(),
        stores: STORES,
        likeStoreId: "s-x",
        investment: INVESTMENT,
      }),
    ).toThrow(DomainError);
  });
});

/** 10 order av t-a à 49 kr i oktober i butik s-1 (provision 10 %), inköp 20 kr. */
function priceInput(extra: Partial<ProfitabilityInput> = {}): ProfitabilityInput {
  const orders: OrderLine[] = Array.from({ length: 10 }, (_, i) => ({
    id: `p-${String(i).padStart(2, "0")}`,
    externalId: String(1000 + i),
    titleId: "t-a",
    machineId: "m-1",
    businessDate: `2026-10-${String(i + 1).padStart(2, "0")}`,
    amountOre: 4900,
  }));
  return {
    orders,
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: NO_TAX,
    period: OCTOBER,
    ...extra,
  };
}

describe("priceChangeScenario", () => {
  it("oförändrad volym: vinsten ändras med prisändringen minus provisionen", () => {
    const res = priceChangeScenario({
      ...priceInput(),
      titleId: "t-a",
      titleName: "30th Celebration",
      deltaOre: 1000,
    });
    expect(res.status).toBe("ok");
    expect(res.base).toMatchObject({
      units: 10,
      revenueOre: 49_000,
      costOre: 20_000,
      commissionOre: 4_900,
      contributionOre: 24_100,
      rentOre: 0,
      profitOre: 24_100,
    });
    // (10 kr − 10 % provision) × 10 pack = 90 kr
    expect(res.selected).toMatchObject({
      elasticityHundredths: 0,
      volumeChangeBp: 0,
      units: 10,
      revenueOre: 59_000,
      contributionOre: 33_100,
      profitChangeOre: 9_000,
    });
    expect(res.averagePriceOre).toBe(4_900);
    expect(res.newAveragePriceOre).toBe(5_900);
    expect(res.priceChangeBp).toBe(2_041);
    expect(res.text).toBe(
      "Höjer du priset på 30th Celebration med 10 kr ökar vinsten med 90 kr under 1–31 okt. om lika många pack säljs (10 pack).",
    );
  });

  it("med VMB: vinsten drar VMB-moms, och prisändringen bär 20 % VMB-moms på marginalen", () => {
    const res = priceChangeScenario({
      ...priceInput({ settings: { ...NO_TAX, vmb: true } }),
      titleId: "t-a",
      deltaOre: 1000,
    });
    // Marginal 10 × (49 − 20) = 290 kr → VMB-moms 58 kr; vinst 490 − 200 − 49 − 58 = 183 kr.
    expect(res.base).toMatchObject({
      vmbVatOre: 5_800,
      contributionOre: 18_300,
      profitOre: 18_300,
    });
    // +10 kr: + 100 kr intäkt − 10 kr provision − 20 kr VMB-moms = +70 kr.
    expect(res.selected).toMatchObject({ contributionOre: 25_300, profitChangeOre: 7_000 });
  });

  it("tabell för flera elasticiteter, 0 först och sedan fallande", () => {
    const res = priceChangeScenario({ ...priceInput(), titleId: "t-a", deltaOre: 1000 });
    expect(res.table.map((r) => r.elasticityHundredths)).toEqual([...DEFAULT_ELASTICITIES]);
    const e150 = res.table.find((r) => r.elasticityHundredths === -150)!;
    // Faktor = 1 − 1,5 × 10/49 = 34/49
    expect(e150).toMatchObject({
      volumeChangeBp: -3_061,
      units: 7,
      contributionOre: 22_967,
      profitChangeOre: -1_133,
      profitChangeBp: -470,
    });
  });

  it("vald elasticitet läggs till i tabellen och styr texten", () => {
    const res = priceChangeScenario({
      ...priceInput(),
      titleId: "t-a",
      titleName: "30th Celebration",
      deltaOre: 1000,
      elasticityHundredths: -120,
      elasticities: [0],
    });
    expect(res.table.map((r) => r.elasticityHundredths)).toEqual([0, -120]);
    expect(res.selected.elasticityHundredths).toBe(-120);
    expect(res.text).toMatch(
      /^Höjer du priset på 30th Celebration med 10 kr (ökar|minskar) vinsten med .* om försäljningen minskar med 24 % \(elasticitet −1,2\)\.$/,
    );
  });

  it("brytpunkt: vid vilken volymminskning vinsten är oförändrad", () => {
    const res = priceChangeScenario({ ...priceInput(), titleId: "t-a", deltaOre: 1000 });
    // 24 100 / 33 100 − 1 = −27,19 %; elasticitet −0,2719 × 49 / 10 = −1,33
    expect(res.breakEvenVolumeChangeBp).toBe(-2_719);
    expect(res.breakEvenElasticityHundredths).toBe(-133);
    expect(res.detail).toContain(
      "Vinsten är oförändrad om försäljningen minskar med 27 % (elasticitet −1,33).",
    );
    expect(res.detail).toContain(
      "bidrag per pack efter inköp, avgifter och provision 24,10 kr → 33,10 kr",
    );
  });

  it("utan butikernas andel (standard i panelen): texten nämner inte provisionen", () => {
    const res = priceChangeScenario({
      ...priceInput({ settings: { ...NO_TAX, deductStoreShare: false } }),
      titleId: "t-a",
      deltaOre: 1000,
    });
    expect(res.detail).toContain("bidrag per pack efter inköp och avgifter, före butikens andel");
    expect(res.detail).not.toContain("provision");
  });

  it("vinstdelning utan VMB före delningen: butikens del av ändringen räknas utan VMB-moms", () => {
    const split = (vmbBeforeSplit: boolean) =>
      priceChangeScenario({
        ...priceInput({
          agreements: [
            agreement("s-1", "2026-01-01", null, {
              commissionBp: 5_000,
              commissionBase: "profit_after_costs",
              vmbBeforeSplit,
            }),
          ],
        }),
        titleId: "t-a",
        deltaOre: 1000,
      });
    // Utan VMB (standard): +10 kr per pack delas 50/50 → +5 kr × 10 pack = +50 kr.
    const off = split(false);
    expect(off.selected.profitChangeOre).toBe(5_000);
    expect(off.text).not.toContain("hyran");
    expect(off.detail).not.toContain("hyran");
    // Med "VMB före delning": butikens del räknas på vinsten efter 20 % VMB-moms på
    // marginalen (+8 kr per pack) → butiken +4 kr, vi +6 kr per pack = +60 kr.
    expect(split(true).selected.profitChangeOre).toBe(6_000);
  });

  it("hyran är fast och ingår i titelns vinst", () => {
    const res = priceChangeScenario({
      ...priceInput({
        agreements: [
          agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6_200 }),
        ],
      }),
      titleId: "t-a",
      deltaOre: 1000,
    });
    expect(res.base.rentOre).toBe(6_200);
    expect(res.base.profitOre).toBe(17_900);
    expect(res.selected.profitOre).toBe(26_900);
    expect(res.selected.profitChangeOre).toBe(9_000);
    expect(res.selected.profitChangeBp).toBe(5_028);
  });

  it("moms och kortavgift räknas om med domänens regler", () => {
    const res = priceChangeScenario({
      ...priceInput({ settings: { vatRateBp: 2_500, cardFeeBp: 0 } }),
      titleId: "t-a",
      deltaOre: 1000,
    });
    // 49 kr: netto 39,20, provision 3,92 → bidrag 15,28. 59 kr: netto 47,20, provision 4,72 → 22,48.
    expect(res.base.contributionOre).toBe(15_280);
    expect(res.selected.contributionOre).toBe(22_480);
    expect(res.selected.profitChangeOre).toBe(7_200);
  });

  it("prissänkning", () => {
    const res = priceChangeScenario({
      ...priceInput(),
      titleId: "t-a",
      titleName: "30th Celebration",
      deltaOre: -450,
    });
    expect(res.selected.profitChangeOre).toBe(-4_050);
    expect(res.text).toBe(
      "Sänker du priset på 30th Celebration med 4,50 kr minskar vinsten med 41 kr under 1–31 okt. om lika många pack säljs (10 pack).",
    );
    expect(res.detail).toContain("Försäljningen måste öka med 20 % för samma vinst");
    // Med elasticitet −2: sänkt pris → fler pack.
    const e200 = res.table.find((r) => r.elasticityHundredths === -200)!;
    expect(e200.volumeChangeBp).toBe(1_837);
  });

  it("volymen blir aldrig negativ", () => {
    const res = priceChangeScenario({
      ...priceInput(),
      titleId: "t-a",
      deltaOre: 10_000,
      elasticities: [-500],
    });
    const row = res.table.find((r) => r.elasticityHundredths === -500)!;
    expect(row.units).toBe(0);
    expect(row.volumeChangeBp).toBe(-10_000);
    expect(row.contributionOre).toBe(0);
  });

  it("order utan inköpspris ingår inte och nämns", () => {
    const base = priceInput();
    const res = priceChangeScenario({
      ...base,
      prices: [price("t-a", 2000, "2026-10-04")],
      titleId: "t-a",
      deltaOre: 1000,
    });
    expect(res.base.units).toBe(7);
    expect(res.unpricedOrders).toBe(3);
    expect(res.detail).toContain("3 order utan inköpspris ingår inte.");
    expect(res.evidence.orderIds).toHaveLength(7);
    expect(res.evidence.dates[0]).toBe("2026-10-04");
  });

  it("titel utan prissatta order: no-data", () => {
    const res = priceChangeScenario({
      ...priceInput(),
      titleId: "t-x",
      titleName: "Okänd",
      deltaOre: 1000,
    });
    expect(res.status).toBe("no-data");
    expect(res.text).toBe("Okänd har inga sålda pack med inköpspris under 1–31 okt.");
    expect(res.breakEvenVolumeChangeBp).toBeNull();
  });

  it("oförändrat pris", () => {
    const res = priceChangeScenario({ ...priceInput(), titleId: "t-a", deltaOre: 0 });
    expect(res.selected.profitChangeOre).toBe(0);
    expect(res.table.every((r) => r.profitChangeOre === 0)).toBe(true);
    expect(res.breakEvenVolumeChangeBp).toBeNull();
  });

  it("negativt pris och ogiltig indata kastar", () => {
    expect(() =>
      priceChangeScenario({ ...priceInput(), titleId: "t-a", deltaOre: -5_000 }),
    ).toThrow(DomainError);
    expect(() => priceChangeScenario({ ...priceInput(), titleId: "t-a", deltaOre: 10.5 })).toThrow(
      DomainError,
    );
    expect(() =>
      priceChangeScenario({
        ...priceInput(),
        titleId: "t-a",
        deltaOre: 100,
        elasticityHundredths: -1.5,
      }),
    ).toThrow(DomainError);
  });

  it("underlaget pekar på orderna, titeln och talen", () => {
    const res = priceChangeScenario({ ...priceInput(), titleId: "t-a", deltaOre: 1000 });
    expect(res.evidence.titleIds).toEqual(["t-a"]);
    expect(res.evidence.orderIds).toHaveLength(10);
    expect(res.evidence.figures.find((f) => f.key === "profitChangeOre")!.value).toBe(9_000);
    expect(res.evidence.figures.find((f) => f.key === "elasticityHundredths")!.unit).toBe(
      "hundredths",
    );
  });
});
