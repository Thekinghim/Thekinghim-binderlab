import { describe, expect, it } from "vitest";

import type { GoalProgress } from "@/analytics/goals";

import { homeGoals } from "./goals";

function goal(p: Partial<GoalProgress> & Pick<GoalProgress, "goalId">): GoalProgress {
  return {
    month: "2026-11",
    metric: "revenue",
    scope: "organization",
    scopeId: null,
    target: 100_000,
    actual: 25_000,
    measuredThrough: "2026-11-03",
    elapsedDays: 3,
    daysInMonth: 30,
    remainingDays: 27,
    forecast: 120_000,
    forecastMethod: "trailing",
    status: "on-track",
    gap: 20_000,
    progressBp: 2_500,
    averagePerDay: 8_333,
    requiredPerDay: 2_778,
    unpricedOrders: 0,
    text: "",
    detail: "",
    evidence: {} as GoalProgress["evidence"],
    ...p,
  };
}

const NAMES = {
  stores: [
    { id: "s1", name: "Sega gubben" },
    { id: "s2", name: "Hörnet" },
  ],
  machines: [
    { id: "m1", name: "Kassan" },
    { id: "m2", name: "Entrén" },
  ],
};

const ALL = [
  goal({ goalId: "g-m1", scope: "machine", scopeId: "m1" }),
  goal({ goalId: "g-s2", scope: "store", scopeId: "s2", metric: "profit" }),
  goal({ goalId: "g-act", metric: "active_machines", target: 10, actual: 8, forecast: 9 }),
  goal({ goalId: "g-s1", scope: "store", scopeId: "s1" }),
  goal({ goalId: "g-prof", metric: "profit" }),
  goal({ goalId: "g-rev" }),
  goal({ goalId: "g-okt", month: "2026-10" }),
];

const ids = (gs: { id: string }[]) => gs.map((g) => g.id);

describe("homeGoals", () => {
  it("utan filter: organisationens mål först efter mått, högst tre", () => {
    expect(ids(homeGoals(ALL, { month: "2026-11" }, NAMES))).toEqual(["g-rev", "g-prof", "g-act"]);
  });

  it("filtrerar på månaden", () => {
    const r = homeGoals(ALL, { month: "2026-10" }, NAMES);
    expect(ids(r)).toEqual(["g-okt"]);
    expect(homeGoals(ALL, { month: "2026-12" }, NAMES)).toEqual([]);
  });

  it("butiksfilter: organisationen och butiken, inte andra butiker eller automater", () => {
    const only = ALL.filter((g) => g.scope !== "organization");
    const r = homeGoals(only, { month: "2026-11", storeId: "s1" }, NAMES);
    expect(ids(r)).toEqual(["g-s1"]);
    expect(r[0]?.scopeName).toBe("Sega gubben");
    expect(ids(homeGoals(ALL, { month: "2026-11", storeId: "s1" }, NAMES))).toEqual([
      "g-rev",
      "g-prof",
      "g-act",
    ]);
  });

  it("automatfilter: organisationen, automaten och dess butik", () => {
    const only = ALL.filter((g) => g.scope !== "organization");
    const r = homeGoals(only, { month: "2026-11", machineId: "m1", machineStoreId: "s1" }, NAMES);
    expect(ids(r)).toEqual(["g-s1", "g-m1"]);
    expect(r.map((g) => g.scopeName)).toEqual(["Sega gubben", "Kassan"]);
    expect(
      ids(homeGoals(only, { month: "2026-11", machineId: "m2", machineStoreId: null }, NAMES)),
    ).toEqual([]);
  });

  it("stapel och prognosmarkering kläms till 0–100 %", () => {
    const [over] = homeGoals(
      [goal({ goalId: "a", actual: 150_000, forecast: 200_000, progressBp: 15_000 })],
      { month: "2026-11" },
    );
    expect(over?.barBp).toBe(10_000);
    expect(over?.forecastBp).toBe(10_000);
    const [neg] = homeGoals([goal({ goalId: "b", metric: "profit", actual: -5_000 })], {
      month: "2026-11",
    });
    expect(neg?.barBp).toBe(0);
    expect(neg?.unit).toBe("ore");
  });

  it("kräver/dag visas bara för belopp med behov > 0 i en pågående månad", () => {
    const r = homeGoals(
      [
        goal({ goalId: "1-act", metric: "active_machines", requiredPerDay: 3 }),
        goal({ goalId: "2-zero", requiredPerDay: 0 }),
        goal({ goalId: "3-null", requiredPerDay: null }),
        goal({ goalId: "4-ok", metric: "profit", requiredPerDay: 500 }),
      ],
      { month: "2026-11" },
    );
    const by = Object.fromEntries(r.map((g) => [g.id, g]));
    expect(r).toHaveLength(3);
    expect(by["4-ok"]?.requiredPerDay).toBe(500);
    expect(by["2-zero"]?.requiredPerDay).toBeNull();
    expect(by["3-null"]?.requiredPerDay).toBeNull();
    const [act] = homeGoals([goal({ goalId: "x", metric: "active_machines", requiredPerDay: 3 })], {
      month: "2026-11",
    });
    expect(act?.requiredPerDay).toBeNull();
    expect(act?.unit).toBe("count");
    expect(act?.label).toBe("Automater i drift");
  });

  it("avslutad månad: ingen prognosmarkering och inget behov", () => {
    const [g] = homeGoals(
      [goal({ goalId: "m", status: "missed", remainingDays: 0, requiredPerDay: 100 })],
      { month: "2026-11" },
    );
    expect(g?.forecastBp).toBeNull();
    expect(g?.requiredPerDay).toBeNull();
    expect(g?.status).toBe("missed");
  });
});
