import { describe, expect, it } from "vitest";
import { buildLedger } from "./ledger";
import { profitability, UNALLOCATED_KEY } from "./profitability";
import { rentByStoreMonth } from "./rent";
import { agreement, NO_TAX, order, placement, price } from "./testing/fixtures";
import type { ProfitabilityInput } from "./types";

describe("rentByStoreMonth", () => {
  it("hel månad ger exakt månadshyran", () => {
    const r = rentByStoreMonth([agreement("s-1", "2026-01-01", null, { monthlyRentOre: 50_000 })], {
      start: "2026-02-01",
      end: "2026-02-28",
    });
    expect(r).toEqual([
      expect.objectContaining({
        storeId: "s-1",
        month: "2026-02",
        rentOre: 50_000,
        days: 28,
        daysInMonth: 28,
      }),
    ]);
  });

  it("delmånad: round(hyra × dagar / dagar i månaden)", () => {
    // 10–20 nov = 11 dagar: 100 000 × 11 / 30 = 36 666,67 → 36 667
    const r = rentByStoreMonth(
      [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 100_000 })],
      { start: "2026-11-10", end: "2026-11-20" },
    );
    expect(r[0]).toMatchObject({ rentOre: 36_667, days: 11 });
  });

  it("perioden går över två månader: en rad per månad", () => {
    // 20 okt–10 nov: okt 12 av 31 dagar, nov 10 av 30 dagar
    // okt: 31 000 × 12 / 31 = 12 000; nov: 31 000 × 10 / 30 = 10 333,33 → 10 333
    const r = rentByStoreMonth([agreement("s-1", "2026-01-01", null, { monthlyRentOre: 31_000 })], {
      start: "2026-10-20",
      end: "2026-11-10",
    });
    expect(r.map((x) => [x.month, x.days, x.rentOre])).toEqual([
      ["2026-10", 12, 12_000],
      ["2026-11", 10, 10_333],
    ]);
  });

  it("avtal byts mitt i månaden: hyrorna vägs efter dagar, en avrundning", () => {
    // Nov (30 dagar): 1–15 nov 30 000 kr/mån, 16–30 nov 45 000 kr/mån
    // (3 000 000 × 15 + 4 500 000 × 15) / 30 = 3 750 000 öre
    const r = rentByStoreMonth(
      [
        agreement("s-1", "2026-01-01", "2026-11-15", { monthlyRentOre: 3_000_000 }),
        agreement("s-1", "2026-11-16", null, { monthlyRentOre: 4_500_000 }),
      ],
      { start: "2026-11-01", end: "2026-11-30" },
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ rentOre: 3_750_000, days: 30 });
    expect(r[0]!.segments.map((s) => [s.start, s.end, s.days, s.monthlyRentOre])).toEqual([
      ["2026-11-01", "2026-11-15", 15, 3_000_000],
      ["2026-11-16", "2026-11-30", 15, 4_500_000],
    ]);
  });

  it("avtal som slutar och lucka: bara dagar med avtal", () => {
    // Avtalet slutar 10 nov: 10 dagar av 30 → 90 000 × 10 / 30 = 30 000
    const r = rentByStoreMonth(
      [agreement("s-1", "2026-01-01", "2026-11-10", { monthlyRentOre: 90_000 })],
      { start: "2026-11-01", end: "2026-11-30" },
    );
    expect(r[0]).toMatchObject({ rentOre: 30_000, days: 10 });
  });

  it("bara provision eller hyra 0 ger ingen rad; februari i skottår", () => {
    expect(
      rentByStoreMonth([agreement("s-1", "2026-01-01", null, { commissionBp: 1500 })], {
        start: "2026-11-01",
        end: "2026-11-30",
      }),
    ).toEqual([]);
    expect(
      rentByStoreMonth(
        [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 0, commissionBp: 1 })],
        {
          start: "2026-11-01",
          end: "2026-11-30",
        },
      ),
    ).toEqual([]);
    // 1 dag av 29: 29 000 / 29 = 1 000
    const r = rentByStoreMonth([agreement("s-1", "2024-01-01", null, { monthlyRentOre: 29_000 })], {
      start: "2024-02-29",
      end: "2024-02-29",
    });
    expect(r[0]).toMatchObject({ rentOre: 1_000, daysInMonth: 29 });
  });
});

