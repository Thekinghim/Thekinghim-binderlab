import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import { flagPurchaseAnomalies, purchasePriceTrends, type PurchaseRecord } from "./market";
import { plain } from "./test-fixtures";

function p(
  id: string,
  date: string,
  unitCostOre: number,
  supplierId = "sup-a",
  quantity = 10,
  titleId = "t-a",
): PurchaseRecord {
  return { id, titleId, supplierId, date, unitCostOre, quantity };
}

const TITLES = [{ id: "t-a", name: "30th Celebration" }];
const SUPPLIERS = [
  { id: "sup-a", name: "Leverantör A" },
  { id: "sup-b", name: "Leverantör B" },
];

describe("purchasePriceTrends", () => {
  const purchases = [
    p("p1", "2026-01-10", 2_800, "sup-a", 10),
    p("p2", "2026-01-20", 3_000, "sup-b", 30),
    p("p3", "2026-10-05", 3_200, "sup-a", 20),
    p("p4", "2026-10-15", 3_000, "sup-b", 20),
    p("x1", "2026-03-01", 1_000, "sup-a", 5, "t-b"),
  ];

  it("snittpris per månad viktat med antal och förändring första → senaste månaden", () => {
    const [a] = purchasePriceTrends({ purchases, titles: TITLES, suppliers: SUPPLIERS });
    expect(a!.titleId).toBe("t-a");
    // jan: (2 800 × 10 + 3 000 × 30) / 40 = 2 950; okt: (3 200 × 20 + 3 000 × 20) / 40 = 3 100
    expect(a!.months.map((m) => [m.month, m.averageOre])).toEqual([
      ["2026-01", 2_950],
      ["2026-10", 3_100],
    ]);
    // (3 100 − 2 950) / 2 950 = 5,08 %
    expect(a!.changeBp).toBe(508);
    expect(a!.medianOre).toBe(3_000);
    expect(a!.weightedAverageOre).toBe(3_025);
    expect([a!.minOre, a!.maxOre]).toEqual([2_800, 3_200]);
    expect(a!.first).toEqual({ date: "2026-01-10", unitCostOre: 2_800 });
    expect(a!.last).toEqual({ date: "2026-10-15", unitCostOre: 3_000 });
  });

  it("leverantörer sorteras billigast först och jämförs med titelns median", () => {
    const [a] = purchasePriceTrends({ purchases, titles: TITLES, suppliers: SUPPLIERS });
    // B: median 3 000 (0 %); A: median 3 000 (2 800, 3 200) → lika, id avgör
    expect(a!.suppliers.map((s) => [s.supplierId, s.medianOre, s.vsTitleMedianBp])).toEqual([
      ["sup-a", 3_000, 0],
      ["sup-b", 3_000, 0],
    ]);
    expect(a!.suppliers[0]!.lastOre).toBe(3_200);
  });

  it("billigare leverantör får negativ avvikelse och nämns i texten", () => {
    const [a] = purchasePriceTrends({
      purchases: [
        p("1", "2026-01-01", 3_000),
        p("2", "2026-02-01", 3_000),
        p("3", "2026-03-01", 2_700, "sup-b"),
      ],
      titles: TITLES,
      suppliers: SUPPLIERS,
    });
    expect(a!.suppliers[0]!.supplierId).toBe("sup-b");
    expect(a!.suppliers[0]!.vsTitleMedianBp).toBe(-1_000);
    expect(plain(a!.text)).toBe(
      "30th Celebration: snittpriset har gått från 30,00 kr (januari) till 27,00 kr (mars), −10 %. Billigast är Leverantör B, median 27,00 kr (−10 % mot titelns median 30,00 kr).",
    );
  });

  it("underlaget länkar till inköpen", () => {
    const [a, b] = purchasePriceTrends({ purchases });
    expect(a!.evidence.purchaseIds).toEqual(["p1", "p2", "p3", "p4"]);
    expect(b!.titleId).toBe("t-b");
    expect(b!.changeBp).toBeNull();
    expect(b!.evidence.purchaseIds).toEqual(["x1"]);
  });

  it("årtal skrivs ut när månaderna ligger i olika år", () => {
    const [a] = purchasePriceTrends({
      purchases: [p("1", "2025-12-01", 3_000), p("2", "2026-01-01", 3_300)],
      titles: TITLES,
    });
    expect(plain(a!.text)).toContain("(december 2025) till 33,00 kr (januari 2026), +10 %");
  });

  it("dubbletter och ogiltiga inköp kastar", () => {
    expect(() =>
      purchasePriceTrends({ purchases: [p("1", "2026-01-01", 1), p("1", "2026-01-02", 1)] }),
    ).toThrow(DomainError);
    expect(() => purchasePriceTrends({ purchases: [p("1", "2026-01-01", 1, "sup-a", 0)] })).toThrow(
      DomainError,
    );
    expect(() => purchasePriceTrends({ purchases: [p("1", "2026-02-30", 1)] })).toThrow(
      DomainError,
    );
    expect(() => purchasePriceTrends({ purchases: [p("1", "2026-01-01", 10.5)] })).toThrow(
      DomainError,
    );
  });

  it("inga inköp ger tom lista", () => {
    expect(purchasePriceTrends({ purchases: [] })).toEqual([]);
  });
});

