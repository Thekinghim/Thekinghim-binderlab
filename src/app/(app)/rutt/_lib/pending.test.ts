import { describe, expect, it } from "vitest";

import type { RouteStop } from "@/server/data/v2/types";

import { addInFlight, leavesToday, visibleRoute } from "./pending";

const stop = (machineId: string, over: Partial<RouteStop> = {}): RouteStop =>
  ({
    machineId,
    code: machineId.toUpperCase(),
    name: `Automat ${machineId}`,
    sequence: 1,
    store: null,
    status: null,
    statusLabel: null,
    packs: 4,
    lines: [],
    reasons: [],
    done: false,
    lossProfitPerDayOre: null,
    kind: "fill",
    emptySlots: 0,
    daysLeft: null,
    late: false,
    added: false,
    power: null,
    ...over,
  }) as RouteStop;

const route = {
  stops: [stop("a"), stop("b", { packs: 6 }), stop("c", { kind: "check", packs: 0 })],
  groups: [
    { city: "Stad 1", machineIds: ["a", "b"], packs: 10 },
    { city: "Stad 2", machineIds: ["c"], packs: 0 },
  ],
};

describe("Rutt utan väntan (useOptimistic)", () => {
  it("lägger till ett tryck utan att ändra de andra", () => {
    const s = addInFlight(addInFlight({}, { key: "a", kind: "skip" }), { key: "x", kind: "undo" });
    expect(s).toEqual({ a: "skip", x: "undo" });
    expect(leavesToday(s, "a")).toBe(true);
    expect(leavesToday(s, "x")).toBe(false);
    expect(leavesToday({ a: "add" }, "a")).toBe(false);
  });

  it("utan tryck är rutten som servern skickade", () => {
    const v = visibleRoute(route, {});
    expect(v.stops.map((s) => s.machineId)).toEqual(["a", "b", "c"]);
    expect(v.groups).toEqual(route.groups);
    expect(v.remaining).toHaveLength(3);
    expect(v.removedNow).toBe(false);
  });

  it("Hoppa över och Till i morgon tar bort stoppet direkt, och räknar om gruppen", () => {
    const v = visibleRoute(route, { a: "skip" });
    expect(v.stops.map((s) => s.machineId)).toEqual(["b", "c"]);
    expect(v.groups[0]).toEqual({ city: "Stad 1", machineIds: ["b"], packs: 6 });
    expect(v.removedNow).toBe(true);

    const w = visibleRoute(route, { c: "later" });
    expect(w.groups.map((g) => g.city)).toEqual(["Stad 1"]);
  });

  it("ett kollat offline-stopp räknas som klart (men står kvar i listan)", () => {
    const v = visibleRoute(route, {}, new Set(["c", "a"]));
    expect(v.stops).toHaveLength(3);
    // Bara offline-stopp kan bockas av i telefonen: ett påfyllnadsstopp är klart först i databasen.
    expect(v.remaining.map((s) => s.machineId)).toEqual(["a", "b"]);
  });
});
