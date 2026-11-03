/**
 * Fyll på: automaterna som kort, sorterade efter behov, och raderna per titel med
 * förslaget. Rena funktioner (testas i model.test.ts).
 *
 * - Nu: Binderlabs saldo i automaten (Awish-inventeringen var 10:e minut plus
 *   påfyllningar som registrerats sedan dess). Ett negativt saldo visas som 0.
 * - Kapacitet: summan av fackens kapacitet enligt senaste Awish-läsningen
 *   (stock_locations.awish_fill). Okänd före första läsningen ("Fyllnad: väntar på Awish").
 * - Sålt: pack sålda de senaste 14 hela dagarna (t.o.m. i går), som Att göra.
 * - Läge per titel: "slut" (0 pack), "snart slut" (räcker under 2,5 dagar vid snittet,
 *   samma regel som Att göra), annars inget.
 * - Förslag: kapacitet − nu; utan känd kapacitet en veckas försäljning − nu, men bara för
 *   titlar som är slut eller snart slut. Aldrig fler än packen i lagret man fyller från
 *   (Hemma, Kontoret …: automatens "Fylls på från", annars senast valda, annars
 *   standardlagret) och aldrig under 0. Utan kapacitet sägs aldrig "fullt".
 * - Tomma fack: fack med 0 pack enligt Awish. Har titeln fyllts på sedan läsningen (saldot
 *   är högre än Awish antal) räknas dess fack som fyllda.
 * - Fyllnadsgrad: pack nu / kapacitet över titlarna med känd kapacitet.
 * - Ordning: automater med slut (tomma fack eller titlar på 0) först (flest först), sedan
 *   snart slut, sedan lägst fyllnadsgrad, sist de utan Awish-data; lika ordnas efter kod.
 */

import { inPlace } from "@/components/stock/place-text";
import { formatInt, NBSP } from "@/lib/format";

export interface AwishFillEntry {
  readonly title_id: string;
  readonly units: number;
  readonly capacity: number;
  readonly channels: number;
  readonly empty: number;
}

export interface FillMachineInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Butiken där automaten står i dag, annars null. */
  readonly storeName: string | null;
  /** Senaste Awish-läsningen (ISO), null = aldrig. */
  readonly syncedAt: string | null;
  readonly fill: readonly AwishFillEntry[] | null;
  /** Min automat ("Mina"): jag är ansvarig eller ingen är vald. Utelämnat = min. */
  readonly mine?: boolean;
}

export interface FillInput {
  readonly machines: readonly FillMachineInput[];
  /** Titelns namn per id (bara titlar som finns kvar). */
  readonly titles: ReadonlyMap<string, string>;
  /** Saldo per automat och titel (`${machineId}\u0000${titleId}`). */
  readonly machineStock: ReadonlyMap<string, number>;
  /** Pack hemma (vårt lager) per titel. */
  readonly home: ReadonlyMap<string, number>;
  /** Titlar i automatens sortiment i dag (fackperiod), som nycklar som machineStock. */
  readonly current: ReadonlySet<string>;
  /** Titlar som gått ur automatens sortiment. */
  readonly retired: ReadonlySet<string>;
  /** Sålda pack de senaste SALES_WINDOW_DAYS hela dagarna, som nycklar som machineStock. */
  readonly sold?: ReadonlyMap<string, number>;
}

/** Fönstret för försäljningstakten (hela dagar t.o.m. i går), som Att göra. */
export const SALES_WINDOW_DAYS = 14;
/** "Snart slut": räcker under 2,5 dagar (hundradels dagar), som Att göra. */
export const LOW_CENTIDAYS = 250;
/** Utan känd kapacitet fylls det på för en veckas försäljning. */
export const TARGET_DAYS = 7;

/** Läget för en titel: slut, snart slut eller inget. */
export type RowStatus = "empty" | "low" | null;

