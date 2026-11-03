import { describe, expect, it } from "vitest";

import type { AwishGrpcOrder } from "@/import/adapters/awish-grpc";

import {
  collectOrders,
  detectOrder,
  EMPTY_CURSOR,
  parseCursor,
  type OrdersPage,
  type SyncCursor,
} from "./paging";

const NOW = new Date("2026-11-03T12:00:00Z");
const TZ = "UTC";

/** Order med id 1..n; id n är nyast. Tiden: en timme per id bakåt från NOW. */
function makeOrders(n: number, hoursPerId = 1): AwishGrpcOrder[] {
  return Array.from({ length: n }, (_, i) => {
    const id = i + 1;
    const t = new Date(NOW.getTime() - (n - id) * hoursPerId * 3_600_000);
    const pay = t.toISOString().slice(0, 19).replace("T", " ");
    return {
      id: String(id),
      date: pay.slice(0, 10),
      tradeId: null,
      title: "T",
      amount: "1.00",
      payTime: pay,
      status: "PAY_SUCCESS",
      isFree: false,
      taxTotal: null,
      pickupCodeId: null,
      paymentId: "5",
      machineId: "1",
      records: [],
      totalCashAmount: null,
      changeCashAmount: null,
    };
  });
}

function source(all: () => AwishGrpcOrder[], order: "desc" | "asc", perPage = 20) {
  const requested: number[] = [];
  const fetchPage = async (page: number): Promise<OrdersPage> => {
    requested.push(page);
    const sorted = [...all()].sort((a, b) =>
      order === "desc" ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id),
    );
    return {
      items: sorted.slice((page - 1) * perPage, page * perPage),
      total: sorted.length,
      perPage,
      lastPage: Math.max(1, Math.ceil(sorted.length / perPage)),
    };
  };
  return { fetchPage, requested };
}

function ids(orders: AwishGrpcOrder[]): number[] {
  return orders.map((o) => Number(o.id)).sort((a, b) => a - b);
}

describe("detectOrder", () => {
  it("jämför första och sista id (som tal, inte text)", () => {
    expect(detectOrder([{ id: "10" }, { id: "9" }])).toBe("desc");
    expect(detectOrder([{ id: "9" }, { id: "10" }])).toBe("asc");
    expect(detectOrder([{ id: "1" }])).toBeNull();
    expect(detectOrder([{ id: "18446744073709551615" }, { id: "18446744073709551614" }])).toBe(
      "desc",
    );
  });
});

describe("parseCursor", () => {
  it("tål skräp och behåller giltiga fält", () => {
    expect(parseCursor(null)).toEqual(EMPTY_CURSOR);
    expect(parseCursor({ order: "x", gap: { page: -1 }, history: { page: 3 } })).toEqual({
      ...EMPTY_CURSOR,
      history: { page: 3 },
    });
  });
});

