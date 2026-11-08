import { describe, expect, it } from "vitest";

import { daysIn, figuresOf, machineSales, salesPeriods, type SalesRow } from "./model";

const row = (key: string, over: Partial<SalesRow> = {}): SalesRow => ({
  key,
  orders: 2,
  revenueOre: 10_000,
  unpricedRevenueOre: 0,
  unpricedOrders: 0,
  profitBeforeShareOre: 4_000,
  ...over,
});

describe("salesPeriods", () => {
  it("veckan från måndag, månaden från den första, läsningen från den tidigaste", () => {
    // Söndag 1 november 2026: veckan började måndag 26 oktober.
    const p = salesPeriods("2026-11-01");
    expect(p.today).toEqual({ start: "2026-11-01", end: "2026-11-01" });
    expect(p.week).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(p.month).toEqual({ start: "2026-11-01", end: "2026-11-01" });
    expect(p.all.start).toBe("2026-10-26");
  });

  it("mitt i månaden börjar läsningen vid månadens start", () => {
    const p = salesPeriods("2026-11-18");
    expect(p.week.start).toBe("2026-11-16");
    expect(p.all.start).toBe("2026-11-01");
  });
});

describe("figuresOf", () => {
  it("summerar pack, försäljning (även utan inköpspris) och vinst före andelen", () => {
    const f = figuresOf([
      row("2026-11-01"),
      row("2026-11-02", { unpricedRevenueOre: 2_500, unpricedOrders: 1, orders: 3 }),
    ]);
    expect(f).toEqual({ packs: 5, salesOre: 22_500, profitOre: 8_000, unpriced: 1 });
  });

  it("dagar inom perioden", () => {
    const rows = [row("2026-10-31"), row("2026-11-01"), row("2026-11-02")];
    expect(daysIn(rows, { start: "2026-11-01", end: "2026-11-02" }).map((r) => r.key)).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});

describe("machineSales", () => {
  it("mest sålda först, automater utan köp sist, arkiverade utan köp syns inte", () => {
    const out = machineSales(
      [row("a", { revenueOre: 5_000 }), row("b", { revenueOre: 9_000 })],
      [
        { id: "a", name: "ICA" },
        { id: "b", name: "Coop" },
        { id: "c", name: "Willys" },
        { id: "d", name: "Gammal", archived: true },
      ],
    );
    expect(out.map((m) => m.id)).toEqual(["b", "a", "c"]);
    expect(out[2]).toMatchObject({ packs: 0, salesOre: 0, profitOre: 0 });
  });
});
