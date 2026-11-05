/**
 * "Varor i Awish": flaggorna, ordningen (åtgärd först, sedan bäst säljande), sökning,
 * filter och raden efter en sparad ändring.
 */

import { describe, expect, it } from "vitest";

import {
  buildGoodsOverview,
  filterGoodRows,
  goodsFilterCounts,
  isLowMargin,
  withEditedGood,
  type GoodsOverviewInput,
} from "./goods-overview";

const link = (titleId: string, titleName: string, purchasePriceOre: number | null) => ({
  titleId,
  titleName,
  ownProduct: false,
  purchasePriceOre,
});

function input(over: Partial<GoodsOverviewInput> = {}): GoodsOverviewInput {
  return {
    goods: [
      { id: 1, name: "Delta Reign", priceOre: 15_000, image: "/bild?1" },
      { id: 2, name: "Mystery Pack", priceOre: 4_900, image: "/bild?2" },
      { id: 3, name: "Okänd vara", priceOre: 9_900, image: null },
      { id: 4, name: "Billig Box", priceOre: 10_000, image: "/bild?4" },
      { id: 5, name: "mystery  pack", priceOre: 4_900, image: "/bild?5" },
    ],
    links: new Map([
      [1, link("t-delta", "Delta Reign", 9_000)],
      [2, link("t-mp", "Mystery Pack", null)],
      [4, link("t-box", "Billig Box", 8_000)],
      [5, link("t-mp", "Mystery Pack", null)],
    ]),
    sales: new Map([
      ["t-delta", { orders: 12, revenueOre: 180_000 }],
      ["t-box", { orders: 3, revenueOre: 30_000 }],
    ]),
    slots: [
      { goodId: 1, machine: "BL-002 Hallen", slot: "B1", count: 2, capacity: 8 },
      { goodId: 1, machine: "BL-001 Sega", slot: "A1", count: 5, capacity: 10 },
      { goodId: 2, machine: "BL-001 Sega", slot: "A2", count: 4, capacity: 10 },
      { goodId: null, machine: "BL-001 Sega", slot: "A3", count: 0, capacity: 10 },
    ],
    warehouse: new Map([["t-delta", 20]]),
    economics: new Map([
      ["t-delta", { leftBeforeOre: 5_625, leftOre: 4_000 }],
      ["t-box", { leftBeforeOre: 1_750, leftOre: 1_750 }],
    ]),
    showShare: false,
    allMachines: true,
    ...over,
  };
}

describe("buildGoodsOverview", () => {
  it("räknar per vara: sålt, fack, lager, kvar per order", () => {
    const rows = buildGoodsOverview(input());
    const delta = rows.find((r) => r.id === 1)!;
    expect(delta).toMatchObject({
      titleId: "t-delta",
      sold30: 12,
      revenue30Ore: 180_000,
      packsInSlots: 7,
      warehouse: 20,
      purchaseOre: 9_000,
      leftOre: 5_625,
      shareLeftOre: null,
      flags: [],
    });
    // Facken i automatordning.
    expect(delta.slots.map((s) => `${s.machine} ${s.slot}`)).toEqual([
      "BL-001 Sega A1",
      "BL-002 Hallen B1",
    ]);
  });

  it("flaggor, en per problem", () => {
    const rows = buildGoodsOverview(input());
    const flags = (id: number) => rows.find((r) => r.id === id)!.flags.map((f) => f.label);
    expect(flags(2)).toEqual([
      "Samma namn två gånger i Awish",
      "Saknar inköpspris",
      "Sålt 0 st på 30 d",
    ]);
    expect(flags(3)).toEqual([
      "Inte kopplad till Binderlab",
      "Ingen bild",
      "Ligger inte i något fack",
    ]);
    expect(flags(4)).toEqual(["Ligger inte i något fack", "Låg marginal"]);
    expect(flags(5)).toEqual([
      "Samma namn två gånger i Awish",
      "Saknar inköpspris",
      "Ligger inte i något fack",
    ]);
  });

  it("ordning: åtgärd först, sedan bäst säljande, sedan namn", () => {
    const rows = buildGoodsOverview(input());
    expect(rows.map((r) => r.id)).toEqual([4, 5, 2, 3, 1]);
  });

  it("vald butik: vår del visas, Sålt 0 st flaggas inte", () => {
    const rows = buildGoodsOverview(input({ showShare: true, allMachines: false }));
    expect(rows.find((r) => r.id === 1)!.shareLeftOre).toBe(4_000);
    expect(rows.find((r) => r.id === 2)!.flags.map((f) => f.kind)).not.toContain("no-sales");
  });
});

describe("isLowMargin", () => {
  it("inköp minst 80 % av priset", () => {
    expect(isLowMargin(8_000, 10_000)).toBe(true);
    expect(isLowMargin(7_999, 10_000)).toBe(false);
    expect(isLowMargin(null, 10_000)).toBe(false);
    expect(isLowMargin(100, null)).toBe(false);
  });
});

describe("filter och sökning", () => {
  it("chipsen och sökrutan", () => {
    const rows = buildGoodsOverview(input());
    expect(goodsFilterCounts(rows)).toEqual({
      alla: 5,
      atgard: 4,
      "i-automat": 2,
      "inte-i-automat": 3,
    });
    expect(filterGoodRows(rows, "atgard", "").map((r) => r.id)).toEqual([4, 5, 2, 3]);
    expect(filterGoodRows(rows, "i-automat", "").map((r) => r.id)).toEqual([2, 1]);
    expect(filterGoodRows(rows, "alla", "  MYSTERY ").map((r) => r.id)).toEqual([5, 2]);
    expect(filterGoodRows(rows, "alla", "3").map((r) => r.id)).toEqual([3]);
  });
});

describe("withEditedGood", () => {
  it("nytt namn, pris och bild; flaggorna räknas om och ordningen följer", () => {
    const rows = buildGoodsOverview(input());
    const next = withEditedGood(rows, 5, { name: "Mystery Pack XL", priceOre: 5_900, image: null });
    const row = next.find((r) => r.id === 5)!;
    expect(row.name).toBe("Mystery Pack XL");
    expect(row.flags.map((f) => f.kind)).toEqual(["no-purchase", "no-image", "no-slot"]);
    expect(next.find((r) => r.id === 2)!.flags.map((f) => f.kind)).not.toContain("duplicate");
    const cheaper = withEditedGood(rows, 1, { name: "Delta Reign", priceOre: 11_000, image: "/b" });
    expect(cheaper.find((r) => r.id === 1)!.flags.map((f) => f.kind)).toEqual(["low-margin"]);
  });
});