describe("flagPurchaseAnomalies", () => {
  // Historik 2 800–3 000: median 2 900, avvikelser 100, 0, 100, 100, 100 → MAD 100.
  const history = [
    p("h1", "2026-01-01", 2_800),
    p("h2", "2026-02-01", 2_900),
    p("h3", "2026-03-01", 3_000),
    p("h4", "2026-04-01", 2_800),
    p("h5", "2026-05-01", 3_000),
  ];

  it("dyrt inköp: robust z över 3,5 och minst 5 % över medianen", () => {
    const [f, ...rest] = flagPurchaseAnomalies({
      purchases: [...history, p("new", "2026-06-01", 3_600, "sup-b", 24)],
      titles: TITLES,
      suppliers: SUPPLIERS,
    });
    expect(rest).toEqual([]);
    expect(f!.direction).toBe("expensive");
    expect(f!.medianOre).toBe(2_900);
    expect(f!.madOre).toBe(100);
    // 0,6745 × 700 / 100 = 4,72
    expect(f!.robustZHundredths).toBe(472);
    expect(f!.deviationBp).toBe(2_414);
    expect(f!.impactOre).toBe(700 * 24);
    expect(f!.historyCount).toBe(5);
    expect(f!.evidence.purchaseIds).toEqual(["h1", "h2", "h3", "h4", "h5", "new"]);
    expect(plain(f!.text)).toBe(
      "Dyrt inköp: 30th Celebration från Leverantör B 1 juni kostade 36,00 kr per pack, 24 % över medianen 29,00 kr för 5 tidigare inköp (robust z 4,72). Merkostnad 168,00 kr på 24 pack.",
    );
  });

  it("billigt inköp flaggas med negativ avvikelse", () => {
    const [f] = flagPurchaseAnomalies({ purchases: [...history, p("new", "2026-06-01", 2_300)] });
    expect(f!.direction).toBe("cheap");
    expect(f!.impactOre).toBe(-6_000);
    expect(plain(f!.text)).toContain("Besparing 60,00 kr");
  });

  it("inom gränsen flaggas inte (z ≤ 3,5)", () => {
    // 0,6745 × 500 / 100 = 3,37
    expect(
      flagPurchaseAnomalies({ purchases: [...history, p("new", "2026-06-01", 3_400)] }),
    ).toEqual([]);
  });

  it("för få tidigare inköp flaggas inte", () => {
    expect(
      flagPurchaseAnomalies({ purchases: [...history.slice(0, 4), p("new", "2026-06-01", 9_000)] }),
    ).toEqual([]);
    expect(
      flagPurchaseAnomalies(
        { purchases: [...history.slice(0, 4), p("new", "2026-06-01", 9_000)] },
        { minHistory: 4 },
      ),
    ).toHaveLength(1);
  });

  it("MAD 0: flaggas när avvikelsen är minst 5 %, annars inte", () => {
    const same = [1, 2, 3, 4, 5].map((i) => p(`s${i}`, `2026-0${i}-01`, 3_000));
    const [f] = flagPurchaseAnomalies({ purchases: [...same, p("new", "2026-07-01", 3_150)] });
    expect(f!.robustZHundredths).toBeNull();
    expect(f!.deviationBp).toBe(500);
    expect(plain(f!.text)).toContain("alla jämförda inköp kostade 30,00 kr eller nära det");
    expect(flagPurchaseAnomalies({ purchases: [...same, p("new", "2026-07-01", 3_140)] })).toEqual(
      [],
    );
  });

  it("liten öresskillnad flaggas inte trots hög z när historiken är jämn", () => {
    const tight = [3_000, 3_001, 3_000, 2_999, 3_000, 3_001, 2_999].map((v, i) =>
      p(`t${i}`, `2026-0${i + 1}-01`, v),
    );
    // MAD 1, z = 0,6745 × 20 = 13,5 men avvikelsen är 0,7 %
    expect(flagPurchaseAnomalies({ purchases: [...tight, p("new", "2026-09-01", 3_020)] })).toEqual(
      [],
    );
  });

  it("historiken är bara tidigare inköp inom lookbackDays; samma dag räknas inte", () => {
    const purchases = [...history, p("same", "2026-06-01", 9_000), p("new", "2026-06-01", 3_600)];
    const flags = flagPurchaseAnomalies({ purchases });
    expect(flags.map((f) => f.purchaseId)).toEqual(["new", "same"]);
    expect(flags[0]!.historyCount).toBe(5);
    // Med 60 dagars historik finns bara h4 och h5.
    expect(flagPurchaseAnomalies({ purchases }, { lookbackDays: 60 })).toEqual([]);
  });

  it("from/to begränsar vilka inköp som flaggas men inte historiken", () => {
    const purchases = [...history, p("new", "2026-06-01", 3_600)];
    expect(flagPurchaseAnomalies({ purchases }, { from: "2026-06-02" })).toEqual([]);
    expect(
      flagPurchaseAnomalies({ purchases }, { from: "2026-06-01", to: "2026-06-01" }),
    ).toHaveLength(1);
  });

  it("titlar jämförs var för sig", () => {
    const other = history.map((h) => ({
      ...h,
      id: `o-${h.id}`,
      titleId: "t-b",
      unitCostOre: 9_000,
    }));
    expect(
      flagPurchaseAnomalies({ purchases: [...history, ...other, p("new", "2026-06-01", 2_900)] }),
    ).toEqual([]);
  });

  it("ogiltiga inställningar kastar", () => {
    expect(() => flagPurchaseAnomalies({ purchases: history }, { minHistory: 0 })).toThrow(
      DomainError,
    );
    expect(() => flagPurchaseAnomalies({ purchases: history }, { from: "2026-13-01" })).toThrow(
      DomainError,
    );
  });
});
