/**
 * Runda 2 (R2-9): ALLA sidor ska nämna samma slutdag för samma fack.
 *
 * Sidorna laddar olika mycket historik (Att göra 45 dagar; Lager, Besök, Automater och
 * Mystery ungefär 15). Därför får alla samma karta med veckans form per automat
 * (weekShapesInRequest), och alla räknar slutdagen med samma anrop:
 *
 *   sellOut(i lager, takt de senaste 14 hela dagarna, från i går, automatens veckoform)
 *
 * Testet ger varje sida bara 15 dagars order plus formerna, och kräver samma dag från:
 *   Att göra (computeTodos) · Besöksplanen (Hem, Att göra, Drift → Besök, Lager) ·
 *   Automater (Lager-fliken) · Lager (matrisen) · Mystery ("Packa 1 omgång före …").
 * Automaten säljer mest på helgen, så den dagen är en annan än den det platta snittet ger:
 * en sida som glömmer formen syns direkt.
 */

import { describe, expect, it, vi } from "vitest";

import { sellOut } from "@/analytics/sellout";
import { weekShapes } from "@/analytics/sellout/week-shape";
import { computeTodos } from "@/analytics/todos";
import { input, machine, order, title } from "@/analytics/todos/test-helpers";
import type { AnalyticsOrder } from "@/analytics/todos/types";
import { stockLines } from "@/app/(app)/automater/_lib/model";
import { buildLagerModel } from "@/app/(app)/lager/_lib/model";
import { slotInputs, SLOT_WINDOW_DAYS } from "@/app/(app)/vart-lager/mystery/_lib/model";
import { addDays, dayOfWeek, mysteryBatchesToPack, type IsoDate } from "@/domain";
import type { MasterData, SalesCountRow, StockRow } from "@/server/data/core/types";

import { weeklyVisitPlan } from "./visit-plan";

vi.mock("server-only", () => ({}));

// Torsdag 12 nov. 2026 kl. 10 svensk tid.
const NOW = new Date("2026-11-12T09:00:00Z");
const TODAY = "2026-11-12" as IsoDate;
const AS_OF = "2026-11-11" as IsoDate;
const TZ = "Europe/Stockholm";

/** M1 säljer en vanlig titel, M2 bara ett mystery pack. Samma takt i båda. */
const M1 = "m1";
const M2 = "m2";
const T1 = "t1";
const MP = "mp";

/** Helgen säljer mest: lör 22, tors och fre 14, övriga 5 pack per dag (snitt 10). */
const perDay = (weekday: number) => (weekday === 6 ? 22 : weekday === 4 || weekday === 5 ? 14 : 5);

function history(days: number): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(AS_OF, -d);
    for (let i = 0; i < perDay(dayOfWeek(date)); i++) {
      out.push(order({ titleId: T1, machineId: M1, businessDate: date }));
      out.push(order({ titleId: MP, machineId: M2, businessDate: date }));
    }
  }
  return out;
}

const machines = [machine(M1, "Automat 1"), machine(M2, "Automat 2")];
const titles = [title(T1, "Black Bolt"), title(MP, "Mystery Pack", { mysteryBatchSize: 14 })];
const ON_HAND = 28;
const stock = [
  { machineId: M1, titleId: T1, onHand: ON_HAND },
  { machineId: M2, titleId: MP, onHand: ON_HAND },
];

// Formerna som laddaren ger (28 dagar t.o.m. i går), och det sidorna själva har: 15 dagar.
const shapes = weekShapes(history(45), { asOf: AS_OF, machines });
const recent = history(15);

/** Sålda pack de senaste 14 hela dagarna (det varje sida räknar takten på). */
const soldIn14 = (machineId: string) =>
  recent.filter(
    (o) => o.machineId === machineId && o.businessDate > addDays(AS_OF, -SLOT_WINDOW_DAYS),
  ).length;

/** Facit: samma anrop som alla sidor ska göra. */
const facit = (machineId: string, weekShare: readonly number[] | null) =>
  sellOut({
    onHand: ON_HAND,
    dailyAvg: { units: soldIn14(machineId), days: SLOT_WINDOW_DAYS },
    from: AS_OF,
    weekShare,
  })!.date;

const row = (machineId: string, titleId: string): StockRow => ({
  locationId: `loc-${machineId}`,
  locationName: machineId,
  locationKind: "machine",
  isCentral: false,
  machineId,
  titleId,
  onHand: ON_HAND,
  lastCountedAt: "2026-11-11T08:00:00Z",
  lastEventAt: null,
  lastRestockedAt: "2026-11-11T08:00:00Z",
});

const master: MasterData = {
  titles: [
    { id: T1, name: "Black Bolt", series: null, mergedIntoId: null, archived: false },
    { id: MP, name: "Mystery Pack", series: null, mergedIntoId: null, archived: false },
  ],
  machines: [M1, M2].map((id, i) => ({
    id,
    name: `Automat ${i + 1}`,
    code: `BL-00${i + 1}`,
    serial: null,
    storeId: null,
    isExample: false,
    archived: false,
    activeFrom: null,
    activeTo: null,
  })),
  stores: [],
  placements: [],
};

