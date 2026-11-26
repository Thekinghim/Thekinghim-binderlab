/**
 * En regel för "behöver påfyllning" på Automater, Rutt och Fyll på (mobilgenomgången H4):
 * en titel i automaten med 0 pack är slut och ska fyllas på, även när kapaciteten är okänd
 * (ingen Awish-läsning av titeln). Förut sa Fyll på "1 slut" medan Automater sa "I drift"
 * och Rutt inte tog med automaten, eftersom flottans läge bara såg Awish tomma fack och
 * fyllnaden.
 */

import { describe, expect, it } from "vitest";

import { needsFill } from "@/app/(app)/automater/_lib/v2-model";
import { fillMachines, pairKey, type FillInput } from "@/app/fyll-pa/_lib/model";
import type { IsoDate } from "@/domain";

import { buildFleetState, type FleetInput } from "./fleet-model";
import { buildDayRoute, DEFAULT_ROUTE_LIMITS } from "./route-model";

const today = "2026-11-23" as IsoDate; // en måndag, ruttdag
const now = new Date("2026-11-23T10:00:00Z");

function sold(machineId: string, titleId: string, perDay: number, days = 14) {
  const out: { machineId: string; titleId: string; businessDate: IsoDate }[] = [];
  for (let d = 1; d <= days; d++) {
    const date = new Date(Date.UTC(2026, 10, 23 - d)).toISOString().slice(0, 10) as IsoDate;
    for (let i = 0; i < perDay; i++) out.push({ machineId, titleId, businessDate: date });
  }
  return out;
}

/** NA-09: inte läst från Awish. Titel A har 40 pack, titel B är slut (sålde förra veckan). */
const MACHINE = "na9";
const fleetInput = (over: Partial<FleetInput> = {}): FleetInput => ({
  today,
  now,
  timeZone: "Europe/Stockholm",
  machines: [
    { id: MACHINE, code: "NA-09", name: "Nio", storeId: null, activeFrom: null, activeTo: null },
  ],
  stores: new Map(),
  health: new Map(),
  power: new Map(),
  fills: new Map([[MACHINE, null]]),
  stock: [
    { machineId: MACHINE, titleId: "a", onHand: 40 },
    { machineId: MACHINE, titleId: "b", onHand: 0 },
  ],
  sales: [...sold(MACHINE, "a", 1), ...sold(MACHINE, "b", 1, 7)],
  lastRefill: new Map(),
  startklar: new Set(),
  economy: null,
  slotPeriods: [
    { machineId: MACHINE, titleId: "a", validFrom: "2026-01-01" as IsoDate, validTo: null },
    { machineId: MACHINE, titleId: "b", validFrom: "2026-01-01" as IsoDate, validTo: null },
  ],
  ...over,
});

const fillInput = (over: Partial<FillInput> = {}): FillInput => ({
  machines: [
    { id: MACHINE, code: "NA-09", name: "Nio", storeName: null, syncedAt: null, fill: null },
  ],
  titles: new Map([
    ["a", "Titel A"],
    ["b", "Titel B"],
  ]),
  machineStock: new Map([
    [pairKey(MACHINE, "a"), 40],
    [pairKey(MACHINE, "b"), 0],
  ]),
  home: new Map([["b", 20]]),
  current: new Set([pairKey(MACHINE, "a"), pairKey(MACHINE, "b")]),
  retired: new Set(),
  sold: new Map([
    [pairKey(MACHINE, "a"), 14],
    [pairKey(MACHINE, "b"), 7],
  ]),
  ...over,
});

describe("behöver påfyllning: samma svar på Automater, Rutt och Fyll på", () => {
  it("en slut titel utan känd kapacitet: alla tre säger fyll på", () => {
    const [fill] = fillMachines(fillInput());
    expect(fill!.empty).toBe(1);
    expect(fill!.needs).toBe(true);

    const fleet = buildFleetState(fleetInput());
    const m = fleet.machines[0]!;
    expect(m.status).toBe("fyll-pa");
    expect(needsFill(m)).toBe(true);
    expect(m.emptyTitleIds).toEqual(["b"]);

    const route = buildDayRoute({ date: today, day: null, fleet, limits: DEFAULT_ROUTE_LIMITS });
    expect(route.stops.map((s) => s.machineId)).toEqual([MACHINE]);
    expect(route.needing).toBe(1);
  });

  it("titeln har gått ur sortimentet: ingen säger fyll på", () => {
    const retiredPeriods = [
      { machineId: MACHINE, titleId: "a", validFrom: "2026-01-01" as IsoDate, validTo: null },
      {
        machineId: MACHINE,
        titleId: "b",
        validFrom: "2026-01-01" as IsoDate,
        validTo: "2026-11-20" as IsoDate,
      },
    ];
    const [fill] = fillMachines(
      fillInput({
        current: new Set([pairKey(MACHINE, "a")]),
        retired: new Set([pairKey(MACHINE, "b")]),
      }),
    );
    expect(fill!.empty).toBe(0);

    const m = buildFleetState(fleetInput({ slotPeriods: retiredPeriods })).machines[0]!;
    expect(m.status).not.toBe("fyll-pa");
    expect(needsFill(m)).toBe(false);
    expect(m.emptyTitleIds).toEqual([]);
  });

  it("allt har pack: ingen säger slut", () => {
    const stock = [
      { machineId: MACHINE, titleId: "a", onHand: 40 },
      { machineId: MACHINE, titleId: "b", onHand: 30 },
    ];
    const [fill] = fillMachines(
      fillInput({
        machineStock: new Map([
          [pairKey(MACHINE, "a"), 40],
          [pairKey(MACHINE, "b"), 30],
        ]),
      }),
    );
    expect(fill!.empty).toBe(0);
    const m = buildFleetState(fleetInput({ stock })).machines[0]!;
    expect(m.status).toBe("i-drift");
    expect(m.emptyTitleIds).toEqual([]);
  });
});
