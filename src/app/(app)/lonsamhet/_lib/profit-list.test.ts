import { describe, expect, it } from "vitest";

import type { ProfitLine } from "./model";
import {
  barCostOre,
  barMaxOre,
  barRevenueOre,
  barTitle,
  costNoun,
  profitListGroups,
  subLine,
  totalLine,
} from "./profit-list";

/** Hårda mellanslag som vanliga, så att förväntningarna går att läsa. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

const line = (over: Partial<ProfitLine> & { key: string }): ProfitLine => ({
  kind: "item",
  name: over.key,
  code: null,
  orders: 10,
  revenueOre: 100_000,
  costOre: 60_000,
  feesOre: 0,
  vmbVatOre: 0,
  compensationOre: 0,
  profitOre: 40_000,
  marginBp: 4_000,
  unpricedOrders: 0,
  unpricedRevenueOre: 0,
  priceHref: null,
  ...over,
});

const unpriced = line({
  key: "op",
  orders: 41,
  unpricedOrders: 41,
  revenueOre: 0,
  costOre: 0,
  profitOre: 0,
  marginBp: null,
  unpricedRevenueOre: 528_900,
  priceHref: "/inkopspriser?titel=op",
});

describe("profitListGroups", () => {
  it("vinst först (mest först), utan pris för sig, särskilda rader sist", () => {
    const rows = [
      line({ key: "a", profitOre: 1_000 }),
      unpriced,
      line({ key: "hyra", kind: "unallocated", profitOre: -5_000 }),
      line({ key: "b", profitOre: 9_000 }),
      line({ key: "c", profitOre: -2_000 }),
    ];
    const g = profitListGroups(rows);
    expect(g.priced.map((r) => r.key)).toEqual(["b", "a", "c"]);
    expect(g.unpriced.map((r) => r.key)).toEqual(["op"]);
    expect(g.special.map((r) => r.key)).toEqual(["hyra"]);
  });
});

describe("stapeln", () => {
  it("utan pris visar intäkten utan pris; skalan är den största stapeln", () => {
    const a = line({ key: "a", revenueOre: 300_000 });
    expect(barRevenueOre(unpriced)).toBe(528_900);
    expect(barRevenueOre(a)).toBe(300_000);
    expect(barMaxOre([a, unpriced, line({ key: "x", kind: "no-store", revenueOre: 9e9 })])).toBe(
      528_900,
    );
  });

  it("det grå är allt som inte är vinst", () => {
    const r = line({
      key: "a",
      revenueOre: 100_000,
      costOre: 50_000,
      feesOre: 2_000,
      profitOre: 48_000,
    });
    expect(barCostOre(r)).toBe(52_000);
  });

  it("rubrikens ord: inköp bara utan avgifter, VMB och dragen andel", () => {
    expect(costNoun(line({ key: "t" }), false)).toBe("inköp");
    expect(costNoun(line({ key: "t", compensationOre: 500 }), false)).toBe("inköp");
    expect(costNoun(line({ key: "t", compensationOre: 500 }), true)).toBe("kostnader");
    expect(costNoun(line({ key: "t", feesOre: 1 }), false)).toBe("kostnader");
  });
});

describe("texterna", () => {
  it("raden under namnet", () => {
    expect(plain(subLine(line({ key: "a", orders: 100, revenueOre: 2_190_000 })))).toBe(
      "100 sålda · 21 900 kr intäkt",
    );
    expect(plain(subLine(unpriced))).toBe("41 sålda · 5 289 kr intäkt");
    expect(
      plain(subLine(line({ key: "a", orders: 1, unpricedOrders: 0, revenueOre: 10_000 }))),
    ).toBe("1 såld · 100 kr intäkt");
    expect(
      plain(subLine(line({ key: "a", orders: 12, unpricedOrders: 3, unpricedRevenueOre: 30_000 }))),
    ).toBe("12 sålda · 1 300 kr intäkt · 3 utan pris");
  });

  it("tooltip och totalrad", () => {
    expect(plain(barTitle(line({ key: "a" }), "inköp", "Vår vinst"))).toBe(
      "Intäkt 1 000 kr · Inköp 600 kr · Vår vinst 400 kr",
    );
    expect(plain(barTitle(unpriced, "inköp", "Vår vinst"))).toBe(
      "Intäkt 5 289 kr · inköpspris saknas",
    );
    expect(plain(totalLine(line({ key: "t", orders: 775, revenueOre: 12_179_200 })))).toBe(
      "Totalt 775 order · 121 792 kr intäkt med pris",
    );
  });
});
