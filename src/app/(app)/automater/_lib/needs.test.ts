/**
 * Runda 2, T6-4 och T6-5: kronor på raderna i "Behöver dig" (dyrast först, samma belopp som
 * Att göra) och "Fyll på senast torsdag." ur besöksplanen.
 */

import { describe, expect, it } from "vitest";

import { computeTodos, type AnalyticsOrder, type TodoItem } from "@/analytics/todos";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import type { DomainInput, MasterData, StockSnapshot } from "@/server/data/core/types";
import { weeklyVisitPlan } from "@/server/data/visit-plan";

import { stakeOf } from "../../att-gora/_lib/model";
import {
  buildOverview,
  machineNeeds,
  machineSignals,
  machineStake,
  needsHeadline,
  needsStake,
  refillByDates,
  stockLines,
} from "./model";
import { refillByText } from "./refill-text";
import type { MachineListRow } from "./types";

const TZ = "Europe/Stockholm";
const plain = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ");

const status = (s: string, label: string, flagged: boolean) =>
  ({ status: s, label, flagged, health: null, reason: `${label}.` }) as MachineListRow["status"];

function row(code: string, st: MachineListRow["status"], atStakeOre: number): MachineListRow {
  return {
    id: code.toLowerCase(),
    code,
    name: `Automat ${code}`,
    href: `/automater/${code.toLowerCase()}`,
    lifecycle: "active",
    storeName: null,
    status: st,
    refillNow: st.label === "Fyll på nu" ? 1 : 0,
    refillSoon: st.label === "Fyll på snart" ? 1 : 0,
    atStakeOre,
  } as unknown as MachineListRow;
}

describe("Behöver dig: kronor på varje rad, dyrast först", () => {
  const now = status("critical", "Fyll på nu", true);
  const soon = status("warning", "Fyll på snart", false);
  const rows = [
    row("BL-1", now, 50_000),
    row("BL-2", now, 170_000),
    row("BL-3", now, 200_000),
    row("BL-4", soon, 900_000),
    row("BL-5", soon, 0),
  ];

  it("inom samma nivå: 2 000, 1 700, 500; en dyrare rad på lägre nivå går inte före", () => {
    const needs = machineNeeds(rows);
    expect(needs.map((n) => [n.code, n.stakeOre / 100])).toEqual([
      ["BL-3", 2_000],
      ["BL-2", 1_700],
      ["BL-1", 500],
      ["BL-4", 9_000],
      ["BL-5", 0],
    ]);
    expect(plain(needs[1]!.stakeText)).toBe("Tappar ca 1 700 kr den här veckan");
    expect(needs[4]!.stakeText).toBeNull();
  });

  it("rubriken har summan av raderna", () => {
    const needs = machineNeeds(rows.slice(0, 3));
    expect(needsStake(needs)).toBe(420_000);
    expect(plain(needsHeadline(needs, 5))).toBe(
      "3 automater behöver dig nu. Ca 4 200 kr står på spel i veckan.",
    );
    expect(plain(needsHeadline(machineNeeds([rows[3]!]), 5))).toBe(
      "1 automat behöver dig snart. Ca 9 000 kr står på spel i veckan.",
    );
    // Rader på båda nivåerna: antalet och beloppet gäller samma automater.
    expect(plain(needsHeadline(machineNeeds(rows), 5))).toBe(
      "3 automater behöver dig nu, 2 snart. Ca 13 200 kr står på spel i veckan.",
    );
    // Inget står på spel: bara första meningen.
    expect(plain(needsHeadline(machineNeeds([rows[4]!]), 5))).toBe("1 automat behöver dig snart.");
  });

  it("utan ekonomi (påfyllaren) visas inga kronor, och ordningen följer koden", () => {
    const needs = machineNeeds(rows, { economy: false });
    expect(needs.every((n) => n.stakeOre === 0 && n.stakeText === null)).toBe(true);
    expect(needs.map((n) => n.code)).toEqual(["BL-1", "BL-2", "BL-3", "BL-4", "BL-5"]);
    expect(plain(needsHeadline(needs, 5))).toBe("3 automater behöver dig nu.");
  });
});

// ---------------------------------------------------------------------------
// Samma indata som Att göra och besöksplanen
// ---------------------------------------------------------------------------

const TODAY: IsoDate = "2026-11-04"; // onsdag
const NOW = new Date("2026-11-04T10:00:00Z");

function machine(id: string, code: string) {
  return {
    id,
    code,
    name: `Automat ${code}`,
    serial: null,
    storeId: "s1",
    activeFrom: "2026-09-01",
    activeTo: null,
    isExample: false,
    archived: false,
  };
}

