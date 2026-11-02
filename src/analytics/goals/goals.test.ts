import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import { dailyOrders } from "../expansion/test-fixtures";
import { activeMachinesOn, goalProgress, type Goal, type GoalInput } from "./goals";

/**
 * m-1 i s-1 från 1 okt.: ett pack à 49 kr per dag 1 okt.–10 nov. (inköp 20 kr, ingen provision
 * eller hyra → vinst 29 kr per pack). m-2 placeras i s-2 den 20 nov.
 */
function input(goals: Goal[], asOf = "2026-11-10", extra: Partial<GoalInput> = {}): GoalInput {
  return {
    orders: dailyOrders("m-1", "2026-10-01", 41),
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 0 })],
    placements: [
      placement("m-1", "s-1", "2026-10-01", null),
      placement("m-2", "s-2", "2026-11-20", null),
    ],
    settings: NO_TAX,
    goals,
    asOf,
    stores: [
      { id: "s-1", name: "Ica Nära Söder" },
      { id: "s-2", name: "Pressbyrån C" },
    ],
    machines: [{ id: "m-1", name: "Automat 1" }],
    ...extra,
  };
}

const goal = (g: Partial<Goal> & Pick<Goal, "metric" | "target">): Goal => ({
  id: g.id ?? `g-${g.metric}-${g.target}`,
  month: g.month ?? "2026-11",
  scope: g.scope ?? "organization",
  ...g,
});

describe("goalProgress: intäkt och vinst", () => {
  it("snittet hittills × dagar kvar; efter målet", () => {
    const [p] = goalProgress(input([goal({ metric: "revenue", target: 150_000 })]));
    expect(p).toMatchObject({
      actual: 49_000,
      measuredThrough: "2026-11-10",
      elapsedDays: 10,
      daysInMonth: 30,
      remainingDays: 20,
      forecast: 147_000,
      forecastMethod: "run-rate",
      status: "behind",
      gap: -3_000,
      progressBp: 3_267,
      averagePerDay: 4_900,
      // (150 000 − 49 000) / 20 = 5 050
      requiredPerDay: 5_050,
    });
    expect(p!.text).toBe(
      "Intäkt november: 490\u00a0kr av 1\u00a0500\u00a0kr efter 10 av 30 dagar. Prognos 1\u00a0470\u00a0kr, efter med 30\u00a0kr.",
    );
    expect(p!.detail).toBe(
      "Prognosen bygger på snittet hittills, 49\u00a0kr per dag. Behöver 51\u00a0kr per dag resten av månaden.",
    );
  });

  it("i fas när prognosen når målet", () => {
    const [p] = goalProgress(input([goal({ metric: "profit", target: 80_000 })]));
    // 10 × 2 900 = 29 000; prognos 87 000
    expect(p).toMatchObject({ actual: 29_000, forecast: 87_000, status: "on-track" });
    expect(p!.text).toBe(
      "Vinst november: 290\u00a0kr av 800\u00a0kr efter 10 av 30 dagar. Prognos 870\u00a0kr, i fas.",
    );
    expect(p!.detail).not.toContain("Behöver");
  });

  it("för få dagar: snittet de senaste 28 dagarna", () => {
    const [p] = goalProgress(input([goal({ metric: "revenue", target: 150_000 })], "2026-11-03"));
    // 3 × 4 900 + 137 200 × 27 / 28 = 14 700 + 132 300
    expect(p).toMatchObject({ actual: 14_700, forecastMethod: "trailing", forecast: 147_000 });
    expect(p!.detail).toContain("snittet de senaste 28 dagarna");
    expect(p!.evidence.figures.find((f) => f.key === "trailingValue")!.value).toBe(137_200);
  });

  it("avslutad månad: nått eller missat", () => {
    const res = goalProgress(
      input([
        goal({ id: "a", month: "2026-10", metric: "revenue", target: 150_000 }),
        goal({ id: "b", month: "2026-10", metric: "revenue", target: 160_000 }),
      ]),
    );
    expect(res[0]).toMatchObject({ actual: 151_900, forecast: 151_900, forecastMethod: "final", status: "met", remainingDays: 0, requiredPerDay: null });
    expect(res[0]!.text).toBe("Intäkt oktober: 1\u00a0519\u00a0kr av 1\u00a0500\u00a0kr, målet nått (+1\u00a0%).");
    expect(res[1]!.status).toBe("missed");
    expect(res[1]!.text).toBe(
      "Intäkt oktober: 1\u00a0519\u00a0kr av 1\u00a0600\u00a0kr, målet missat med 81\u00a0kr (−5\u00a0%).",
    );
  });

  it("månad som inte har börjat: prognos från de senaste 28 dagarna", () => {
    const [p] = goalProgress(input([goal({ month: "2026-12", metric: "revenue", target: 100_000 })]));
    // 28 order à 4 900 = 137 200 → × 31 / 28 = 151 900
    expect(p).toMatchObject({ actual: 0, measuredThrough: null, elapsedDays: 0, forecast: 151_900, forecastMethod: "trailing", status: "on-track", averagePerDay: null });
    expect(p!.text).toBe(
      "Intäkt december: månaden har inte börjat, mål 1\u00a0000\u00a0kr. Prognos 1\u00a0519\u00a0kr, i fas.",
    );
    expect(p!.evidence.period).toBeNull();
  });

  it("per butik och per automat", () => {
    const res = goalProgress(
      input([
        goal({ id: "s", metric: "revenue", target: 100_000, scope: "store", storeId: "s-2" }),
        goal({ id: "m", metric: "revenue", target: 100_000, scope: "machine", machineId: "m-1" }),
      ]),
    );
    const store = res.find((r) => r.goalId === "s")!;
    const machine = res.find((r) => r.goalId === "m")!;
    expect(store).toMatchObject({ actual: 0, forecast: 0, status: "behind", scopeId: "s-2" });
    expect(store.text).toMatch(/^Intäkt november för Pressbyrån C:/);
    expect(store.evidence.storeIds).toEqual(["s-2"]);
    expect(machine).toMatchObject({ actual: 49_000, forecast: 147_000, status: "on-track" });
    expect(machine.text).toMatch(/^Intäkt november för Automat 1:/);
    expect(machine.evidence.machineIds).toEqual(["m-1"]);
  });

  it("intäkt räknar även order utan inköpspris, vinsten inte", () => {
    const res = goalProgress(
      input([goal({ metric: "revenue", target: 1 }), goal({ metric: "profit", target: 1 })], "2026-11-10", {
        prices: [price("t-a", 2000, "2026-11-06")],
      }),
    );
    expect(res[0]!.actual).toBe(49_000);
    expect(res[1]).toMatchObject({ actual: 5 * 2_900, unpricedOrders: 5 });
    expect(res[1]!.detail).toContain("5\u00a0order utan inköpspris ingår inte i vinsten.");
  });
});

