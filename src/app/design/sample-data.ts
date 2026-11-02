import type { Status } from "@/components/ui/status-tag";
import { addDays, calendarDaysBetween, type Period as DateRange } from "@/lib/period";
import { seeded } from "@/lib/random";

/**
 * Exempelverksamheten bakom /design: tre automater i tre butiker och ett års
 * Awish-ordrar (en order = ett pack). Allt på sidan räknas fram härifrån med
 * reglerna i docs/berakningar.md: belopp i öre, provision per order, hyra
 * per butik och kalendermånad, och order utan inköpspris hålls utanför
 * vinsten. Deterministiskt, så att server och klient visar samma siffror.
 */

/** Sidans "nu": 2 nov. 2026 14:32, samma tid som senaste synk. */
export const REF_NOW = new Date(2026, 10, 2, 14, 32);
/** Första dagen med ordrar. */
export const FIRST_DAY = new Date(2025, 10, 1);
const TODAY = new Date(2026, 10, 2);
const DAY_COUNT = calendarDaysBetween(FIRST_DAY, TODAY) + 1;

/** Köpcentrens öppettider. Ordrar ligger mellan 10:00 och 19:59. */
export const OPEN_HOUR = 10;
export const CLOSE_HOUR = 20;

/* ------------------------------------------------------------------ */
/* Butiker, automater, titlar                                          */
/* ------------------------------------------------------------------ */

export type Store = {
  id: string;
  name: string;
  city: string;
  /** Provision i baspunkter (1 000 = 10 %) på nettointäkten. */
  commissionBp: number;
  /** Månadshyra i öre. 0 = bara provision. */
  rentOre: number;
};

export const stores: ReadonlyArray<Store> = [
  { id: "s1", name: "Nordstan", city: "Göteborg", commissionBp: 1000, rentOre: 150_000 },
  { id: "s2", name: "Mobilia", city: "Malmö", commissionBp: 1200, rentOre: 0 },
  { id: "s3", name: "Väla Centrum", city: "Helsingborg", commissionBp: 800, rentOre: 120_000 },
];

export type Machine = {
  id: string;
  code: string;
  /** Plats i butiken */
  name: string;
  storeId: string;
  installed: Date;
  /** Antal fack */
  slots: number;
  /** Grundefterfrågan, pack per vardag */
  base: number;
};

export const machines: ReadonlyArray<Machine> = [
  {
    id: "m1",
    code: "BL-001",
    name: "Entré Östra",
    storeId: "s1",
    installed: FIRST_DAY,
    slots: 6,
    base: 17,
  },
  {
    id: "m2",
    code: "BL-002",
    name: "Plan 2",
    storeId: "s2",
    installed: new Date(2026, 0, 10),
    slots: 6,
    base: 13,
  },
  {
    id: "m3",
    code: "BL-003",
    name: "Foodcourt",
    storeId: "s3",
    installed: new Date(2026, 3, 4),
    slots: 6,
    base: 10,
  },
];

export type Title = {
  id: string;
  name: string;
  /** Pris i automaten, öre */
  priceOre: number;
  /** Inköpspris per pack, öre. null = saknas (räknas inte in i vinsten). */
  costOre: number | null;
  weight: number;
  /** Första försäljningsdag */
  from: Date;
};

/** Släppdagen i perioden: Black Bolt kom 24 okt. och har ännu inget inköpspris. */
export const RELEASE_DAY = new Date(2026, 9, 24);

export const titles: ReadonlyArray<Title> = [
  {
    id: "t1",
    name: "30th Celebration",
    priceOre: 5900,
    costOre: 3100,
    weight: 24,
    from: FIRST_DAY,
  },
  { id: "t2", name: "Mystery Pack", priceOre: 4900, costOre: 2100, weight: 22, from: FIRST_DAY },
  { id: "t3", name: "Surging Sparks", priceOre: 5900, costOre: 3000, weight: 15, from: FIRST_DAY },
  { id: "t4", name: "Stellar Crown", priceOre: 4900, costOre: 2500, weight: 11, from: FIRST_DAY },
  {
    id: "t5",
    name: "Prismatic Evolutions",
    priceOre: 7900,
    costOre: 4700,
    weight: 14,
    from: new Date(2026, 0, 17),
  },
  { id: "t6", name: "Black Bolt", priceOre: 6900, costOre: null, weight: 26, from: RELEASE_DAY },
];