const master: MasterData = {
  titles: [
    { id: "t1", name: "Black Bolt", series: null, mergedIntoId: null, archived: false },
    { id: "t2", name: "Pokémon 151", series: null, mergedIntoId: null, archived: false },
  ],
  machines: [machine("m1", "BL-001"), machine("m2", "BL-002"), machine("m3", "BL-003")],
  stores: [
    {
      id: "s1",
      name: "Centrum",
      address: null,
      contactName: null,
      email: null,
      phone: null,
      isExample: false,
      archived: false,
    },
  ],
  placements: ["m1", "m2", "m3"].map((machineId, i) => ({
    id: `p${i}`,
    machineId,
    storeId: "s1",
    from: "2026-09-01",
    to: null,
  })),
};

let seq = 0;
/** `perDay` köp per dag de senaste 20 dagarna (t.o.m. i dag). */
function sales(machineId: string, titleId: string, perDay: number, amountOre: number) {
  const out: AnalyticsOrder[] = [];
  for (let d = 0; d < 20; d++) {
    const date = addDays(TODAY, -d);
    for (let i = 0; i < perDay; i++) {
      seq += 1;
      out.push({
        id: `o${seq}`,
        externalId: String(seq),
        titleId,
        machineId,
        businessDate: date,
        amountOre,
        orderedAt: `${date}T${String(8 + i).padStart(2, "0")}:00:00Z`,
      });
    }
  }
  return out;
}

const orders = [
  ...sales("m1", "t1", 3, 19_900), // slut: fyll på nu
  ...sales("m2", "t1", 2, 19_900), // 4 kvar: snart
  ...sales("m2", "t2", 1, 9_900), // 2 kvar: snart
  ...sales("m3", "t1", 1, 19_900), // gott om lager
];
const machineStock = [
  { machineId: "m1", titleId: "t1", onHand: 0 },
  { machineId: "m2", titleId: "t1", onHand: 4 },
  { machineId: "m2", titleId: "t2", onHand: 2 },
  { machineId: "m3", titleId: "t1", onHand: 40 },
];
const settings = { vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1 };
const sources = { prices: [], agreements: [], placements: master.placements, settings };
const period = { start: addDays(TODAY, -19), end: TODAY };
const input: DomainInput = {
  ...master,
  period,
  compare: null,
  scope: { storeId: null, machineId: null },
  current: { ...sources, orders, period },
  previous: null,
  sources,
  investments: [],
  settings,
  diagnostics: { ordersWithoutTitle: 0, ordersWithoutMachine: 0 },
} as unknown as DomainInput;
const stock = { rows: [], machineStock, warehouse: [] } as unknown as StockSnapshot;

function overviewNeeds(options?: Parameters<typeof machineNeeds>[1]) {
  const signals = machineSignals({ recent: input, stock, master, now: NOW, timeZone: TZ });
  const overview = buildOverview({
    input,
    master,
    stock,
    signals,
    lastOrderAt: new Map(),
    today: TODAY,
    scope: { storeId: null, machineId: null },
    coverage: period,
    pendingToday: false,
    query: "",
  });
  return { signals, needs: machineNeeds(overview.rows, options) };
}

/** Att göra-punkterna för samma indata (som machineSignals räknar dem). */
function todosFor(): TodoItem[] {
  return computeTodos(
    {
      ...sources,
      orders,
      titles: master.titles,
      machines: master.machines,
      stores: master.stores,
      stock: machineStock,
      reportRecipients: [],
      reportDeliveries: [],
      options: { timeZone: TZ },
    },
    NOW,
  );
}

