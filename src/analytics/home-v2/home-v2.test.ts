import { describe, expect, it } from "vitest";

import type { TodoItem } from "@/analytics/todos";

import {
  blockText,
  changeBp,
  hemActions,
  hemTodos,
  kpiDeltaBp,
  machineDays,
  peakText,
  perStep,
  profitByCity,
  profitPerMachineDayOre,
  titleTrendBp,
  whenGrid,
  whenLevel,
  type ActionMachineInput,
} from "./index";

const machine = (
  over: Partial<ActionMachineInput> & { id: string; code: string },
): ActionMachineInput => ({
  name: `Automat ${over.code}`,
  status: "i-drift",
  statusLabel: "I drift",
  fill: { units: 50, capacity: 100, fillBp: 5_000, emptyChannels: 0 },
  daysLeft: 10,
  offlineSince: null,
  powerOffNow: false,
  store: { name: "Butik", city: "Stad", phone: null, contactName: null, power: null },
  economy: { lossProfitPerDayOre: 0 },
  ...over,
});

describe("hemActions", () => {
  const machines = [
    machine({
      id: "a",
      code: "BL-001",
      status: "fyll-pa",
      statusLabel: "Fyll på i dag",
      economy: { lossProfitPerDayOre: 12_000 },
    }),
    machine({
      id: "b",
      code: "BL-002",
      status: "offline",
      statusLabel: "Offline",
      economy: { lossProfitPerDayOre: 38_000 },
    }),
    machine({
      id: "c",
      code: "BL-003",
      status: "tom",
      statusLabel: "Tom",
      fill: { units: 0, capacity: 80, fillBp: 0, emptyChannels: 8 },
      economy: { lossProfitPerDayOre: 24_000 },
    }),
    machine({
      id: "d",
      code: "BL-004",
      status: "strom-av",
      statusLabel: "Ström av",
      store: {
        name: "B",
        city: null,
        phone: null,
        contactName: null,
        power: { off: "21:00", on: "08:00" },
      },
    }),
    machine({
      id: "e",
      code: "BL-005",
      status: "tom-snart",
      statusLabel: "Tom om 2 d",
      daysLeft: 2,
    }),
    machine({ id: "f", code: "BL-006" }),
  ];
  const prices = [
    {
      titleId: "t1",
      name: "Titel",
      salePriceOre: 18_000,
      unitCostOre: 18_000,
      profitOre: -3_600,
      suggestedPriceOre: 25_900,
      lossOre: 63_000,
    },
  ];

  it("ekonomi: störst förlorad vinst först, prisrader med, lugna raden och dagens rad", () => {
    const r = hemActions({ machines, prices, economy: true, routePacks: new Map([["c", 70]]) });
    expect(r.rows.map((x) => x.key)).toEqual(["p:t1", "m:b", "m:c", "m:a"]);
    expect(r.rows.find((x) => x.key === "m:c")?.packs).toBe(70);
    expect(r.rows.find((x) => x.key === "m:a")?.packs).toBe(50);
    expect(r.rows.find((x) => x.key === "m:b")?.lossOre).toBe(38_000);
    expect(r.counts).toEqual({ refill: 2, offline: 1, startklar: 0, badPricing: 1 });
    expect(r.calm).toEqual({
      running: 2,
      powerOff: 1,
      powerOnAt: "08:00",
      powerWindow: "21:00–08:00",
    });
    expect(r.total).toBe(4);
  });

  it("påfyllaren: samma automater efter brådska, inga kronor och inga prisrader", () => {
    const r = hemActions({ machines, prices, economy: false });
    expect(r.rows.map((x) => x.key)).toEqual(["m:b", "m:c", "m:a"]);
    expect(JSON.stringify(r)).not.toMatch(/lossOre|"price":\{|Ore"/);
    expect(r.counts.badPricing).toBe(0);
  });

  it("förlust under 5 kr visas inte", () => {
    const r = hemActions({
      machines: [
        machine({ id: "x", code: "X", status: "fyll-pa", economy: { lossProfitPerDayOre: 400 } }),
      ],
      economy: true,
    });
    expect(r.rows[0]?.lossOre).toBeUndefined();
  });
});

const todo = (over: Partial<TodoItem> & { key: string; kind: TodoItem["kind"] }): TodoItem => ({
  fingerprint: "f",
  level: "soon",
  urgency: 0,
  atStakeOre: null,
  daysLeft: null,
  title: `Punkt ${over.key}`,
  detail: "",
  evidence: { titleIds: [], machineIds: [], storeIds: [], recipientIds: [], figures: [] } as never,
  link: "/att-gora",
  ...over,
});

describe("hemTodos", () => {
  it("tar bort automatpunkter, slår ihop utbetalningar och sätter brist för rutten först", () => {
    const r = hemTodos({
      items: [
        todo({ key: "r", kind: "refill", level: "now" }),
        todo({ key: "s1", kind: "settlement", level: "now", title: "Betala Butik A 1 200 kr." }),
        todo({ key: "s2", kind: "settlement-create" }),
        todo({ key: "c", kind: "contract", level: "later" }),
        todo({ key: "pa", kind: "price-advice" }),
        todo({
          key: "al",
          kind: "alert",
          evidence: {
            titleIds: [],
            machineIds: ["m"],
            storeIds: [],
            recipientIds: [],
            figures: [],
          } as never,
        }),
      ],
      short: [{ titleId: "t", titleName: "Mystery Pack", shortBy: 6, own: true }],
      economy: true,
    });
    expect(r.rows.map((x) => x.key)).toEqual(["short:t", "payouts", "c"]);
    expect(r.rows[0]?.verb).toBe("Packa");
    expect(r.rows[1]?.title).toBe("Utbetalningar till butikerna: 2 st.");
  });

  it("utan ekonomi försvinner kronbelopp ur texten", () => {
    const r = hemTodos({
      items: [todo({ key: "s1", kind: "settlement", title: "Betala Butik A 1 200 kr." })],
      economy: false,
    });
    expect(r.rows[0]?.title).not.toMatch(/kr/);
  });
});

describe("KPI-hjälpare", () => {
  it("automatdagar räknar bara dagar i drift", () => {
    const ms = [
      { id: "a", name: "A", activeFrom: "2026-11-01", activeTo: null, archived: false },
      { id: "b", name: "B", activeFrom: "2026-11-05", activeTo: "2026-11-06", archived: false },
      { id: "c", name: "C", activeFrom: null, activeTo: null, archived: true },
    ] as never;
    expect(machineDays(ms, { start: "2026-11-01", end: "2026-11-10" })).toBe(12);
    expect(profitPerMachineDayOre(120_000, 12)).toBe(10_000);
    expect(profitPerMachineDayOre(null, 12)).toBeNull();
    expect(profitPerMachineDayOre(5, 0)).toBeNull();
  });

  it("förändring och märkenas bp", () => {
    expect(changeBp(118, 100)).toBe(1_800);
    expect(changeBp(1, 0)).toBeNull();
    expect(kpiDeltaBp(0.18, "relative")).toBe(1_800);
    expect(kpiDeltaBp(0.6, "absolute")).toBe(60);
    expect(kpiDeltaBp(null, "relative")).toBeNull();
    expect(perStep([0, 100, 100, 250])).toEqual([0, 100, 0, 150]);
    expect(titleTrendBp(14, 30, 30)).toBe(10_000);
    expect(titleTrendBp(7, 30, 30)).toBe(0);
    expect(titleTrendBp(0, 0, 30)).toBeNull();
  });

  it("vinst per stad: grupperar, sorterar och räknar andel", () => {
    const r = profitByCity([
      { machineId: "a", city: "Borås", profitOre: 100, revenueOre: 300 },
      { machineId: "b", city: "Borås", profitOre: 200, revenueOre: 300 },
      { machineId: "c", city: null, profitOre: 300, revenueOre: 300 },
    ]);
    expect(r.map((x) => [x.city, x.machines, x.profitOre, x.shareBp, x.perMachineOre])).toEqual([
      ["Borås", 2, 300, 5_000, 150],
      ["Utan stad", 1, 300, 5_000, 300],
    ]);
  });
});

describe("whenGrid", () => {
  it("veckodag × tvåtimmarsblock i tidszonen, per vecka och bästa blocket", () => {
    // Lördag 21 nov 2026 kl. 17:30 svensk tid (16:30 UTC) ×2, måndag 08:10.
    const g = whenGrid(
      [
        { orderedAt: "2026-11-21T16:30:00Z" },
        { orderedAt: "2026-11-21T16:45:00Z" },
        { orderedAt: "2026-11-16T07:10:00Z" },
        { orderedAt: null },
        { orderedAt: "inte ett datum" },
      ],
      "Europe/Stockholm",
      14,
    );
    expect(g.total).toBe(3);
    expect(g.cells[5]?.[8]).toBe(2);
    expect(g.cells[0]?.[4]).toBe(1);
    expect(g.perWeekTenths[5]).toBe(10);
    expect(g.peak).toEqual({ weekday: 5, block: 8, perWeekTenths: 10 });
    expect(peakText(g.peak!)).toBe("lördagar 16–18");
    expect(g.levels[5]?.[8]).toBe(5);
    expect(blockText(11)).toBe("22–24");
    expect(whenLevel(0, 10)).toBe(0);
    expect(whenLevel(1, 10)).toBe(1);
  });
});