export const storeById = new Map(stores.map((s) => [s.id, s]));
export const machineById = new Map(machines.map((m) => [m.id, m]));
export const titleById = new Map(titles.map((t) => [t.id, t]));

/** BL-002 fack 3 (Black Bolt) är tomt sedan 31 okt. 16:40. */
export const EMPTY_SLOT = {
  machineId: "m2",
  slot: 3,
  titleId: "t6",
  since: new Date(2026, 9, 31, 16, 40),
};

/**
 * Alla tomma fack under året: inga köp av titeln i automaten under
 * intervallet. Utan slut = fortfarande tomt. BL-001 fack 3 tömdes efter
 * släppet och fylldes extra morgonen därpå (avvikelse 3 i månadsrapporten).
 */
export const emptySlotEvents: ReadonlyArray<{
  machineId: string;
  slot: number;
  titleId: string;
  from: Date;
  to: Date | null;
}> = [
  {
    machineId: "m2",
    slot: 4,
    titleId: "t3",
    from: new Date(2026, 8, 27, 15, 10),
    to: new Date(2026, 8, 27, 19, 0),
  },
  {
    machineId: "m2",
    slot: 2,
    titleId: "t1",
    from: new Date(2026, 9, 11, 13, 30),
    to: new Date(2026, 9, 11, 18, 5),
  },
  {
    machineId: "m1",
    slot: 3,
    titleId: "t6",
    from: new Date(2026, 9, 29, 16, 40),
    to: new Date(2026, 9, 30, 8, 30),
  },
  { ...EMPTY_SLOT, from: EMPTY_SLOT.since, to: null },
];

/** Driftstopp: automaten kunde inte sälja alls (avvikelse 1 och 2 i månadsrapporten). */
export const outageEvents: ReadonlyArray<{ machineId: string; from: Date; to: Date }> = [
  { machineId: "m1", from: new Date(2026, 9, 12, 14, 5), to: new Date(2026, 9, 12, 15, 17) },
  { machineId: "m1", from: new Date(2026, 9, 21, 18, 22), to: new Date(2026, 9, 21, 19, 0) },
];

/** Nuläge per automat: fyllnad, status och senaste påfyllning. Gränsen för påfyllning är 20 %. */
export const REFILL_THRESHOLD = 0.2;

export type MachineState = {
  machineId: string;
  status: Status;
  statusText: string;
  fill: number;
  emptySlots: number;
  lastRefill: Date;
};

export const machineStates: ReadonlyArray<MachineState> = [
  {
    machineId: "m1",
    status: "ok",
    statusText: "I drift",
    fill: 0.64,
    emptySlots: 0,
    lastRefill: new Date(2026, 9, 30, 8, 35),
  },
  {
    machineId: "m2",
    status: "critical",
    statusText: "Tomt fack 3",
    fill: 0.31,
    emptySlots: 1,
    lastRefill: new Date(2026, 9, 28, 8, 20),
  },
  {
    machineId: "m3",
    status: "warning",
    statusText: "Fyllnad 17 %",
    fill: 0.17,
    emptySlots: 0,
    lastRefill: new Date(2026, 9, 26, 9, 5),
  },
];

/* ------------------------------------------------------------------ */
/* Ordrar                                                              */
/* ------------------------------------------------------------------ */

export type Order = {
  /** Awish Order No. */
  no: number;
  /** Dag från FIRST_DAY (0 = 1 nov. 2025) */
  day: number;
  /** Minut på dygnet */
  minute: number;
  machine: number;
  title: number;
  amountOre: number;
  payment: "Kort" | "Swish";
};

/** Order 42780 betalades 1 nov. 2026 17:17 (verifieringsordern i docs/awish.md). */
export const KNOWN_ORDER = { no: 42_780, day: DAY_COUNT - 2, minute: 17 * 60 + 17 };

const WEEKDAY_HOURS = [3, 5, 7, 6, 6, 7, 9, 10, 8, 5];
const WEEKEND_HOURS = [4, 7, 10, 12, 11, 10, 8, 6, 4, 2];