export interface FillRow {
  readonly titleId: string;
  readonly name: string;
  /** Pack i automaten nu (minst 0). */
  readonly now: number;
  /** Fackens kapacitet, null = okänd (ingen Awish-läsning av titeln). */
  readonly capacity: number | null;
  /** Pack hemma (kan vara negativt om vårt lager inte är räknat). */
  readonly home: number;
  /** Föreslaget antal att fylla på. */
  readonly suggested: number;
  /** Tomma fack för titeln. */
  readonly emptySlots: number;
  /** Sålda pack de senaste SALES_WINDOW_DAYS dagarna. */
  readonly sold: number;
  readonly status: RowStatus;
}

export interface FillMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Butikens namn, annars automatens namn. */
  readonly place: string;
  readonly syncedAt: string | null;
  /** 0–100, null utan känd kapacitet. */
  readonly fillPct: number | null;
  readonly emptySlots: number;
  readonly units: number;
  readonly capacity: number;
  /** Summan av förslagen. */
  readonly suggested: number;
  /** Titlar som är slut (0 pack). */
  readonly empty: number;
  /** Titlar som snart är slut. */
  readonly low: number;
  /** Behöver påfyllning: tomma fack, slut, snart slut eller ett förslag. */
  readonly needs: boolean;
  readonly mine: boolean;
  readonly rows: readonly FillRow[];
}

export const pairKey = (machineId: string, titleId: string): string =>
  `${machineId}\u0000${titleId}`;

/** Slut (0 pack), snart slut (räcker under 2,5 dagar vid snittet) eller inget. */
export function rowStatus(now: number, sold: number): RowStatus {
  const n = Math.max(0, now);
  if (n === 0) return "empty";
  if (sold > 0 && n * SALES_WINDOW_DAYS * 100 < LOW_CENTIDAYS * sold) return "low";
  return null;
}

/**
 * Förslaget: kapacitet − nu; utan kapacitet en veckas försäljning − nu för titlar som är slut
 * eller snart slut. Högst packen hemma, minst 0.
 */
export function suggestFill(now: number, capacity: number | null, home: number, sold = 0): number {
  const n = Math.max(0, now);
  const target =
    capacity !== null
      ? capacity
      : rowStatus(n, sold) !== null
        ? Math.ceil((Math.max(0, sold) * TARGET_DAYS) / SALES_WINDOW_DAYS)
        : 0;
  return Math.max(0, Math.min(target - n, Math.max(0, home)));
}

/** Största antal som går att välja för en rad (stegarens tak). */
export function maxFill(row: Pick<FillRow, "now" | "capacity">): number {
  if (row.capacity === null) return 500;
  return Math.max(0, row.capacity - row.now, 1);
}

/** Packen delas: så många som finns hemma tas från vårt lager, resten registreras utan uttag. */
export function splitRefill(
  quantity: number,
  home: number,
): { fromWarehouse: number; direct: number } {
  const q = Math.max(0, Math.trunc(quantity));
  const fromWarehouse = Math.min(q, Math.max(0, home));
  return { fromWarehouse, direct: q - fromWarehouse };
}

const STATUS_RANK = { empty: 0, low: 1 } as const;

function rowOrder(a: FillRow, b: FillRow): number {
  const ae = a.status === null ? 2 : STATUS_RANK[a.status];
  const be = b.status === null ? 2 : STATUS_RANK[b.status];
  if (ae !== be) return ae - be;
  const ag = a.capacity === null ? -1 : a.capacity - a.now;
  const bg = b.capacity === null ? -1 : b.capacity - b.now;
  if (ag !== bg) return bg - ag;
  return a.name.localeCompare(b.name, "sv");
}

