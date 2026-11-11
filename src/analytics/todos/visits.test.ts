import { describe, expect, it } from "vitest";

import { weeklyVisitPlan } from "@/server/data/visit-plan";

import { computeTodos } from "./index";
import { daily, input, machine, NOW, title, TODAY } from "./test-helpers";
import type { TodoItem } from "./types";
import { countWithVisits, groupVisits, visitTitle, visitWhen } from "./visits";

function refill(machineId: string, titleId: string, p: Partial<TodoItem> = {}): TodoItem {
  return {
    key: `refill:${machineId}:${titleId}`,
    fingerprint: "f",
    kind: "refill",
    level: "soon",
    urgency: 0,
    atStakeOre: 10_000,
    daysLeft: 1,
    title: `Fyll på ${titleId} i ${machineId}`,
    detail: "",
    evidence: {
      rule: "",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [titleId],
      machineIds: [machineId],
      storeIds: [],
      figures: [],
    },
    link: "/lager",
    action: null,
    ...p,
  } as TodoItem;
}

function other(key: string, level: TodoItem["level"] = "soon"): TodoItem {
  return { ...refill("x", "y"), key, kind: "missing-price", level, atStakeOre: null } as TodoItem;
}

describe("groupVisits", () => {
  it("6 påfyllningar i 2 automater blir 2 besök med summerade pack och kronor", () => {
    const items = [
      refill("m1", "a", { atStakeOre: 50_040 }),
      refill("m2", "a", { atStakeOre: 20_000 }),
      refill("m1", "b", { atStakeOre: 30_000 }),
      refill("m1", "c", { atStakeOre: 149_960 }),
      refill("m2", "b", { atStakeOre: 10_000 }),
      refill("m2", "c", { atStakeOre: null }),
    ];
    const plan = {
      days: [
        {
          date: "2026-11-05",
          stops: [
            { machineId: "m1", needBy: "2026-11-05", late: false, totalPacks: 38 },
            { machineId: "m2", needBy: "2026-11-06", late: false, totalPacks: 12 },
          ],
        },
      ],
    } as const;
    const rows = groupVisits(items, plan);
    expect(rows.map((r) => r.type)).toEqual(["visit", "visit"]);
    const [v1, v2] = rows.map((r) => (r.type === "visit" ? r.visit : null));
    expect(v1).toMatchObject({
      key: "visit:m1",
      needBy: "2026-11-05",
      packs: 38,
      atStakeOre: 230_000,
    });
    expect(v1?.items.map((t) => t.key)).toEqual(["refill:m1:a", "refill:m1:b", "refill:m1:c"]);
    expect(v2).toMatchObject({ needBy: "2026-11-06", packs: 12, atStakeOre: 30_000 });
    expect(countWithVisits(items)).toBe(2);
  });

  it("packen gäller titlarna i besöket, inte allt planen fyller upp i samma automat", () => {
    // Seedens BL-001: en titel är slut (6 pack), planen fyller också upp två andra (3 + 2).
    // Raden säger "1 titel · 6 pack", som Fyll på ("Du fyller på 6 pack"), inte 11.
    const plan = {
      days: [
        {
          date: TODAY,
          stops: [
            {
              machineId: "m1",
              needBy: TODAY,
              late: false,
              totalPacks: 11,
              packs: [
                { titleId: "a", quantity: 6 },
                { titleId: "b", quantity: 3 },
                { titleId: "c", quantity: 2 },
              ],
            },
          ],
        },
      ],
    } as const;
    const one = groupVisits([refill("m1", "a")], plan, TODAY)[0];
    expect(one).toMatchObject({ type: "visit", visit: { packs: 6 } });
    const two = groupVisits([refill("m1", "a"), refill("m1", "c")], plan, TODAY)[0];
    expect(two).toMatchObject({ type: "visit", visit: { packs: 8 } });
    // Titeln finns inte i packlistan (vårt lager är tomt): inga pack på raden.
    const none = groupVisits([refill("m1", "x")], plan, TODAY)[0];
    expect(none).toMatchObject({ type: "visit", visit: { packs: 0 } });
  });

  it("andra sorter står kvar som egna rader, i samma ordning", () => {
    const items = [other("p1", "now"), refill("m1", "a"), other("p2"), refill("m1", "b")];
    const rows = groupVisits(items, null);
    expect(rows.map((r) => (r.type === "visit" ? r.visit.key : r.item.key))).toEqual([
      "p1",
      "visit:m1",
      "p2",
    ]);
    expect(countWithVisits(items)).toBe(3);
  });

  it("besöket tar sin mest brådskande punkts nivå och går före det som är mindre brådskande", () => {
    const items = [other("p1", "soon"), refill("m1", "a", { level: "soon" }), other("p2", "soon")];
    const withNow = [...items, refill("m1", "b", { level: "now" })];
    const rows = groupVisits(withNow, null);
    expect(rows[0]).toMatchObject({ type: "visit", visit: { level: "now" } });
    expect(rows.slice(1).map((r) => (r.type === "todo" ? r.item.key : ""))).toEqual(["p1", "p2"]);
  });

  it("utan stopp i planen: ingen dag och inga pack", () => {
    const [row] = groupVisits([refill("m1", "a")], { days: [] });
    expect(row).toMatchObject({ type: "visit", visit: { needBy: null, packs: null } });
  });
});