function salesRows(orders: readonly AnalyticsOrder[]): SalesCountRow[] {
  const byKey = new Map<string, SalesCountRow>();
  for (const o of orders) {
    const k = `${o.businessDate}|${o.titleId}|${o.machineId}`;
    const r = byKey.get(k);
    byKey.set(k, {
      date: o.businessDate,
      titleId: o.titleId,
      machineId: o.machineId,
      units: (r?.units ?? 0) + 1,
    });
  }
  return [...byKey.values()];
}

/** Slutdagen för M1:s vanliga titel på varje sida, med eller utan formerna. */
function everyScreen(weekShares: typeof shapes | null) {
  const opts = weekShares ? { weekShares } : {};
  // Att göra (och Hem, som läser samma punkter).
  const todo = computeTodos(input({ orders: recent, stock, titles, machines }), NOW, opts).find(
    (t) => t.key === `refill:${M1}:${T1}`,
  );
  // Besöksplanen: Hem, Att göra ("Åk till …"), Drift → Besök, Lager och Automater-raden.
  const plan = weeklyVisitPlan({
    orders: recent,
    machines,
    titles,
    stock,
    warehouseStock: null,
    today: TODAY,
    timeZone: TZ,
    now: NOW,
    // Utan former: en tom karta (laddaren hittade ingen), inte "räkna själv".
    weekShares: weekShares ?? new Map(),
  });
  const stops = plan.days.flatMap((d) => d.stops);
  const visit = stops.find((s) => s.machineId === M1)?.packs.find((p) => p.titleId === T1);
  const mysteryStop = stops.find((s) => s.machineId === M2);
  // Automater → en automat → Lager-fliken.
  const [line] = stockLines({
    machine: { id: M1, activeFrom: null },
    rows: [row(M1, T1)],
    recentOrders: recent,
    refill: [],
    master,
    today: TODAY,
    weekShare: weekShares?.get(M1) ?? null,
  });
  // Lager (matrisen).
  const lager = buildLagerModel({
    now: NOW,
    timeZone: TZ,
    today: TODAY,
    master,
    stock: [row(M1, T1), row(M2, MP)],
    sales: salesRows(recent),
    scope: { storeId: null, machineId: null },
    hasCentral: false,
    weekShares,
  });
  const cell = lager.cells.flat().find((c) => c.machineId === M1 && c.titleId === T1);
  // Mystery: dagen facket står tomt, och dagen omgången ska vara packad före.
  const slots = slotInputs(
    [{ machineId: M2, label: "BL-002", onHand: ON_HAND, sold: soldIn14(M2), everSold: true }],
    TODAY,
    (id) => weekShares?.get(id),
  );
  const pack = mysteryBatchesToPack({ batchSize: 14, planPacks: 0, slots, today: TODAY });
  return { todo, visit, mysteryStop, line, cell, slots, pack };
}

describe("samma slutdag på alla sidor (R2-9)", () => {
  it("automaten har en veckoform, och den ger en annan dag än det platta snittet", () => {
    expect(shapes.has(M1)).toBe(true);
    expect(shapes.has(M2)).toBe(true);
    // 28 pack en torsdag: tors 14 + fre 14 = slut fredag. Snittet (10 om dagen) säger lördag.
    expect(facit(M1, shapes.get(M1)!)).toBe("2026-11-13");
    expect(facit(M1, null)).toBe("2026-11-14");
  });

  it("med formerna: Att göra, besöksplanen, Automater och Lager säger fredag 13 nov.", () => {
    const day = facit(M1, shapes.get(M1)!);
    const s = everyScreen(shapes);
    // Att göra: "Tar slut i morgon" (i dag är torsdag 12) och raden om veckodagarna.
    expect(s.todo).toBeDefined();
    expect(s.todo!.detail).toContain("Tar slut i morgon – fyll på i dag.");
    expect(s.todo!.detail).toContain("Räknat med vilka veckodagar automaten säljer mest.");
    expect(s.visit?.stockoutDate).toBe(day);
    expect(s.line?.stockoutDate).toBe(day);
    expect(s.cell?.stockoutDate).toBe(day);
    // Samma antal dagar kvar på Automater och Lager.
    expect(s.line?.daysLeft).toBe(s.cell?.daysLeft);
  });

  it("mystery: 'tomt' är dagen efter slutdagen, samma dag som besöket i planen", () => {
    const day = facit(M2, shapes.get(M2)!);
    const s = everyScreen(shapes);
    // Facket säljer slut fredag 13 och står tomt lördag 14: då fylls det, med en hel omgång.
    expect(s.slots[0]?.emptyOn).toBe(addDays(day, 1));
    expect(s.pack?.before).toBe("2026-11-14");
    // Besöksplanen: mystery-automaten ska besökas den dagen ("Åk till BL-002 senast lördag").
    expect(s.mysteryStop?.needBy).toBe(s.pack?.before);
  });

  it("utan formerna: alla sidor faller tillbaka på samma platta dag (lördag 14 nov.)", () => {
    const day = facit(M1, null);
    const s = everyScreen(null);
    expect(s.visit?.stockoutDate).toBe(day);
    expect(s.line?.stockoutDate).toBe(day);
    expect(s.cell?.stockoutDate).toBe(day);
    expect(s.slots[0]?.emptyOn).toBe(addDays(facit(M2, null), 1));
    expect(s.mysteryStop?.needBy).toBe(s.slots[0]?.emptyOn);
  });
});
