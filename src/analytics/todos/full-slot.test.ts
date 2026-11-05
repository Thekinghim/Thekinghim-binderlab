import { describe, expect, it } from "vitest";

import { isFull } from "@/app/fyll-pa/_lib/model";
import { planVisits } from "@/analytics/visits";

import { computeTodos } from "./index";
import { isFullSlot, withCapacities, withSlotAlerts } from "./refill";
import { daily, input, machine, NOW, title, TODAY } from "./test-helpers";
import type { StockLevelRef, TodoInput } from "./types";

// Fönstret: 14 dagar t.o.m. i går = 19 okt.–1 nov. 2026, 3 pack per dag.
const base = (p: Partial<TodoInput> = {}) =>
  input({
    titles: [title("t1", "Prismatic Evolution")],
    orders: daily("t1", "m1", "2026-10-19", 14, 3),
    ...p,
  });
const refills = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "refill");
const slot = (onHand: number, capacity?: number | null): StockLevelRef => ({
  machineId: "m1",
  titleId: "t1",
  onHand,
  ...(capacity !== undefined ? { capacity } : {}),
});

describe("fullt fack (som Fyll på)", () => {
  it("isFullSlot: känd kapacitet och saldo ≥ kapacitet; samma svar som Fyll på", () => {
    const cases: [number, number | null][] = [
      [6, 6],
      [7, 6],
      [5, 6],
      [0, 6],
      [6, null],
      [6, 0],
      [-1, 6],
    ];
    for (const [now, cap] of cases) expect(isFullSlot(now, cap)).toBe(isFull(now, cap));
    expect(isFullSlot(6, 6)).toBe(true);
    expect(isFullSlot(5, 6)).toBe(false);
    expect(isFullSlot(6, undefined)).toBe(false);
  });

  it("fullt fack som säljer fort ger ingen påfyllningspunkt (Att göra och Hem)", () => {
    // 6 pack vid 3 per dag räcker 2,0 dagar: utan kapacitet "Fyll på", fullt = ingen punkt.
    expect(refills(base({ stock: [slot(6)] }))).toHaveLength(1);
    expect(refills(base({ stock: [slot(6, null)] }))).toHaveLength(1);
    expect(refills(base({ stock: [slot(6, 6)] }))).toHaveLength(0);
    // Ett pack sålt: inte fullt längre, regeln gäller igen.
    const [t] = refills(base({ stock: [slot(5, 6)] }));
    expect(t?.title).toBe("Fyll på Prismatic Evolution i Automat 1");
  });

  it("larmgränsen ger ingen punkt för ett fullt fack, inte heller withSlotAlerts", () => {
    const slotAlerts = [{ machineId: "m1", titleId: "t1", alertAtUnits: 8 }];
    expect(refills(base({ orders: [], stock: [slot(6, 6)], slotAlerts }))).toHaveLength(0);
    expect(refills(base({ orders: [], stock: [slot(6, 10)], slotAlerts }))).toHaveLength(1);
    const args = {
      alerts: slotAlerts,
      machines: [machine("m1", "Automat 1")],
      titles: [title("t1", "Prismatic Evolution")],
      today: TODAY,
    };
    expect(withSlotAlerts([], { ...args, stock: [slot(6, 6)] })).toHaveLength(0);
    expect(withSlotAlerts([], { ...args, stock: [slot(6)] })).toHaveLength(1);
  });

  it("withCapacities summerar kapaciteten per automat och titel", () => {
    const out = withCapacities(
      [slot(4), { machineId: "m2", titleId: "t1", onHand: 1 }],
      [
        { machineId: "m1", titleId: "t1", capacity: 3 },
        { machineId: "m1", titleId: "t1", capacity: 3 },
        { machineId: "m1", titleId: "t2", capacity: 9 },
        { machineId: "m2", titleId: "t1", capacity: 0 },
      ],
    );
    expect(out.map((s) => s.capacity)).toEqual([6, null]);
  });

  it("besöksplanen (Drift, Lager): ett fullt fack behöver inget besök i dag", () => {
    const visitInput = (capacity: number) => ({
      machines: [{ id: "m1", name: "Automat 1", activeFrom: null, activeTo: null }],
      titles: [{ id: "t1", name: "Prismatic Evolution" }],
      // 3 pack per dag de 14 dagarna t.o.m. i dag; 2 kvar räcker inte i morgon.
      orders: daily("t1", "m1", "2026-10-20", 14, 3),
      stock: [{ machineId: "m1", titleId: "t1", onHand: 2 }],
      capacities: [{ machineId: "m1", titleId: "t1", capacity }],
    });
    const notFull = planVisits(visitInput(12), NOW);
    expect(notFull.days[0]?.date).toBe("2026-11-02");
    expect(notFull.days[0]?.stops[0]?.needBy).toBe("2026-11-02");
    const full = planVisits(visitInput(2), NOW);
    const stop = full.days.flatMap((d) => d.stops).find((s) => s.machineId === "m1");
    expect(stop?.needBy).toBe("2026-11-03");
  });
});