function pick(weights: ReadonlyArray<number>, r: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += (weights[i] ?? 0) / total;
    if (r <= acc) return i;
  }
  return weights.length - 1;
}

function demandFactor(date: Date): number {
  const dow = date.getDay();
  const week = dow === 6 ? 1.5 : dow === 0 ? 1.25 : dow === 5 ? 1.15 : dow === 1 ? 0.85 : 1;
  const m = date.getMonth();
  const d = date.getDate();
  let season = 1;
  if (m === 11 && d <= 23) season = 1.55;
  else if (m === 11 && (d === 24 || d === 25)) season = 0.3;
  else if (m === 6) season = 0.8;
  const sinceRelease = calendarDaysBetween(RELEASE_DAY, date);
  const release =
    sinceRelease === 0 ? 2.1 : sinceRelease === 1 ? 1.5 : sinceRelease === 2 ? 1.2 : 1;
  return week * season * release;
}

function generate(): Order[] {
  const rnd = seeded(2026);
  const out: Order[] = [];
  for (let day = 0; day < DAY_COUNT; day++) {
    const date = addDays(FIRST_DAY, day);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const hours = weekend ? WEEKEND_HOURS : WEEKDAY_HOURS;
    const isToday = day === DAY_COUNT - 1;
    const lastMinute = isToday ? REF_NOW.getHours() * 60 + REF_NOW.getMinutes() : 24 * 60;
    const dayOrders: Order[] = [];
    machines.forEach((m, mi) => {
      if (calendarDaysBetween(m.installed, date) < 0) return;
      // Första veckan efter installationen: halv efterfrågan.
      const ramp = calendarDaysBetween(m.installed, date) < 7 ? 0.55 : 1;
      const expected = m.base * demandFactor(date) * ramp * (0.82 + rnd() * 0.36);
      const n = Math.round(expected);
      const available = titles
        .map((t, ti) => ({ t, ti }))
        .filter(({ t }) => calendarDaysBetween(t.from, date) >= 0);
      const weights = available.map(({ t }) => {
        // Nya titlar säljer mest de första veckorna.
        const age = calendarDaysBetween(t.from, date);
        return t.weight * (age < 14 && t.from > FIRST_DAY ? 1.6 : 1);
      });
      for (let k = 0; k < n; k++) {
        const hour = OPEN_HOUR + pick(hours, rnd());
        const minute = hour * 60 + Math.floor(rnd() * 60);
        const pickIndex = pick(weights, rnd());
        const choice = available[pickIndex];
        const payR = rnd();
        if (!choice || minute > lastMinute) continue;
        // Tomt fack: inga köp av titeln i automaten medan facket är tomt.
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minute);
        if (outageEvents.some((e) => e.machineId === m.id && at >= e.from && at < e.to)) continue;
        if (
          emptySlotEvents.some(
            (e) =>
              e.machineId === m.id &&
              e.titleId === choice.t.id &&
              at >= e.from &&
              (e.to === null || at < e.to),
          )
        ) {
          continue;
        }
        dayOrders.push({
          no: 0,
          day,
          minute,
          machine: mi,
          title: choice.ti,
          amountOre: choice.t.priceOre,
          payment: payR < 0.81 ? "Kort" : "Swish",
        });
      }
    });
    if (day === KNOWN_ORDER.day && dayOrders[0]) {
      // Verifieringsordern: BL-001, 1 nov. 17:17.
      const o = dayOrders.find((x) => x.machine === 0) ?? dayOrders[0];
      o.minute = KNOWN_ORDER.minute;
    }
    dayOrders.sort((a, b) => a.minute - b.minute || a.machine - b.machine);
    out.push(...dayOrders);
  }
  const known = out.findIndex((o) => o.day === KNOWN_ORDER.day && o.minute === KNOWN_ORDER.minute);
  out.forEach((o, i) => (o.no = KNOWN_ORDER.no - known + i));
  return out;
}

let cache: Order[] | null = null;
/** Alla ordrar, sorterade på tid. Byggs en gång. */
export function allOrders(): ReadonlyArray<Order> {
  if (!cache) cache = generate();
  return cache;
}

export function orderDate(o: Order): Date {
  return new Date(
    FIRST_DAY.getFullYear(),
    FIRST_DAY.getMonth(),
    FIRST_DAY.getDate() + o.day,
    0,
    o.minute,
  );
}