/** Raderna för en automat. */
export function machineRows(machine: FillMachineInput, input: FillInput): FillRow[] {
  const fill = new Map((machine.fill ?? []).map((f) => [f.title_id, f]));
  const ids = new Set<string>();
  for (const id of fill.keys()) ids.add(id);
  for (const key of input.current) {
    const [m, t] = key.split("\u0000");
    if (m === machine.id && t) ids.add(t);
  }
  for (const [key, q] of input.machineStock) {
    const [m, t] = key.split("\u0000");
    if (m === machine.id && t && q > 0) ids.add(t);
  }
  // Såld nyligen men nu 0 pack: slut (som Att göra), även utan fackdata från Awish.
  for (const [key, n] of input.sold ?? []) {
    const [m, t] = key.split("\u0000");
    if (m === machine.id && t && n > 0) ids.add(t);
  }
  const rows: FillRow[] = [];
  for (const titleId of ids) {
    const name = input.titles.get(titleId);
    if (name === undefined) continue;
    const key = pairKey(machine.id, titleId);
    const f = fill.get(titleId);
    const now = Math.max(0, input.machineStock.get(key) ?? f?.units ?? 0);
    // Utgången titel som inte står i automaten längre: ingen rad.
    if (!f && input.retired.has(key) && now === 0) continue;
    const capacity = f && f.capacity > 0 ? f.capacity : null;
    const home = input.home.get(titleId) ?? 0;
    const sold = Math.max(0, input.sold?.get(key) ?? 0);
    rows.push({
      titleId,
      name,
      now,
      capacity,
      home,
      suggested: suggestFill(now, capacity, home, sold),
      emptySlots: f && now <= f.units ? Math.max(0, f.empty) : 0,
      sold,
      status: rowStatus(now, sold),
    });
  }
  return rows.sort(rowOrder);
}

/** Summorna för en automat ur raderna. */
function totals(rows: readonly FillRow[]) {
  let units = 0;
  let capacity = 0;
  let known = 0;
  for (const r of rows) {
    if (r.capacity === null) continue;
    capacity += r.capacity;
    known += Math.min(r.now, r.capacity);
    units += r.now;
  }
  const emptySlots = rows.reduce((n, r) => n + r.emptySlots, 0);
  const suggested = rows.reduce((n, r) => n + r.suggested, 0);
  const empty = rows.filter((r) => r.status === "empty").length;
  const low = rows.filter((r) => r.status === "low").length;
  return {
    units,
    capacity,
    fillPct: capacity > 0 ? Math.round((known / capacity) * 100) : null,
    emptySlots,
    suggested,
    empty,
    low,
    needs: emptySlots > 0 || empty > 0 || low > 0 || suggested > 0,
  };
}

/** Alla automater som kort, sorterade efter behov. */
export function fillMachines(input: FillInput): FillMachine[] {
  const out = input.machines.map((m): FillMachine => {
    const rows = machineRows(m, input);
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      place: m.storeName ?? m.name,
      syncedAt: m.syncedAt,
      mine: m.mine ?? true,
      ...totals(rows),
      rows,
    };
  });
  return out.sort(machineOrder);
}

type OrderKey = Pick<FillMachine, "emptySlots" | "fillPct" | "code"> &
  Partial<Pick<FillMachine, "empty" | "low">>;

export function machineOrder(a: OrderKey, b: OrderKey): number {
  const aOut = a.emptySlots + (a.empty ?? 0);
  const bOut = b.emptySlots + (b.empty ?? 0);
  const ae = aOut > 0 ? 0 : (a.low ?? 0) > 0 ? 1 : 2;
  const be = bOut > 0 ? 0 : (b.low ?? 0) > 0 ? 1 : 2;
  if (ae !== be) return ae - be;
  if (aOut !== bOut) return bOut - aOut;
  if ((a.low ?? 0) !== (b.low ?? 0)) return (b.low ?? 0) - (a.low ?? 0);
  const ap = a.fillPct ?? 101;
  const bp = b.fillPct ?? 101;
  if (ap !== bp) return ap - bp;
  return a.code.localeCompare(b.code, "sv", { numeric: true });
}

/** Påfyllningen som den visas efter Klar: "24 pack påfyllda, 61 kvar hemma" / "… kvar i Kontoret". */
export function doneMessage(packs: number, homeLeft: number, place = "hemma"): string {
  return `${formatInt(packs)}${NBSP}pack påfyllda, ${formatInt(Math.max(0, homeLeft))} kvar ${inPlace(place)}`;
}