describe("samma belopp som Att göra", () => {
  it("summan i rubriken är Att göras summa för påfyllning och stillastående automater", () => {
    const { needs } = overviewNeeds();
    expect(needs.map((n) => [n.code, n.label])).toEqual([
      // Enda titeln är slut: automaten är tom (också det en påfyllning, med kronor).
      ["BL-001", "Tom"],
      ["BL-002", "Fyll på snart"],
    ]);
    const todos = todosFor().filter((t) => t.kind === "refill" || t.kind === "stale-machine");
    expect(todos.length).toBeGreaterThanOrEqual(3);
    expect(needsStake(needs)).toBeGreaterThan(0);
    expect(needsStake(needs)).toBe(stakeOf(todos));
    // Och per automat: raden är summan av automatens punkter.
    const perMachine = machineStake(todos);
    for (const n of needs) expect(n.stakeOre).toBe(perMachine.get(n.id) ?? 0);
  });

  it("punkter utan automat eller av annan sort räknas inte", () => {
    const item = (over: Partial<TodoItem>): TodoItem =>
      ({
        key: "k",
        kind: "refill",
        atStakeOre: 12_345,
        evidence: { machineIds: ["m1"], titleIds: [] },
        ...over,
      }) as unknown as TodoItem;
    const stake = machineStake([
      item({}),
      item({ kind: "stale-machine", atStakeOre: 99_950 }),
      item({ kind: "missing-price", atStakeOre: 500_000 }),
      item({ atStakeOre: null }),
      item({ evidence: { machineIds: [], titleIds: [] } as never }),
    ]);
    // 123,45 kr → 123 kr och 999,50 kr → 1 000 kr (hela kronor per punkt, som Att göra).
    expect([...stake.entries()]).toEqual([["m1", 12_300 + 100_000]]);
  });
});

describe("Fyll på senast torsdag: samma dag som besöksplanen", () => {
  const plan = weeklyVisitPlan({
    orders,
    machines: master.machines.map((m) => ({ ...m, location: null })),
    titles: master.titles,
    stock: machineStock,
    warehouseStock: null,
    health: null,
    slotPeriods: null,
    capacities: null,
    today: TODAY,
    timeZone: TZ,
    now: NOW,
  });
  const stops = plan.days.flatMap((d) => d.stops);

  it("dagen på raden är besökets needBy", () => {
    const refillBy = refillByDates(plan);
    const m2 = stops.find((s) => s.machineId === "m2");
    expect(m2).toBeDefined();
    expect(refillBy.get("m2")).toBe(m2!.needBy);
    // Automaten med gott om lager har inget besök i veckan: ingen dag.
    expect(refillBy.has("m3")).toBe(stops.some((s) => s.machineId === "m3"));

    const { needs } = overviewNeeds({ refillBy, today: TODAY });
    const soon = needs.find((n) => n.code === "BL-002")!;
    expect(soon.refillBy).toBe(refillByText(m2!.needBy, TODAY));
    // Den tomma automaten har ingen dag: den ska fyllas på nu.
    expect(needs.find((n) => n.code === "BL-001")!.refillBy).toBeNull();
  });

  it("texten är en veckodag, i dag eller i morgon", () => {
    expect(refillByText(TODAY, TODAY)).toBe("Fyll på i dag.");
    expect(refillByText(addDays(TODAY, -1), TODAY)).toBe("Fyll på i dag.");
    expect(refillByText(addDays(TODAY, 1), TODAY)).toBe("Fyll på senast i morgon.");
    expect(refillByText("2026-11-06", TODAY)).toBe("Fyll på senast fredag.");
    expect(dayOfWeek("2026-11-07")).toBe(6);
    expect(refillByText("2026-11-07", TODAY)).toBe("Fyll på senast lördag.");
  });
});

describe("stockLines räknar slutdagen med sellOut", () => {
  const args = {
    machine: { id: "m3", activeFrom: "2026-09-01" as IsoDate },
    rows: [
      {
        locationId: "l",
        locationName: "BL-003",
        locationKind: "machine",
        isCentral: false,
        machineId: "m3",
        titleId: "t1",
        onHand: 5,
        lastCountedAt: null,
        lastEventAt: null,
        lastRestockedAt: null,
      },
    ] as never,
    recentOrders: orders,
    refill: [],
    master,
    today: TODAY,
  };

  it("utan veckoform: jämn takt, som förut (5 pack, 1 om dagen från i går = 5 dagar)", () => {
    const [line] = stockLines(args);
    expect(line).toMatchObject({ daysLeft: 5, stockoutDate: addDays(TODAY, 4) });
  });

  it("med veckoform räknar den med helgen", () => {
    // 6 pack, 1 om dagen från i går (tisdag): jämn takt ger måndag. När helgen säljer mest
    // (lördag 2,5 och söndag 2 gånger snittet) är det slut redan på söndag.
    const first = (args.rows as unknown as Record<string, unknown>[])[0]!;
    const six = { ...args, rows: [{ ...first, onHand: 6 }] as never };
    expect(stockLines(six)[0]!.stockoutDate).toBe("2026-11-09");
    const share = [0.5, 0.5, 0.5, 0.5, 0.5, 2.5, 2].map((x) => x / 7);
    expect(stockLines({ ...six, weekShare: share })[0]!.stockoutDate).toBe("2026-11-08");
  });
});