export function dayIndex(d: Date): number {
  return calendarDaysBetween(FIRST_DAY, d);
}

/* ------------------------------------------------------------------ */
/* Urval                                                               */
/* ------------------------------------------------------------------ */

export type Scope = { butik: string | null; automat: string | null };

/** Automaterna som filtret släpper igenom, som index i `machines`. */
export function scopedMachines(scope: Scope): number[] {
  return machines
    .map((m, i) => ({ m, i }))
    .filter(
      ({ m }) =>
        (!scope.automat || m.id === scope.automat) && (!scope.butik || m.storeId === scope.butik),
    )
    .map(({ i }) => i);
}

/** Ordrar i perioden (båda ändar ingår) för givna automater. */
export function ordersIn(range: DateRange, machineIdx: ReadonlyArray<number>): Order[] {
  const all = allOrders();
  const a = dayIndex(range.start);
  const b = dayIndex(range.end);
  const set = new Set(machineIdx);
  // Binärsökning på dag.
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((all[mid]?.day ?? 0) < a) lo = mid + 1;
    else hi = mid;
  }
  const out: Order[] = [];
  for (let i = lo; i < all.length; i++) {
    const o = all[i];
    if (!o || o.day > b) break;
    if (set.has(o.machine)) out.push(o);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lönsamhet enligt docs/berakningar.md                                */
/* ------------------------------------------------------------------ */

export type Totals = {
  orders: number;
  /** Intäkt för alla ordrar, öre */
  revenue: number;
  /** Intäkt för ordrar med inköpspris */
  pricedRevenue: number;
  /** Intäkt för ordrar utan inköpspris (ingår inte i vinsten) */
  unpricedRevenue: number;
  unpricedOrders: number;
  purchases: number;
  fees: number;
  commission: number;
  rent: number;
  storeCompensation: number;
  profit: number;
  /** vinst / prissatt intäkt, null när intäkten är 0 */
  margin: number | null;
};

/** Hyra per butik och kalendermånad för dagarna i perioden, avrundad per butik och månad. */
function rentFor(range: DateRange, machineIdx: ReadonlyArray<number>): number {
  const storeIds = new Set(machineIdx.map((i) => machines[i]?.storeId));
  let total = 0;
  for (const s of stores) {
    if (!storeIds.has(s.id) || !s.rentOre) continue;
    // Avtalet gäller från automatens installation i butiken.
    const m = machines.find((x) => x.storeId === s.id);
    const from = m && m.installed > range.start ? m.installed : range.start;
    if (from > range.end) continue;
    let cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (cursor <= range.end) {
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const last = monthEnd < range.end ? monthEnd : range.end;
      const days = calendarDaysBetween(cursor, last) + 1;
      total += Math.round((s.rentOre * days) / monthEnd.getDate());
      cursor = addDays(last, 1);
    }
  }
  return total;
}

export function totals(
  orders: ReadonlyArray<Order>,
  range: DateRange,
  machineIdx: ReadonlyArray<number>,
): Totals {
  let revenue = 0;
  let pricedRevenue = 0;
  let unpricedRevenue = 0;
  let unpricedOrders = 0;
  let purchases = 0;
  let commission = 0;
  for (const o of orders) {
    const t = titles[o.title];
    const m = machines[o.machine];
    const s = m ? storeById.get(m.storeId) : undefined;
    revenue += o.amountOre;
    if (!t || t.costOre === null) {
      unpricedRevenue += o.amountOre;
      unpricedOrders++;
      continue;
    }
    pricedRevenue += o.amountOre;
    purchases += t.costOre;
    commission += Math.round((o.amountOre * (s?.commissionBp ?? 0)) / 10_000);
  }
  const rent = rentFor(range, machineIdx);
  const fees = 0;
  const storeCompensation = commission + rent;
  const profit = pricedRevenue - purchases - fees - storeCompensation;
  return {
    orders: orders.length,
    revenue,
    pricedRevenue,
    unpricedRevenue,
    unpricedOrders,
    purchases,
    fees,
    commission,
    rent,
    storeCompensation,
    profit,
    margin: pricedRevenue ? profit / pricedRevenue : null,
  };
}

/** Öre till kronor för visning. */
export const kr = (ore: number) => ore / 100;

/* ------------------------------------------------------------------ */
/* Serier                                                              */
/* ------------------------------------------------------------------ */

export function daysOf(range: DateRange): Date[] {
  const n = calendarDaysBetween(range.start, range.end) + 1;
  return Array.from({ length: n }, (_, i) => addDays(range.start, i));
}

/** Intäkt per dag (kr) för perioden. */
export function revenueByDay(orders: ReadonlyArray<Order>, range: DateRange): number[] {
  const a = dayIndex(range.start);
  const n = calendarDaysBetween(range.start, range.end) + 1;
  const out = new Array<number>(n).fill(0);
  for (const o of orders) {
    const i = o.day - a;
    if (i >= 0 && i < n) out[i] = (out[i] ?? 0) + o.amountOre / 100;
  }
  return out;
}

/** Ordrar per veckodag (mån först) och öppettimme. */
export function ordersByHour(orders: ReadonlyArray<Order>): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(CLOSE_HOUR - OPEN_HOUR).fill(0));
  for (const o of orders) {
    const dow = (addDays(FIRST_DAY, o.day).getDay() + 6) % 7;
    const h = Math.floor(o.minute / 60) - OPEN_HOUR;
    const row = grid[dow];
    if (row && h >= 0 && h < row.length) row[h] = (row[h] ?? 0) + 1;
  }
  return grid;
}

