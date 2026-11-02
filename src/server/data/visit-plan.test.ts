import { describe, expect, it } from "vitest";

import { planVisits } from "@/analytics/visits";
import { daily, machine, many, title } from "@/analytics/todos/test-helpers";
import { businessDateAt } from "@/analytics/todos/time";

import { extraVisitsFromHealth, planNow, weeklyVisitPlan } from "./visit-plan";

const TZ = "Europe/Stockholm";
/** Måndag 2 nov. 2026 11:00. */
const NOW = new Date("2026-11-02T10:00:00Z");
const TODAY = "2026-11-02";

const machines = [
  machine("m1", "Automat 1", { code: "BL-001" }),
  machine("m2", "Automat 2", { code: "BL-002" }),
];
const titles = [title("t1", "Black Bolt")];

/** m1 säljer 2 om dagen, m2 1 om dagen, 14 hela dagar t.o.m. i går. */
const base = [...daily("t1", "m1", "2026-10-19", 14, 2), ...daily("t1", "m2", "2026-10-19", 14, 1)];

function plan(args: {
  orders?: typeof base;
  stock?: { machineId: string; titleId: string; onHand: number }[];
  health?: {
    machineId: string;
    status: "ok" | "offline" | "fault" | "suspected_fault" | "empty";
  }[];
}) {
  return weeklyVisitPlan({
    orders: args.orders ?? base,
    machines,
    titles,
    stock: args.stock ?? [
      { machineId: "m1", titleId: "t1", onHand: 5 },
      { machineId: "m2", titleId: "t1", onHand: 10 },
    ],
    warehouseStock: null,
    health: args.health ?? null,
    today: TODAY,
    timeZone: TZ,
    now: NOW,
  });
}

const dayOf = (p: ReturnType<typeof plan>, machineId: string) =>
  p.days.find((d) => d.stops.some((s) => s.machineId === machineId))?.date ?? null;

describe("weeklyVisitPlan (Lager och Drift)", () => {
  it("planNow ger i går i organisationens tidszon", () => {
    expect(businessDateAt(planNow("2026-11-01", TZ, NOW), TZ)).toBe("2026-11-01");
  });

  it("räknar takten på gårdagen: dagens försäljning ändrar inte besöksdagen", () => {
    const plain = plan({});
    // Tio extra order i dag på m2 (redan dragna från saldot) ändrar inte takten.
    const withToday = plan({
      orders: [...base, ...many(10, { titleId: "t1", machineId: "m2", businessDate: TODAY })],
    });
    expect(dayOf(withToday, "m1")).toBe(dayOf(plain, "m1"));
    expect(dayOf(withToday, "m2")).toBe(dayOf(plain, "m2"));
    expect(plain.period.start).toBe(TODAY);
  });

  it("är samma plan som planeraren med gårdagens tidpunkt (det Lager gjorde förut)", () => {
    const direct = planVisits(
      {
        orders: base,
        machines,
        titles,
        stock: [
          { machineId: "m1", titleId: "t1", onHand: 5 },
          { machineId: "m2", titleId: "t1", onHand: 10 },
        ],
        extraVisits: [],
        options: { timeZone: TZ, start: TODAY },
      },
      planNow("2026-11-01", TZ, NOW),
    );
    expect(plan({})).toEqual(direct);
  });

  it("automater med fel enligt maskinhälsan får besök i dag, som på Drift", () => {
    const p = plan({
      health: [
        { machineId: "m2", status: "offline" },
        { machineId: "m1", status: "ok" },
      ],
    });
    expect(dayOf(p, "m2")).toBe(TODAY);
    expect(p.days[0]!.stops.find((s) => s.machineId === "m2")?.reasons.join(" ")).toContain(
      "Ur drift",
    );
    expect(extraVisitsFromHealth([{ machineId: "m1", status: "ok" }], TODAY)).toEqual([]);
  });
});