describe("fördelning av hyra på order", () => {
  const base: Omit<ProfitabilityInput, "orders" | "agreements"> = {
    prices: [price("t-a", 2000, "2026-01-01"), price("t-b", 1000, "2026-01-01")],
    placements: [
      placement("m-1", "s-1", "2026-01-01", null),
      placement("m-2", "s-1", "2026-01-01", null),
      placement("m-3", "s-2", "2026-01-01", null),
    ],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("efter nettointäkt med största-restmetoden, exakt på öret", () => {
    const orders = [
      order({ id: "a", machineId: "m-1", businessDate: "2026-11-03", amountOre: 4900 }),
      order({ id: "b", machineId: "m-2", businessDate: "2026-11-04", amountOre: 4900 }),
      order({ id: "c", machineId: "m-2", businessDate: "2026-11-05", amountOre: 9800 }),
    ];
    const ledger = buildLedger({
      ...base,
      orders,
      agreements: [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 10_001 })],
    });
    // 10 001 × (4900, 4900, 9800) / 19 600 = 2500,25 / 2500,25 / 5000,5 → 2500 / 2500 / 5001
    expect(ledger.entries.map((e) => [e.order.id, e.rentOre])).toEqual([
      ["a", 2500],
      ["b", 2500],
      ["c", 5001],
    ]);
    expect(ledger.unallocatedRent).toEqual([]);
  });

  it("resultatet beror inte på i vilken ordning orderna kommer", () => {
    const orders = Array.from({ length: 7 }, (_, i) =>
      order({
        id: `x${i}`,
        machineId: "m-1",
        businessDate: `2026-11-0${(i % 3) + 1}`,
        amountOre: 4900,
      }),
    );
    const agreements = [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 10_000 })];
    const a = buildLedger({ ...base, orders, agreements });
    const b = buildLedger({ ...base, orders: [...orders].reverse(), agreements });
    const byId = (l: typeof a) => Object.fromEntries(l.entries.map((e) => [e.order.id, e.rentOre]));
    expect(byId(a)).toEqual(byId(b));
    expect(Object.values(byId(a)).reduce((x, y) => x + y, 0)).toBe(10_000);
  });

  it("butik utan order: hyran blir ej fördelad", () => {
    const orders = [order({ machineId: "m-1", businessDate: "2026-11-03", amountOre: 4900 })];
    const input: ProfitabilityInput = {
      ...base,
      orders,
      agreements: [
        agreement("s-1", "2026-01-01", null, { commissionBp: 1000 }),
        agreement("s-2", "2026-01-01", null, { monthlyRentOre: 25_000 }),
      ],
    };
    const ledger = buildLedger(input);
    expect(ledger.unallocatedRent.map(({ segments: _s, ...u }) => u)).toEqual([
      { storeId: "s-2", month: "2026-11", rentOre: 25_000 },
    ]);
    // Avtalets dagar följer med, så att vyer per dag kan lägga hyran där den gäller.
    expect(ledger.unallocatedRent[0]!.segments).toMatchObject([
      { start: "2026-11-01", end: "2026-11-30", days: 30, monthlyRentOre: 25_000 },
    ]);

    const byTitle = profitability(input, "title");
    const unallocated = byTitle.rows.find((r) => r.key === UNALLOCATED_KEY)!;
    expect(unallocated).toMatchObject({
      kind: "unallocated",
      orders: 0,
      rentOre: 25_000,
      unallocatedRentOre: 25_000,
      profitOre: -25_000,
      marginBp: null,
    });
    const byStore = profitability(input, "store");
    expect(byStore.rows.find((r) => r.key === "s-2")).toMatchObject({
      kind: "item",
      orders: 0,
      rentOre: 25_000,
      unallocatedRentOre: 25_000,
    });
    expect(byStore.rows.some((r) => r.key === UNALLOCATED_KEY)).toBe(false);
    const byMonth = profitability(input, "month");
    expect(byMonth.rows).toHaveLength(1);
    expect(byMonth.rows[0]).toMatchObject({ key: "2026-11", unallocatedRentOre: 25_000 });
  });

  it("order med nettointäkt 0: hyran fördelas lika", () => {
    const orders = [
      order({ id: "a", machineId: "m-1", businessDate: "2026-11-03", amountOre: 0 }),
      order({ id: "b", machineId: "m-1", businessDate: "2026-11-03", amountOre: 0 }),
    ];
    const ledger = buildLedger({
      ...base,
      orders,
      agreements: [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 3 })],
    });
    expect(ledger.entries.map((e) => e.rentOre)).toEqual([2, 1]);
  });
});
