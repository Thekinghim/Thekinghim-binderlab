import { describe, expect, it } from "vitest";

import {
  defaultShopId,
  filterCounts,
  groupByCity,
  inFilter,
  latestStatement,
  matchesShop,
  NO_CITY_LABEL,
  paymentHistory,
  shareHistory,
  type SettlementLike,
} from "./v2-model";

const shop = (
  id: string,
  city: string | null,
  payOre: number,
  profitOre: number,
  power: { on: string; off: string } | null = null,
) => ({ id, name: `Butik ${id}`, city, payOre, power, profitOre });

describe("listan", () => {
  const rows = [
    shop("a", "Borås", 0, 100),
    shop("b", "Borås", 500, 50, { on: "10:00", off: "21:00" }),
    shop("c", "Alingsås", 0, 300),
    shop("d", null, 0, 10),
  ];

  it("filtrerar och räknar", () => {
    expect(filterCounts(rows)).toEqual({ alla: 4, betala: 1, natt: 1, alltid: 3 });
    expect(rows.filter((r) => inFilter(r, "betala")).map((r) => r.id)).toEqual(["b"]);
  });

  it("söker på namn och stad", () => {
    expect(matchesShop(rows[0]!, "borå")).toBe(true);
    expect(matchesShop(rows[0]!, "butik a")).toBe(true);
    expect(matchesShop(rows[0]!, "lerum")).toBe(false);
    expect(matchesShop(rows[0]!, "  ")).toBe(true);
  });

  it("grupperar per stad, att betala först, utan stad sist", () => {
    const groups = groupByCity(rows);
    expect(groups.map((g) => g.city)).toEqual(["Alingsås", "Borås", NO_CITY_LABEL]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(groups[1]!.payStores).toBe(1);
    expect(groups[1]!.profitOre).toBe(150);
  });

  it("väljer den första butiken med något att betala", () => {
    expect(defaultShopId(rows)).toBe("b");
    expect(defaultShopId([rows[0]!])).toBe("a");
    expect(defaultShopId([])).toBeNull();
  });
});

const settlement = (p: Partial<SettlementLike> & { month: string }): SettlementLike => ({
  id: `s-${p.month}`,
  storeId: "a",
  amountOre: 1000,
  state: "paid",
  paidOn: `${p.month}-20`,
  paidOre: 1000,
  statement: null,
  ...p,
});

describe("butikens historik", () => {
  it("andelen per månad slutar med månaden som pågår", () => {
    const bars = shareHistory(
      [
        settlement({ month: "2026-08", amountOre: 800 }),
        settlement({ month: "2026-09", amountOre: 900 }),
        settlement({ month: "2026-10", amountOre: 1000 }),
        settlement({ month: "2026-10", storeId: "b", amountOre: 5 }),
      ],
      "a",
      { month: "2026-11", earnedOre: 400, days: 21 },
      3,
    );
    expect(bars.map((b) => [b.month, b.amountOre, b.running])).toEqual([
      ["2026-09", 900, false],
      ["2026-10", 1000, false],
      ["2026-11", 400, true],
    ]);
  });

  it("visar den obetalda uträkningen före den senaste betalda", () => {
    const statement = { modelText: "x", steps: [], totalOre: 1 };
    const list = [
      settlement({ month: "2026-09", statement }),
      settlement({ month: "2026-10", statement, state: "unpaid", paidOn: null }),
      settlement({ month: "2026-11", statement: null }),
    ];
    expect(latestStatement(list, "a")?.month).toBe("2026-10");
    expect(latestStatement(list, "b")).toBeNull();
  });

  it("betalningar och betalda avräkningar utan att räkna förskottet två gånger", () => {
    const rows = paymentHistory(
      [
        {
          id: "p1",
          storeId: "a",
          paidOn: "2026-10-16",
          amountOre: 600,
          periodStart: "2026-10-01",
          periodEnd: "2026-10-14",
          parts: [{ month: "2026-10", amountOre: 600 }],
        },
      ],
      [
        settlement({ month: "2026-10", paidOn: "2026-11-05", paidOre: 1000 }),
        settlement({ month: "2026-09", paidOn: "2026-10-05", paidOre: 900 }),
        settlement({ month: "2026-08", paidOn: null }),
      ],
      "a",
    );
    expect(rows.map((r) => [r.paidOn, r.amountOre, r.kind])).toEqual([
      ["2026-11-05", 400, "settlement"],
      ["2026-10-16", 600, "payment"],
      ["2026-10-05", 900, "settlement"],
    ]);
    expect(rows[0]!.start).toBe("2026-10-01");
    expect(rows[0]!.end).toBe("2026-10-31");
  });
});
