import { describe, expect, it } from "vitest";

import { en } from "@/i18n/en";
import { sv } from "@/i18n/sv";

import type { VartLagerRow } from "../vart-lager/_lib/model";
import { needAction } from "../vart-lager/_lib/steps";
import {
  buyList,
  parsePackCount,
  parsePrice,
  priceRows,
  productProfits,
  stockBadge,
  stockRows,
  type ProductProfitRow,
} from "./model";

function row(over: Partial<VartLagerRow> & { titleId: string; name: string }): VartLagerRow {
  return {
    home: 10,
    byPlace: {},
    latestByPlace: {},
    inMachines: 0,
    sold7: 0,
    daysLeft: null,
    lastsDays: null,
    retired: false,
    status: "ok",
    runsOut: false,
    negative: false,
    unitCostOre: null,
    valueOre: null,
    latest: null,
    own: false,
    needQty: 0,
    action: null,
    fact: "",
    ...over,
  };
}

describe("Lager i den enkla vyn", () => {
  it("märket: räkna om, slut, tar snart slut eller inget", () => {
    expect(stockBadge(row({ titleId: "a", name: "A", home: -2, negative: true }))).toBe("count");
    expect(stockBadge(row({ titleId: "a", name: "A", home: 0, sold7: 3 }))).toBe("out");
    expect(stockBadge(row({ titleId: "a", name: "A", home: 0, sold7: 0 }))).toBeNull();
    expect(stockBadge(row({ titleId: "a", name: "A", home: 4, runsOut: true }))).toBe("low");
    expect(stockBadge(row({ titleId: "a", name: "A", home: 4 }))).toBeNull();
    // Utgången titel: ingen varning (den köps inte in).
    expect(stockBadge(row({ titleId: "a", name: "A", home: 0, retired: true, sold7: 2 }))).toBe(
      null,
    );
  });

  it("det som behöver göras först, sedan namnordning; utgångna utan pack visas inte", () => {
    const rows = stockRows([
      row({ titleId: "1", name: "Zeta" }),
      row({ titleId: "2", name: "Alfa" }),
      row({ titleId: "3", name: "Låg", home: 3, runsOut: true }),
      row({ titleId: "4", name: "Slut", home: 0, sold7: 5 }),
      row({ titleId: "5", name: "Fel", home: -1, negative: true }),
      row({ titleId: "6", name: "Gammal", home: 0, retired: true }),
      row({ titleId: "7", name: "Gammal hemma", home: 4, retired: true }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Fel", "Slut", "Låg", "Alfa", "Gammal hemma", "Zeta"]);
  });

  it("antal pack: heltal, minst 1 för leverans, minst 0 för räkning, högst 10 000", () => {
    expect(parsePackCount("24", 1)).toEqual({ ok: true, n: 24 });
    expect(parsePackCount(" 0 ", 0)).toEqual({ ok: true, n: 0 });
    expect(parsePackCount("0", 1)).toEqual({ ok: false, error: "min" });
    expect(parsePackCount("", 0)).toEqual({ ok: false, error: "min" });
    expect(parsePackCount("-3", 0)).toEqual({ ok: false, error: "min" });
    expect(parsePackCount("2.5", 1)).toEqual({ ok: false, error: "min" });
    expect(parsePackCount("abc", 1)).toEqual({ ok: false, error: "min" });
    expect(parsePackCount("10000", 1)).toEqual({ ok: true, n: 10_000 });
    expect(parsePackCount("10001", 0)).toEqual({ ok: false, error: "max" });
  });
});

describe("Inköpslistan", () => {
  it("samma titlar och antal som Inköp: slut först, egna produkter packas, ungefärlig kostnad", () => {
    const list = buyList([
      row({ titleId: "ok", name: "Räcker", needQty: 0 }),
      row({
        titleId: "b",
        name: "Surging Sparks",
        home: 6,
        daysLeft: 4,
        needQty: 24,
        unitCostOre: 4500,
      }),
      row({ titleId: "a", name: "Destined Rivals", home: 0, daysLeft: 0, needQty: 36 }),
      row({ titleId: "m", name: "Mystery", home: 2, daysLeft: 2, needQty: 10, own: true }),
      row({ titleId: "r", name: "Utgått", home: 0, retired: true, needQty: 0, runsOut: true }),
    ]);
    expect(list.items.map((i) => [i.name, i.qty, i.own, i.out])).toEqual([
      ["Destined Rivals", 36, false, true],
      ["Mystery", 10, true, false],
      ["Surging Sparks", 24, false, false],
    ]);
    expect(list.items.find((i) => i.titleId === "b")?.costOre).toBe(24 * 4500);
    // Utan pris ingen kostnad; egna produkter räknas inte (de packas).
    expect(list.items.find((i) => i.titleId === "a")?.costOre).toBeNull();
    expect(list.items.find((i) => i.titleId === "m")?.costOre).toBeNull();
    expect(list.totalOre).toBe(108_000);
    expect(list.unpriced).toBe(1);
    expect(list.noPlan).toBe(false);
  });

  it("mystery pack: hela omgångar; under 0 hemma räknas om först", () => {
    const action = needAction({ own: true, needQty: 28, mysteryBatchSize: 14, home: -1 });
    const list = buyList([
      row({
        titleId: "m",
        name: "Mystery Pack premium",
        home: -1,
        negative: true,
        own: true,
        needQty: 28,
        runsOut: true,
        action,
      }),
    ]);
    expect(list.items[0]).toMatchObject({ qty: 28, batches: 2, countFirst: true, home: 0 });
    expect(sv.r2.t3.countFirst(sv.r2.t3.packBatches(2))).toBe("1. Räkna om. 2. Packa 2 omgångar.");
    expect(en.r2.t3.countFirst(en.r2.t3.packBatches(1))).toBe("1. Count again. 2. Pack 1 batch.");
  });

  it("utan inköpsplan: titlarna som tar slut, utan antal", () => {
    const list = buyList([
      row({ titleId: "a", name: "A", home: 2, runsOut: true, needQty: null }),
      row({ titleId: "b", name: "B", home: 20, needQty: null }),
    ]);
    expect(list.noPlan).toBe(true);
    expect(list.items.map((i) => [i.name, i.qty])).toEqual([["A", null]]);
  });
});

describe("Inköpspriser", () => {
  it("dagens pris per aktiv titel; utan pris först, sedan namn", () => {
    const { rows, missing } = priceRows(
      [
        { id: "a", name: "Surging Sparks" },
        { id: "b", name: "Destined Rivals" },
        { id: "c", name: "Gammal", archived: true },
        { id: "d", name: "Dubblett", mergedIntoId: "a" },
        { id: "e", name: "Mystery", ownProduct: true },
      ],
      [
        { titleId: "a", unitCostOre: 4000, validFrom: "2026-01-01" },
        { titleId: "a", unitCostOre: 4500, validFrom: "2026-10-01" },
        { titleId: "a", unitCostOre: 9900, validFrom: "2026-12-01" },
        { titleId: "e", unitCostOre: 7607, validFrom: "2026-11-01" },
      ],
      "2026-11-09",
    );
    expect(rows.map((r) => [r.name, r.unitCostOre, r.validFrom, r.own])).toEqual([
      ["Destined Rivals", null, null, false],
      ["Mystery", 7607, "2026-11-01", true],
      ["Surging Sparks", 4500, "2026-10-01", false],
    ]);
    expect(missing).toBe(1);
  });

  it("priset i kronor: komma eller punkt, tomt, fel och för högt", () => {
    expect(parsePrice("112,50")).toEqual({ ok: true, ore: 11250 });
    expect(parsePrice("112.50")).toEqual({ ok: true, ore: 11250 });
    expect(parsePrice("45")).toEqual({ ok: true, ore: 4500 });
    expect(parsePrice("45 kr")).toEqual({ ok: true, ore: 4500 });
    expect(parsePrice("  ")).toEqual({ ok: false, error: "required" });
    expect(parsePrice("abc")).toEqual({ ok: false, error: "invalid" });
    expect(parsePrice("-5")).toEqual({ ok: false, error: "invalid" });
    expect(parsePrice("100001")).toEqual({ ok: false, error: "tooHigh" });
  });
});

describe("Vinst per produkt", () => {
  const base: Omit<ProductProfitRow, "key"> = {
    kind: "item",
    orders: 0,
    pricedOrders: 0,
    unpricedOrders: 0,
    revenueOre: 0,
    unpricedRevenueOre: 0,
    profitBeforeShareOre: 0,
  };

  it("mest vinst först, före butikernas andel, per pack med pris; utan pris sist", () => {
    const out = productProfits(
      [
        {
          ...base,
          key: "a",
          orders: 10,
          pricedOrders: 10,
          revenueOre: 63_200,
          profitBeforeShareOre: 18_000,
        },
        {
          ...base,
          key: "b",
          orders: 4,
          pricedOrders: 3,
          unpricedOrders: 1,
          revenueOre: 18_960,
          unpricedRevenueOre: 6_320,
          profitBeforeShareOre: 30_000,
        },
        { ...base, key: "c", orders: 2, unpricedOrders: 2, unpricedRevenueOre: 12_640 },
        { ...base, key: "d", orders: 0 },
        { ...base, key: "total", kind: "total", orders: 16, profitBeforeShareOre: 48_000 },
      ],
      [
        { id: "a", name: "Surging Sparks" },
        { id: "b", name: "Destined Rivals" },
        { id: "c", name: "Utan pris" },
      ],
    );
    expect(out.map((r) => [r.name, r.packs, r.profitOre, r.perPackOre, r.noPrice])).toEqual([
      ["Destined Rivals", 4, 30_000, 10_000, false],
      ["Surging Sparks", 10, 18_000, 1_800, false],
      ["Utan pris", 2, 0, null, true],
    ]);
    // Försäljningen räknar alla köp (även de utan inköpspris), som Försäljning.
    expect(out[0]!.salesOre).toBe(25_280);
  });
});
