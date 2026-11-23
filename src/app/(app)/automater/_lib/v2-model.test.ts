import { describe, expect, it } from "vitest";

import {
  cityOrderFrom,
  filterCounts,
  filterOf,
  glyphSlotsOf,
  emptyTitleCount,
  groupMachines,
  matchesSearch,
  orderSlots,
  roomFor,
  sinceText,
  sortMachines,
  type AutoMachine,
  type AutoSlot,
} from "./v2-model";

const machine = (over: Partial<AutoMachine> & Pick<AutoMachine, "id" | "code">): AutoMachine => ({
  name: over.code,
  appearance: "stjarnor",
  storeId: null,
  storeName: null,
  city: null,
  address: null,
  phone: null,
  contactName: null,
  lat: null,
  lng: null,
  power: null,
  status: "i-drift",
  statusLabel: "I drift",
  tone: "neutral",
  fillBp: 8_000,
  units: 40,
  capacity: 50,
  emptyChannels: 0,
  daysLeft: 9,
  perDayMilli: 4_000,
  lastRefillAt: null,
  sales30: [],
  powerOffNow: false,
  offlineSince: null,
  slots: [],
  economy: null,
  ...over,
});

const NOW = Date.parse("2026-11-21T12:00:00Z");

describe("Automater V2-modellen", () => {
  const a = machine({
    id: "a",
    code: "BL-001",
    city: "Borås",
    storeName: "Kiosken",
    status: "offline",
  });
  const b = machine({
    id: "b",
    code: "BL-002",
    city: "Göteborg",
    storeName: "Hallen",
    status: "fyll-pa",
    fillBp: 2_000,
    daysLeft: 1,
    slots: [
      {
        titleId: "t",
        name: "Black Bolt",
        channels: ["A2"],
        units: 0,
        capacity: 10,
        slots: 1,
        empty: 1,
      },
    ],
    economy: {
      profitPerDayOre: 9_500,
      vsMedianOre: -10_000,
      verdict: "weak",
      lossProfitPerDayOre: 2_000,
      revenueOre: null,
      profitOre: null,
    },
  });
  const c = machine({
    id: "c",
    code: "BL-003",
    city: "Borås",
    status: "startklar",
    powerOffNow: true,
  });

  it("filtret ur adressen; Underpresterar bara med ekonomi", () => {
    expect(filterOf("offline", false)).toBe("offline");
    expect(filterOf("under", false)).toBe("alla");
    expect(filterOf("under", true)).toBe("under");
    expect(filterOf("hittepa", true)).toBe("alla");
    expect(filterOf(null, true)).toBe("alla");
  });

  it("räknar chipsen; pengachipset saknas för påfyllaren", () => {
    expect(filterCounts([a, b, c], true)).toEqual({
      alla: 3,
      behover: 2,
      ny: 1,
      offline: 1,
      av: 1,
      under: 1,
    });
    expect(filterCounts([a, b, c], false).under).toBeUndefined();
  });

  it("söker i namn, kod, butik, stad och titlar utan att bry sig om accenter", () => {
    expect(matchesSearch(b, "black")).toBe(true);
    expect(matchesSearch(b, "goteborg hallen")).toBe(true);
    expect(matchesSearch(b, "borås")).toBe(false);
    expect(matchesSearch(a, "")).toBe(true);
  });

  it("sorterar på läge som standard, okända värden sist åt båda håll", () => {
    expect(sortMachines([c, b, a], { key: "s", dir: 1 }, NOW).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const p = sortMachines([a, b, c], { key: "p", dir: -1 }, NOW).map((m) => m.id);
    expect(p[0]).toBe("b");
    expect(sortMachines([a, b, c], { key: "f", dir: 1 }, NOW)[0]!.id).toBe("b");
  });

  it("grupperar per stad i körordning från lagret, annars bokstavsordning", () => {
    const groups = groupMachines([a, b, c], "stad");
    expect(groups.map((g) => [g.label, g.machines.length, g.needFill, g.offline])).toEqual([
      ["Borås", 2, 1, 1],
      ["Göteborg", 1, 1, 0],
    ]);
    expect(groupMachines([a, b, c], "stad", ["Göteborg", "Borås"]).map((g) => g.label)).toEqual([
      "Göteborg",
      "Borås",
    ]);
    expect(groupMachines([a, b], "ingen")).toHaveLength(1);
    // Summan av vinst per dag bara där ekonomin finns.
    expect(groupMachines([b], "butik")[0]!.profitPerDayOre).toBe(9_500);
    expect(groupMachines([a], "butik")[0]!.profitPerDayOre).toBeNull();
  });

  it("städernas körordning från lagrets plats", () => {
    const near = machine({ id: "n", code: "N", city: "Nära", lat: 57.7, lng: 12.0 });
    const far = machine({ id: "f", code: "F", city: "Långt", lat: 59.3, lng: 18.0 });
    expect(cityOrderFrom([far, near], { lat: 57.6, lng: 12.0 })).toEqual(["Nära", "Långt"]);
    expect(cityOrderFrom([far, near], null)).toEqual([]);
  });

  it("senast fylld i dagar, plats kvar och fackordning", () => {
    expect(sinceText(null, NOW, "Europe/Stockholm")).toBe("–");
    expect(sinceText("2026-11-21T08:00:00Z", NOW, "Europe/Stockholm")).toBe("i dag");
    expect(sinceText("2026-11-20T08:00:00Z", NOW, "Europe/Stockholm")).toBe("i går");
    expect(sinceText("2026-11-05T08:00:00Z", NOW, "Europe/Stockholm")).toBe("16 d sen");
    expect(roomFor({ units: 20, capacity: 80 })).toBe(60);
    expect(roomFor({ units: null, capacity: 80 })).toBeNull();
    const slots = orderSlots([
      { titleId: "x", name: "X", channels: ["B10"], units: 1, capacity: 1, slots: 1, empty: 0 },
      { titleId: "y", name: "Y", channels: ["A2"], units: 1, capacity: 1, slots: 1, empty: 0 },
      { titleId: "z", name: "Z", channels: [], units: 1, capacity: null, slots: 1, empty: 0 },
      { titleId: "w", name: "W", channels: ["B2"], units: 1, capacity: 1, slots: 1, empty: 0 },
    ]);
    expect(slots.map((s) => s.titleId)).toEqual(["y", "w", "x", "z"]);
  });
});

describe("glyphSlotsOf", () => {
  const slot = (over: Partial<AutoSlot> & Pick<AutoSlot, "name">): AutoSlot => ({
    titleId: over.name,
    channels: [],
    units: 5,
    capacity: 10,
    slots: 1,
    empty: 0,
    ...over,
  });

  it("ger fyllnad i kanalordning, tomt fack och okänd kapacitet", () => {
    const out = glyphSlotsOf([
      slot({ name: "B", channels: ["B1"], units: 0 }),
      slot({ name: "A", channels: ["A1"], units: 8 }),
      slot({ name: "C", channels: ["C1"], units: 3, capacity: null }),
      slot({ name: "D", channels: ["D1"], units: 4, slots: 2, empty: 1 }),
    ]);
    expect(out).toEqual([
      { title: "A", fill: 0.8, empty: false },
      { title: "B", fill: 0, empty: true },
      { title: "C", fill: null, empty: false },
      { title: "D", fill: 0.4, empty: true },
    ]);
  });

  it("räknar titlar med tomma fack", () => {
    expect(
      emptyTitleCount([
        slot({ name: "A" }),
        slot({ name: "B", units: 0 }),
        slot({ name: "C", empty: 1 }),
      ]),
    ).toBe(2);
  });
});