describe("groupVisits och planens dag", () => {
  it("planen säger i dag: besöket gäller nu, fast punkterna säger snart", () => {
    const plan = {
      days: [
        { date: TODAY, stops: [{ machineId: "m1", needBy: TODAY, late: false, totalPacks: 5 }] },
      ],
    } as const;
    expect(groupVisits([refill("m1", "a")], plan, TODAY)[0]).toMatchObject({
      visit: { level: "now" },
    });
    expect(groupVisits([refill("m1", "a")], plan)[0]).toMatchObject({ visit: { level: "soon" } });
  });
  it("utan besök den här veckan: planens senare dag, utan packlista", () => {
    const plan = { days: [], notNeeded: [{ machineId: "m1", needBy: "2026-11-12" }] } as const;
    expect(groupVisits([refill("m1", "a")], plan, TODAY)[0]).toMatchObject({
      visit: { needBy: "2026-11-12", packs: null, level: "soon" },
    });
  });
});

describe("visitWhen och visitTitle", () => {
  const v = (needBy: string | null, level: TodoItem["level"] = "soon") => ({ needBy, level });
  it("säger dagen i ord", () => {
    // 2 nov. 2026 är en måndag.
    expect(visitWhen(v("2026-11-02"), TODAY)).toBe("i dag");
    expect(visitWhen(v("2026-10-31"), TODAY)).toBe("i dag");
    expect(visitWhen(v("2026-11-03"), TODAY)).toBe("senast i morgon");
    expect(visitWhen(v("2026-11-05"), TODAY)).toBe("senast torsdag");
    expect(visitWhen(v("2026-11-08"), TODAY)).toBe("senast söndag");
    expect(visitWhen(v("2026-11-09"), TODAY)).toBe("senast 9 nov.");
  });
  it("utan dag: i dag när något är slut, annars snart", () => {
    expect(visitWhen(v(null, "now"), TODAY)).toBe("i dag");
    expect(visitWhen(v(null, "soon"), TODAY)).toBe("snart");
  });
  it("ett besök som gäller nu säger i dag, också när planens dag är senare", () => {
    // Raden står under "I dag" (t.ex. under larmgränsen): den får inte säga "senast torsdag".
    expect(visitWhen(v("2026-11-05", "now"), TODAY)).toBe("i dag");
    expect(visitWhen(v("2026-11-03", "now"), TODAY)).toBe("i dag");
  });
  it("Åk till BL-003 senast torsdag", () => {
    expect(visitTitle(v("2026-11-05"), "BL-003", TODAY)).toBe("Åk till BL-003 senast torsdag");
  });
});

describe("Besöket i Att göra och besöksplanen säger samma dag", () => {
  it("dagen är besöksplanens needBy för automaten", () => {
    // Två automater, tre titlar var som snart tar slut (1 pack per dag, 2 pack kvar).
    const machines = [machine("m1", "Automat 1"), machine("m2", "Automat 2")];
    const titles = [title("a", "A"), title("b", "B"), title("c", "C")];
    const orders = machines.flatMap((m) =>
      titles.flatMap((t) => daily(t.id, m.id, "2026-10-19", 14, 1)),
    );
    const stock = machines.flatMap((m) =>
      titles.map((t) => ({ machineId: m.id, titleId: t.id, onHand: 2 })),
    );
    const todos = computeTodos(input({ orders, titles, machines, stock }), NOW);
    expect(todos.filter((t) => t.kind === "refill")).toHaveLength(6);
    const plan = weeklyVisitPlan({
      orders,
      machines,
      titles,
      stock,
      warehouseStock: null,
      today: TODAY,
      timeZone: "Europe/Stockholm",
      now: new Date(NOW),
    });
    const visits = groupVisits(todos, plan).flatMap((r) => (r.type === "visit" ? [r.visit] : []));
    expect(visits).toHaveLength(2);
    const stops = plan.days.flatMap((d) => d.stops);
    for (const v of visits) {
      const stop = stops.find((s) => s.machineId === v.machineId);
      expect(stop).toBeDefined();
      expect(v.needBy).toBe(stop?.needBy);
      expect(v.packs).toBe(stop?.totalPacks);
      expect(v.items).toHaveLength(3);
    }
  });
});
