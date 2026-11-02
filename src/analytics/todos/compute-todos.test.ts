import { describe, expect, it } from "vitest";
import { computeTodos, sortTodos, urgencyOf } from "./index";
import { daily, input, machine, NOW, order, title } from "./test-helpers";
import type { TodoInput, TodoItem } from "./types";

const SCENARIO: TodoInput = input({
  titles: [title("t1", "Black Bolt"), title("t2", "Black bolt"), title("t3", "Mystery Pack")],
  machines: [machine("m1", "Automat 1"), machine("m2", "Automat 2")],
  orders: [
    ...daily("t1", "m1", "2026-10-19", 14, 2),
    ...daily("t3", "m1", "2026-10-19", 14, 1),
    order({
      titleId: "t2",
      machineId: "m1",
      businessDate: "2026-11-01",
      orderedAt: "2026-11-01T12:00:00Z",
    }),
    order({
      titleId: "t3",
      machineId: "m2",
      businessDate: "2026-10-28",
      orderedAt: "2026-10-28T12:00:00Z",
    }),
  ],
  prices: [{ titleId: "t1", unitCostOre: 2_500, validFrom: "2026-01-01" }],
  stock: [
    { machineId: "m1", titleId: "t1", onHand: 0 },
    { machineId: "m1", titleId: "t3", onHand: 2 },
  ],
  reportRecipients: [{ id: "r1", name: "Anna", kind: "store", storeId: "s1", active: true }],
});
const scenario = () => SCENARIO;

describe("computeTodos", () => {
  it("samlar alla regler och sorterar efter brådska", () => {
    const todos = computeTodos(scenario(), NOW);
    expect(todos.map((t) => t.key)).toEqual([
      "refill:m1:t1", // now, 686 kr i risk
      "stale-machine:m2", // now
      "refill:m1:t3", // soon
      "missing-price:t3",
      "duplicate-title:t1:t2", // later, samma belopp som missing-price:t2 → nyckelordning
      "missing-price:t2",
      "report-due:r1:2026-10",
    ]);
    for (const t of todos) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.detail.length).toBeGreaterThan(0);
      expect(t.link.startsWith("/")).toBe(true);
      expect(t.evidence.rule.length).toBeGreaterThan(0);
      expect(`${t.title} ${t.detail}`).not.toMatch(/\.\./);
    }
  });

  it("är deterministisk och oberoende av ordningen i indata", () => {
    const a = scenario();
    const b: TodoInput = {
      ...a,
      orders: [...a.orders].reverse(),
      titles: [...a.titles].reverse(),
      machines: [...a.machines].reverse(),
      stock: [...a.stock].reverse(),
    };
    expect(computeTodos(b, NOW)).toEqual(computeTodos(a, NOW));
  });

  it("'nu' kan anges som Date, ms eller ISO med offset", () => {
    const expected = computeTodos(scenario(), NOW);
    expect(computeTodos(scenario(), new Date(NOW))).toEqual(expected);
    expect(computeTodos(scenario(), Date.parse(NOW))).toEqual(expected);
    expect(computeTodos(scenario(), "2026-11-02T18:00:00+08:00")).toEqual(expected);
  });

  it("dagens datum räknas i svensk tid: 23:30 UTC 1 nov. är 2 nov.", () => {
    const i = input({
      reportRecipients: [
        { id: "r1", name: "Anna", kind: "accountant", storeId: null, active: true },
      ],
    });
    expect(computeTodos(i, "2026-10-31T22:30:00Z")[0]?.key).toBe("report-due:r1:2026-09");
    expect(computeTodos(i, "2026-10-31T23:30:00Z")[0]?.key).toBe("report-due:r1:2026-10");
  });

  it("avvisar ogiltig tid och ogiltiga inställningar", () => {
    expect(() => computeTodos(scenario(), "2026-11-02 10:00")).toThrow();
    expect(() => computeTodos({ ...scenario(), options: { refillWindowDays: 0 } }, NOW)).toThrow();
    expect(() => computeTodos({ ...scenario(), options: { staleHours: 1.5 } }, NOW)).toThrow();
  });

  it("tom indata ger inga punkter", () => {
    expect(computeTodos(input(), NOW)).toEqual([]);
  });
});

describe("urgencyOf och sortTodos", () => {
  it("nivån väger tyngst, sedan belopp", () => {
    expect(urgencyOf("now", 0)).toBeGreaterThan(urgencyOf("soon", 10 ** 15));
    expect(urgencyOf("soon", 500)).toBeGreaterThan(urgencyOf("soon", 499));
    expect(urgencyOf("later", null)).toBe(urgencyOf("later", 0));
    expect(urgencyOf("later", -5)).toBe(urgencyOf("later", 0));
  });

  it("lika brådska: minst dagar kvar först, sedan nyckel", () => {
    const t = (key: string, daysLeft: number | null): TodoItem =>
      ({ key, urgency: urgencyOf("later", null), daysLeft }) as TodoItem;
    expect(sortTodos([t("c", null), t("b", 5), t("a", 5), t("d", 1)]).map((x) => x.key)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });
});
