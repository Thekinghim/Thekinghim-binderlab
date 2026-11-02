import { describe, expect, it } from "vitest";
import { titleEconomics } from "./titles";
import { agreement, order, placement, price } from "./testing/fixtures";
import type { TitleEconomicsInput } from "./titles";

/**
 * November, en automat i butik 1 (provision 10 %, hyra 90,20 kr/mån), kortavgift 2,5 %, ingen moms.
 * Nettointäkt totalt 45 100 öre; hyran 9 020 = 1/5 av den, så varje order bär exakt 20 % i hyra
 * (980 öre per order à 49,00, 1 180 öre per order à 59,00).
 */
const input: TitleEconomicsInput = {
  orders: [
    ...["01", "02", "03", "04"].map((d) => order({ titleId: "t-a", businessDate: `2026-11-${d}` })),
    order({ titleId: "t-b", businessDate: "2026-11-05" }),
    order({ titleId: "t-b", businessDate: "2026-11-06" }),
    order({ titleId: "t-c", businessDate: "2026-11-07", amountOre: 5900 }),
    order({ titleId: "t-e", businessDate: "2026-11-10" }),
    order({ titleId: "t-e", businessDate: "2026-11-20" }),
  ],
  prices: [
    price("t-a", 2000, "2026-01-01"),
    price("t-b", 4800, "2026-01-01"),
    price("t-d", 1000, "2026-01-01"),
    price("t-e", 3000, "2026-01-01"),
    price("t-e", 3500, "2026-11-15"),
  ],
  agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 9020 })],
  placements: [placement("m-1", "s-1", "2026-01-01", null)],
  settings: { vatRateBp: 0, cardFeeBp: 250 },
  period: { start: "2026-11-01", end: "2026-11-30" },
  titleIds: ["t-f"],
};

describe("titleEconomics", () => {
  const rows = titleEconomics(input);
  const row = (id: string) => rows.find((r) => r.titleId === id)!;

  it("kvar per order = snittpris − aktuellt inköp − snittavgift − snittprovision", () => {
    // t-a: (19 600 − 4 × 123 − 4 × 490 − 4 × 2 000) / 4 = 9 148 / 4 = 2 287
    expect(row("t-a")).toMatchObject({
      orders: 4,
      averagePriceOre: 4900,
      currentUnitCostOre: 2000,
      averageFeeOre: 123,
      averageCommissionOre: 490,
      leftPerOrderOre: 2287,
      rentPerOrderOre: 980,
      leftPerOrderAfterRentOre: 1307, // (9 148 − 3 920) / 4
      marginBp: 4667, // 9 148 / 19 600
      lossWarning: false,
      missingPrice: false,
    });
  });

  it("förlustvarning när kvar per order ≤ 0", () => {
    // t-b: (9 800 − 246 − 980 − 9 600) / 2 = −1 026 / 2 = −513
    expect(row("t-b")).toMatchObject({
      leftPerOrderOre: -513,
      marginBp: -1047,
      lossWarning: true,
      lossAfterRentWarning: true,
    });
  });

  it("saknat pris markeras och ger ingen kvar-siffra", () => {
    expect(row("t-c")).toMatchObject({
      orders: 1,
      unpricedOrders: 1,
      averagePriceOre: 5900,
      currentUnitCostOre: null,
      leftPerOrderOre: null,
      lossWarning: false,
      missingPrice: true,
    });
  });

  it("aktuellt pris är det som gäller periodens slut; snittinköp är det som faktiskt gällde", () => {
    // t-e: order 10 nov (3 000) och 20 nov (3 500); aktuellt 3 500
    // kvar = (9 800 − 246 − 980 − 2 × 3 500) / 2 = 787
    expect(row("t-e")).toMatchObject({
      currentUnitCostOre: 3500,
      currentPriceValidFrom: "2026-11-15",
      averageCostOre: 3250,
      leftPerOrderOre: 787,
    });
    const earlier = titleEconomics({ ...input, asOf: "2026-11-14" }).find(
      (r) => r.titleId === "t-e",
    )!;
    expect(earlier).toMatchObject({ currentUnitCostOre: 3000, leftPerOrderOre: 1287 }); // (8 574 − 6 000) / 2
  });

  it("titlar utan försäljning finns med", () => {
    expect(row("t-d")).toMatchObject({
      orders: 0,
      currentUnitCostOre: 1000,
      averagePriceOre: null,
      leftPerOrderOre: null,
    });
    expect(row("t-f")).toMatchObject({ orders: 0, missingPrice: true, lossWarning: false });
  });

  it("sorterad på intäkt, sedan id", () => {
    expect(rows.map((r) => r.titleId)).toEqual(["t-a", "t-b", "t-e", "t-c", "t-d", "t-f"]);
  });
});