for (const order of ["desc", "asc"] as const) {
  describe(`collectOrders (${order})`, () => {
    it("första körningen läser hela historiken över flera körningar", async () => {
      const all = makeOrders(250);
      const src = source(() => all, order);
      let cursor: SyncCursor = EMPTY_CURSOR;
      const seen = new Set<number>();
      let maxKnown: string | null = null;
      for (let run = 0; run < 10 && !cursor.historyDone; run += 1) {
        const r = await collectOrders({
          fetchPage: src.fetchPage,
          cursor,
          maxKnownId: maxKnown,
          now: NOW,
          sourceTimezone: TZ,
          maxPages: 6,
        });
        expect(r.order).toBe(order);
        r.orders.forEach((o) => seen.add(Number(o.id)));
        cursor = r.cursor;
        maxKnown = String(Math.max(...seen));
      }
      expect(cursor.historyDone).toBe(true);
      expect(seen.size).toBe(250);
    });

    it("en vanlig körning läser bara det senaste dygnet och stannar vid kända order", async () => {
      const all = makeOrders(250);
      const src = source(() => all, order);
      const r = await collectOrders({
        fetchPage: src.fetchPage,
        cursor: { ...EMPTY_CURSOR, order, historyDone: true },
        maxKnownId: "250",
        now: NOW,
        sourceTimezone: TZ,
        maxPages: 50,
      });
      // Dygnet = id 226..250 (25 order) → två sidor om 20.
      expect(r.headComplete).toBe(true);
      expect(r.pages).toBeLessThanOrEqual(order === "desc" ? 2 : 3);
      expect(ids(r.orders)).toEqual(expect.arrayContaining(range(226, 250)));
    });

    it("läser vidare förbi dygnet tills en redan importerad order har setts", async () => {
      // Tio nya order sedan sist, alla inom dygnet, och 90 äldre men okända.
      const all = makeOrders(100, 0.1);
      const src = source(() => all, order);
      const r = await collectOrders({
        fetchPage: src.fetchPage,
        cursor: { ...EMPTY_CURSOR, order, historyDone: true },
        maxKnownId: "30",
        now: NOW,
        sourceTimezone: TZ,
        maxPages: 50,
      });
      expect(r.headComplete).toBe(true);
      expect(ids(r.orders)).toEqual(expect.arrayContaining(range(30, 100)));
    });

    it("ett glapp efter en lång paus fortsätter nästa körning", async () => {
      let all = makeOrders(100);
      const src = source(() => all, order);
      const first = await collectOrders({
        fetchPage: src.fetchPage,
        cursor: { ...EMPTY_CURSOR, order, historyDone: true },
        maxKnownId: "10",
        now: NOW,
        sourceTimezone: TZ,
        maxPages: 2,
      });
      expect(first.headComplete).toBe(false);
      expect(first.budgetExhausted).toBe(true);
      expect(first.cursor.gaps[0]?.stopAtId).toBe("10");
      const seen = new Set(first.orders.map((o) => Number(o.id)));
      // Fem nya order kommer innan nästa körning.
      all = makeOrders(105);
      let cursor = first.cursor;
      // Huvudet (det senaste dygnet, och i "asc" även sida 1 för sidantalet) tar några sidor
      // per körning; resten går till glappet.
      for (let run = 0; run < 10 && cursor.gaps.length > 0; run += 1) {
        const r = await collectOrders({
          fetchPage: src.fetchPage,
          cursor,
          maxKnownId: String(Math.max(...seen)),
          now: NOW,
          sourceTimezone: TZ,
          maxPages: 6,
        });
        r.orders.forEach((o) => seen.add(Number(o.id)));
        cursor = r.cursor;
      }
      expect(cursor.gaps).toEqual([]);
      for (const id of range(10, 105)) expect(seen.has(id), String(id)).toBe(true);
    });
  });
}

describe("collectOrders: ordningen", () => {
  it("avgör ordningen med sista sidan när sida 1 bara har en order", async () => {
    const all = makeOrders(21);
    const src = source(() => all, "asc");
    const r = await collectOrders({
      fetchPage: async (p) => {
        const res = await src.fetchPage(p);
        // Låtsas att sida 1 har en enda order.
        return p === 1 ? { ...res, items: res.items.slice(0, 1) } : res;
      },
      cursor: EMPTY_CURSOR,
      maxKnownId: null,
      now: NOW,
      sourceTimezone: TZ,
      maxPages: 10,
    });
    expect(r.order).toBe("asc");
  });

  it("tom lista: inget att läsa och historiken är klar", async () => {
    const src = source(() => [], "desc");
    const r = await collectOrders({
      fetchPage: src.fetchPage,
      cursor: EMPTY_CURSOR,
      maxKnownId: null,
      now: NOW,
      sourceTimezone: TZ,
      maxPages: 10,
    });
    expect(r.orders).toEqual([]);
    expect(r.cursor.historyDone).toBe(true);
    expect(src.requested).toEqual([1]);
  });

  it("tidsgränsen stoppar läsningen och sparar läget", async () => {
    const all = makeOrders(200);
    const src = source(() => all, "desc");
    let t = 0;
    const r = await collectOrders({
      fetchPage: async (p) => {
        t += 1000;
        return src.fetchPage(p);
      },
      cursor: EMPTY_CURSOR,
      maxKnownId: null,
      now: NOW,
      sourceTimezone: TZ,
      maxPages: 50,
      deadlineAt: 3000,
      clock: () => t,
    });
    expect(r.pages).toBe(3);
    expect(r.cursor.historyDone).toBe(false);
    expect(r.cursor.history?.page).toBeGreaterThan(1);
  });
});

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