describe("goalProgress: automater i drift", () => {
  it("prognos enligt kända placeringar vid månadens slut", () => {
    const res = goalProgress(
      input([
        goal({ id: "org", metric: "active_machines", target: 2 }),
        goal({ id: "s1", metric: "active_machines", target: 2, scope: "store", storeId: "s-1" }),
      ]),
    );
    const org = res.find((r) => r.goalId === "org")!;
    expect(org).toMatchObject({ actual: 1, forecast: 2, forecastMethod: "placements", status: "on-track", requiredPerDay: null });
    expect(org.text).toBe("Automater i drift november: 1 av 2. Prognos 2 vid månadens slut, i fas.");
    expect(org.evidence.machineIds).toEqual(["m-1", "m-2"]);
    const s1 = res.find((r) => r.goalId === "s1")!;
    expect(s1).toMatchObject({ actual: 1, forecast: 1, status: "behind", gap: -1 });
    expect(s1.text).toContain("efter med 1.");
  });

  it("avslutad månad räknar månadens sista dag", () => {
    const [p] = goalProgress(input([goal({ month: "2026-10", metric: "active_machines", target: 1 })]));
    expect(p).toMatchObject({ actual: 1, status: "met", forecastMethod: "final" });
    expect(p!.detail).toBe("Antal placerade automater 31\u00a0okt.");
  });

  it("activeMachinesOn", () => {
    const pl = [
      placement("m-1", "s-1", "2026-10-01", "2026-10-31"),
      placement("m-1", "s-2", "2026-11-01", null),
      placement("m-2", "s-2", "2026-11-20", null),
    ];
    expect(activeMachinesOn(pl, "2026-10-31")).toEqual(["m-1"]);
    expect(activeMachinesOn(pl, "2026-11-30")).toEqual(["m-1", "m-2"]);
    expect(activeMachinesOn(pl, "2026-10-15", { storeId: "s-2" })).toEqual([]);
    expect(activeMachinesOn(pl, "2026-11-25", { machineId: "m-2" })).toEqual(["m-2"]);
  });
});

describe("goalProgress: indata och ordning", () => {
  it("sorteras på månad, mått, omfattning och id", () => {
    const res = goalProgress(
      input([
        goal({ id: "x", metric: "active_machines", target: 1 }),
        goal({ id: "y", metric: "revenue", target: 1, month: "2026-10" }),
        goal({ id: "z", metric: "profit", target: 1 }),
        goal({ id: "w", metric: "revenue", target: 1 }),
      ]),
    );
    expect(res.map((r) => r.goalId)).toEqual(["y", "w", "z", "x"]);
  });

  it("ogiltiga mål kastar", () => {
    expect(() => goalProgress(input([goal({ metric: "revenue", target: -1 })]))).toThrow(DomainError);
    expect(() => goalProgress(input([goal({ metric: "revenue", target: 1.5 })]))).toThrow(DomainError);
    expect(() => goalProgress(input([goal({ metric: "revenue", target: 1, scope: "store" })]))).toThrow(DomainError);
    expect(() => goalProgress(input([goal({ metric: "revenue", target: 1, month: "2026-13" })]))).toThrow(DomainError);
    expect(() => goalProgress(input([], "2026-11-31"))).toThrow(DomainError);
    expect(() => goalProgress(input([], "2026-11-10", { options: { trailingDays: 0 } }))).toThrow(DomainError);
  });

  it("negativt vinstmål är tillåtet", () => {
    const [p] = goalProgress(input([goal({ metric: "profit", target: -10_000 })]));
    expect(p!.status).toBe("on-track");
  });

  it("prognosen räknar med dagshyra för delmånad", () => {
    const [p] = goalProgress(
      input([goal({ metric: "profit", target: 0 })], "2026-11-10", {
        agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 0, monthlyRentOre: 30_000 })],
      }),
    );
    // Hyra 10/30 × 300 kr = 100 kr → vinst 290 − 100 = 190 kr; prognos × 3 = 570 kr = 870 − 300.
    expect(p).toMatchObject({ actual: 19_000, forecast: 57_000 });
  });
});