/** Rubriken på Fyll på: aldrig "fulla" utan känd kapacitet. */
export function fillHeadline(machines: readonly FillMachine[]): string {
  if (machines.length === 0) return "Inga automater.";
  const need = machines.filter((m) => m.needs).length;
  if (need === 1) return "Fyll på 1 automat.";
  if (need > 1) return `Fyll på ${formatInt(need)} automater.`;
  if (machines.every((m) => m.fillPct !== null)) {
    return machines.length === 1 ? "Automaten är full." : "Alla automater är fulla.";
  }
  return "Inget är slut just nu.";
}

/** Kortets rad till höger: "2 slut · 1 snart", "fyll 9", "fullt" eller inget. */
export function needLabel(
  m: Pick<FillMachine, "empty" | "low" | "emptySlots" | "suggested" | "fillPct">,
): string | null {
  const parts: string[] = [];
  if (m.empty > 0) parts.push(`${formatInt(m.empty)} slut`);
  else if (m.emptySlots > 0) {
    parts.push(`${formatInt(m.emptySlots)} ${m.emptySlots === 1 ? "tom plats" : "tomma platser"}`);
  }
  if (m.low > 0) parts.push(`${formatInt(m.low)} snart slut`);
  if (parts.length > 0) return parts.join(" · ");
  if (m.suggested > 0) return `fyll ${formatInt(m.suggested)}`;
  if (m.fillPct !== null) return "fullt";
  return null;
}

/** En påfyllning som ännu inte syns i serverns siffror (i kön eller nyss sparad). */
export interface FillAdjustment {
  readonly machineId: string;
  readonly titleId: string;
  readonly quantity: number;
  readonly fromWarehouse: boolean;
  /** Lagret packen togs från (utelämnat = automatens lager enligt `sourceOf`). */
  readonly fromLocationId?: string | null;
}

/** Saldot per eget lager: platsens id → titelns id → pack. */
export type PlaceStock = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * Serverns siffror plus påfyllningar som ännu inte syns där (kön utan nät, eller nyss
 * sparade innan sidan laddats om) och omräkningar ("Räkna om", saldot i automaten).
 * `sourceOf` ger lagret varje automat fylls från just nu; raderna visar det lagrets saldo.
 * Förslag, fyllnadsgrad, tomma fack och ordning räknas om.
 */
export function applyAdjustments(
  machines: readonly FillMachine[],
  stock: PlaceStock,
  adjustments: readonly FillAdjustment[],
  counts: ReadonlyMap<string, number> = new Map(),
  sourceOf: (machineId: string) => string | null = () => null,
): { machines: FillMachine[]; stock: Record<string, Record<string, number>> } {
  const nextStock: Record<string, Record<string, number>> = Object.fromEntries(
    Object.entries(stock).map(([k, v]) => [k, { ...v }]),
  );
  const added = new Map<string, number>();
  for (const a of adjustments) {
    const k = pairKey(a.machineId, a.titleId);
    added.set(k, (added.get(k) ?? 0) + a.quantity);
    const place = a.fromLocationId ?? sourceOf(a.machineId);
    if (a.fromWarehouse && place) {
      const at = (nextStock[place] ??= {});
      at[a.titleId] = (at[a.titleId] ?? 0) - a.quantity;
    }
  }
  const out = machines.map((m): FillMachine => {
    let changed = false;
    const source = sourceOf(m.id);
    const rows = m.rows.map((r): FillRow => {
      const k = pairKey(m.id, r.titleId);
      const counted = counts.get(k);
      const plus = added.get(k) ?? 0;
      const homeNow = source ? (nextStock[source]?.[r.titleId] ?? 0) : r.home;
      if (counted === undefined && plus === 0 && homeNow === r.home) return r;
      changed = true;
      const now = Math.max(0, counted ?? r.now + plus);
      return {
        ...r,
        now,
        home: homeNow,
        suggested: suggestFill(now, r.capacity, homeNow, r.sold),
        emptySlots: plus > 0 || (counted !== undefined && counted > r.now) ? 0 : r.emptySlots,
        status: rowStatus(now, r.sold),
      };
    });
    if (!changed) return m;
    return { ...m, ...totals(rows), rows: [...rows].sort(rowOrder) };
  });
  return { machines: out.sort(machineOrder), stock: nextStock };
}