export const heatDays = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
export const heatHours = Array.from({ length: CLOSE_HOUR - OPEN_HOUR }, (_, i) =>
  String(OPEN_HOUR + i).padStart(2, "0"),
);

/** Summor per automat (index i `machines`). */
export function byMachine(
  orders: ReadonlyArray<Order>,
  range: DateRange,
  machineIdx: ReadonlyArray<number>,
) {
  return machineIdx.map((i) => {
    const own = orders.filter((o) => o.machine === i);
    return { machine: machines[i] as Machine, index: i, totals: totals(own, range, [i]) };
  });
}

/** Intäkt och antal per titel, störst först. */
export function byTitle(orders: ReadonlyArray<Order>) {
  const rows = titles.map((t) => ({ title: t, orders: 0, revenue: 0 }));
  for (const o of orders) {
    const r = rows[o.title];
    if (!r) continue;
    r.orders++;
    r.revenue += o.amountOre;
  }
  return rows.filter((r) => r.orders > 0).sort((a, b) => b.revenue - a.revenue);
}

/** Antal fack som var tomma någon gång under dagen, per dag i perioden. */
export function emptySlotsByDay(range: DateRange, machineIdx: ReadonlyArray<number>): number[] {
  const ids = new Set(machineIdx.map((i) => machines[i]?.id));
  const events = emptySlotEvents.filter((e) => ids.has(e.machineId));
  return daysOf(range).map((d) => {
    const end = addDays(d, 1);
    return events.filter((e) => e.from < end && (e.to === null || e.to > d)).length;
  });
}

/* ------------------------------------------------------------------ */
/* Skalets listor                                                      */
/* ------------------------------------------------------------------ */

export const shellStores = stores.map((s) => ({ id: s.id, name: s.name, city: s.city }));
export const shellMachines = machines.map((m) => ({
  id: m.id,
  code: m.code,
  name: m.name,
  storeId: m.storeId,
}));

/** Öppna åtgärder: tomt fack, fyllnad under gräns och titel utan inköpspris. */
export const todos = [
  { id: "empty", text: "BL-002 fack 3 är tomt sedan 31 okt. 16:40" },
  { id: "fill", text: "BL-003 har 17 % kvar, gränsen är 20 %" },
  { id: "price", text: "Black Bolt saknar inköpspris" },
] as const;

export const organization = { id: "o1", name: "Binderlab AB" };
/** Senaste synk mot Awish: 2 nov. 14:32 svensk tid (skalet visar den i Europe/Stockholm). */
export const SYNCED_AT = "2026-11-02T13:32:00Z";

/** Etikett för en automat, t.ex. "BL-002 Mobilia". */
export function machineLabel(m: Machine): string {
  return `${m.code} ${storeById.get(m.storeId)?.name ?? ""}`.trim();
}
