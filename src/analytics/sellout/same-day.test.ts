/**
 * Runda 2 (T4-3): Att göra, larmen och besöksplanen ska nämna SAMMA slutdag för samma
 * indata. Alla tre anropar sellOut() med automatens veckoform.
 */

import { describe, expect, it } from "vitest";

import { lowStockAlerts } from "@/analytics/alerts";
import { computeTodos } from "@/analytics/todos";
import { refillTodos } from "@/analytics/todos/refill";
import { createTodoContext } from "@/analytics/todos/context";
import { input, machine, order, title } from "@/analytics/todos/test-helpers";
import type { AnalyticsOrder } from "@/analytics/todos/types";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import { weeklyVisitPlan } from "@/server/data/visit-plan";

import { weekShapes } from "./week-shape";

// Torsdag 12 nov. 2026 kl. 10 svensk tid.
const NOW = new Date("2026-11-12T09:00:00Z");
const TODAY = "2026-11-12" as IsoDate;
const AS_OF = "2026-11-11" as IsoDate;

/** Helgen säljer mest: lör 22, tors och fre 14, övriga 5 pack per dag (snitt 10). */
const perDay = (weekday: number) => (weekday === 6 ? 22 : weekday === 4 || weekday === 5 ? 14 : 5);

function history(days: number, machineId = "m1"): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(AS_OF, -d);
    for (let i = 0; i < perDay(dayOfWeek(date)); i++) {
      out.push(order({ titleId: "t1", machineId, businessDate: date }));
    }
  }
  return out;
}

const titles = [title("t1", "Black Bolt")];
const machines = [machine("m1", "Automat 1")];

function all(orders: AnalyticsOrder[], onHand: number, shapes?: ReturnType<typeof weekShapes>) {
  const stock = [{ machineId: "m1", titleId: "t1", onHand }];
  const todo = computeTodos(input({ orders, stock, titles, machines }), NOW).find(
    (t) => t.key === "refill:m1:t1",
  );
  const [alert] = lowStockAlerts({ orders, stock, machines, titles }, NOW);
  const plan = weeklyVisitPlan({
    orders,
    machines,
    titles,
    stock,
    warehouseStock: null,
    today: TODAY,
    timeZone: "Europe/Stockholm",
    now: NOW,
    ...(shapes ? { weekShares: shapes } : {}),
  });
  const stop = plan.days.flatMap((d) => d.stops).find((s) => s.machineId === "m1");
  return { todo, alert, plan, stop };
}

describe("samma slutdag i Att göra, larmen och besöksplanen", () => {
  it("28 pack en torsdag: tors 14 + fre 14 = slut i morgon (fredag); snittet hade sagt lördag", () => {
    const { todo, alert, stop } = all(history(45), 28);
    // Att göra: snittet (2,8 dagar) når inte gränsen 2,5, men veckoformen gör det.
    expect(todo).toBeDefined();
    expect(todo!.daysLeft).toBe(2);
    expect(todo!.detail).toContain("Tar slut i morgon – fyll på i dag.");
    expect(todo!.detail).toContain("Räknat med vilka veckodagar automaten säljer mest.");
    // Larmet: samma dag.
    expect(alert).toBeDefined();
    expect(alert!.evidence.dates).toEqual(["2026-11-13"]);
    expect(alert!.title).toBe("Black Bolt i Automat 1 tar slut i morgon");
    // Besöksplanen: samma dag, besök senast i dag.
    expect(stop).toBeDefined();
    expect(stop!.packs.find((p) => p.titleId === "t1")?.stockoutDate).toBe("2026-11-13");
    expect(stop!.needBy).toBe(TODAY);
    expect(stop!.reasons.join(" ").replace(/ /g, " ")).toContain("tar slut fre 13 nov.");
  });

  it("punktens form och nyckel är oförändrade (T2 grupperar på nyckeln)", () => {
    const { todo } = all(history(45), 28);
    expect(todo).toMatchObject({
      key: "refill:m1:t1",
      kind: "refill",
      title: "Fyll på Black Bolt i Automat 1",
      link: "/lager?automat=m1&titel=t1",
      action: { kind: "register-refill", params: { machineId: "m1", titleId: "t1" } },
    });
    expect(Object.keys(todo!).sort()).toEqual(
      [
        "action",
        "atStakeOre",
        "daysLeft",
        "detail",
        "evidence",
        "fingerprint",
        "key",
        "kind",
        "level",
        "link",
        "title",
        "urgency",
      ].sort(),
    );
  });

  it("20 dagars historik: platt snitt överallt, och fortfarande samma dag", () => {
    // 14 dagars takt: 140 pack → 10 per dag. 20 pack = 2,0 dagar → slut fredag 13 nov.
    const { todo, alert, stop } = all(history(20), 20);
    expect(todo!.detail).toContain("räcker ca 2,0 dagar");
    expect(todo!.detail).toContain("Tar slut i morgon – fyll på i dag.");
    expect(todo!.detail).not.toContain("veckodagar");
    expect(alert!.evidence.dates).toEqual(["2026-11-13"]);
    expect(stop!.packs.find((p) => p.titleId === "t1")?.stockoutDate).toBe("2026-11-13");
  });

  it("en sida med bara 15 dagars order får samma dag när den skickar formerna (laddaren)", () => {
    const full = history(45);
    const shapes = weekShapes(full, { asOf: AS_OF, machines });
    expect(shapes.has("m1")).toBe(true);
    const recent = history(15);
    // Utan formerna: platt snitt (2,8 dagar → lördag) och ingen punkt i Att göra.
    const without = all(recent, 28);
    expect(without.todo).toBeUndefined();
    expect(without.stop!.packs.find((p) => p.titleId === "t1")?.stockoutDate).toBe("2026-11-14");
    // Med formerna: fredag, som Att göra med full historik.
    const withShapes = all(recent, 28, shapes);
    expect(withShapes.stop!.packs.find((p) => p.titleId === "t1")?.stockoutDate).toBe(
      "2026-11-13",
    );
    const ctx = createTodoContext(
      input({ orders: recent, stock: [{ machineId: "m1", titleId: "t1", onHand: 28 }], titles, machines }),
      NOW,
    );
    const [viaOption] = refillTodos(ctx, { weekShares: shapes });
    expect(viaOption?.detail).toContain("Tar slut i morgon – fyll på i dag.");
  });
});
