/**
 * Lagersaldo dag för dag ur lagerhändelserna (stock_events), på samma sätt som vyn
 * `stock_levels`: senaste inventering plus alla händelser efter den.
 *
 * Regler:
 * - Händelserna ordnas per lagerplats och titel efter affärsdatum, tidpunkt (`occurredAt`,
 *   om den finns), `seq` och sist id. Saknas tidpunkt eller seq sorteras händelsen sist
 *   inom dagen. Ordningen spelar roll när en inventering och försäljning sker samma dag.
 * - `count` sätter saldot till det räknade antalet. Alla andra typer ändrar saldot med
 *   `quantity` (påfyllning, mottagning och flytt in är positiva; försäljning, svinn och
 *   flytt ut negativa; justering kan vara båda).
 * - **Känt saldo.** Saldot räknas som känt från första inventeringen, eller från första
 *   händelsen om den är ett inflöde (automaten fylldes från tom). Före det är saldot okänt.
 *   Blir saldot negativt saknas registreringar (t.ex. en påfyllning som inte förts in), och
 *   saldot är okänt fram till nästa inventering.
 */

import { addDays, assertIsoDate, compareDates, DomainError, type IsoDate } from "@/domain";
import { tryParseInstant } from "../todos/time";

/** Typ av lagerhändelse (stock_events.kind). */
export type StockEventKind =
  | "refill"
  | "count"
  | "sale"
  | "waste"
  | "adjustment"
  | "transfer_in"
  | "transfer_out"
  | "receipt";

/** En lagerhändelse. */
export interface StockEventRef {
  readonly id: string;
  /** Lagerplatsen (stock_locations.id). */
  readonly locationId: string;
  /** Automaten för en automatplats, `null` för centrallagret. */
  readonly machineId: string | null;
  readonly titleId: string;
  readonly kind: StockEventKind;
  /** Förändring, eller räknat antal vid `count`. */
  readonly quantity: number;
  /** Affärsdatum (Europe/Stockholm). */
  readonly businessDate: IsoDate;
  /** Tidpunkt, ISO 8601 med tidszon. Ordnar händelser inom dagen. */
  readonly occurredAt?: string | null;
  /** Databasens ordningsnummer. Ordnar händelser med samma tidpunkt. */
  readonly seq?: number | null;
}

/** Saldot en dag. */
export interface DailyStock {
  readonly date: IsoDate;
  /** Saldo vid dagens början (efter föregående dag). `null` = okänt. */
  readonly opening: number | null;
  /** Saldo vid dagens slut. `null` = okänt. */
  readonly closing: number | null;
  /** Summa inflöden under dagen (påfyllning, mottagning, flytt in, positiv justering, positiv skillnad vid inventering). */
  readonly inflow: number;
  /** Sålda pack enligt lagerhändelserna. */
  readonly sold: number;
  /** Om dagen hade en inventering. */
  readonly counted: boolean;
  /** Händelserna under dagen. */
  readonly eventIds: readonly string[];
}

/** Saldohistorik för en titel på en lagerplats. */
export interface StockSeries {
  readonly locationId: string;
  readonly machineId: string | null;
  readonly titleId: string;
  /** Första dagen med en händelse. */
  readonly firstDate: IsoDate;
  /** En rad per dag från `firstDate` till `end`. */
  readonly days: readonly DailyStock[];
}

/** Saldot just nu för en titel på en lagerplats. */
export interface StockLevel {
  readonly locationId: string;
  readonly machineId: string | null;
  readonly titleId: string;
  /** Saldot som vyn stock_levels visar det (kan vara negativt). */
  readonly onHand: number;
  /** Om saldot är känt (se modulens regler). */
  readonly known: boolean;
  readonly lastCountDate: IsoDate | null;
  readonly lastInflowDate: IsoDate | null;
}

const INFLOW_KINDS: ReadonlySet<StockEventKind> = new Set(["refill", "receipt", "transfer_in"]);
const KINDS: ReadonlySet<string> = new Set([
  "refill",
  "count",
  "sale",
  "waste",
  "adjustment",
  "transfer_in",
  "transfer_out",
  "receipt",
]);

function validate(e: StockEventRef): void {
  if (!e || typeof e.id !== "string" || typeof e.locationId !== "string" || typeof e.titleId !== "string") {
    throw new DomainError("invalid_input", "Lagerhändelsen saknar id, lagerplats eller titel.");
  }
  if (!KINDS.has(e.kind)) {
    throw new DomainError("invalid_input", `Okänd typ av lagerhändelse: ${String(e.kind)}.`);
  }
  if (!Number.isSafeInteger(e.quantity) || (e.kind === "count" && e.quantity < 0)) {
    throw new DomainError(
      "invalid_input",
      `Lagerhändelse ${e.id} har ett ogiltigt antal: ${String(e.quantity)}.`,
    );
  }
  assertIsoDate(e.businessDate, `Datum för lagerhändelse ${e.id}`);
}

/** Nyckel för en lagerplats och titel. */
export function stockKey(locationId: string, titleId: string): string {
  return `${locationId}\u0000${titleId}`;
}

/**
 * Ordningen inom en dag: tidpunkt, seq, id. Saknade värden sorteras sist.
 * Total ordning, så att resultatet inte beror på indatans ordning.
 */
export function compareStockEvents(a: StockEventRef, b: StockEventRef): number {
  const d = compareDates(a.businessDate, b.businessDate);
  if (d !== 0) return d;
  const ta = a.occurredAt ? tryParseInstant(a.occurredAt) : null;
  const tb = b.occurredAt ? tryParseInstant(b.occurredAt) : null;
  const ka = ta ?? Number.MAX_SAFE_INTEGER;
  const kb = tb ?? Number.MAX_SAFE_INTEGER;
  if (ka !== kb) return ka < kb ? -1 : 1;
  const sa = a.seq ?? Number.MAX_SAFE_INTEGER;
  const sb = b.seq ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Händelser per lagerplats och titel, ordnade. */
function grouped(events: readonly StockEventRef[]): Map<string, StockEventRef[]> {
  const map = new Map<string, StockEventRef[]>();
  for (const e of events) {
    validate(e);
    const k = stockKey(e.locationId, e.titleId);
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  }
  for (const list of map.values()) list.sort(compareStockEvents);
  return map;
}

/** Tillstånd under genomspelningen. */
interface ReplayState {
  level: number;
  known: boolean;
  started: boolean;
}

/** Spelar upp en händelse. Ger inflödet (pack in) och sålda pack. */
function apply(state: ReplayState, e: StockEventRef): { inflow: number; sold: number } {
  let inflow = 0;
  let sold = 0;
  if (e.kind === "count") {
    if (state.known && e.quantity > state.level) inflow = e.quantity - state.level;
    state.level = e.quantity;
    state.known = true;
  } else {
    if (!state.started && (INFLOW_KINDS.has(e.kind) || (e.kind === "adjustment" && e.quantity > 0))) {
      state.known = true;
    }
    state.level += e.quantity;
    if (e.quantity > 0 && e.kind !== "sale") inflow = e.quantity;
    if (e.kind === "sale") sold = -e.quantity;
    if (state.level < 0) state.known = false;
  }
  state.started = true;
  return { inflow, sold };
}

/**
 * Saldot dag för dag för varje lagerplats och titel, från första händelsen till `end`.
 * Händelser efter `end` räknas inte.
 */
export function replayStockDaily(events: readonly StockEventRef[], end: IsoDate): StockSeries[] {
  assertIsoDate(end, "Sista dag");
  const out: StockSeries[] = [];
  const groups = grouped(events);
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!.filter((e) => e.businessDate <= end);
    const first = list[0];
    if (!first) continue;
    const state: ReplayState = { level: 0, known: false, started: false };
    const days: DailyStock[] = [];
    let idx = 0;
    for (let date = first.businessDate; date <= end; date = addDays(date, 1)) {
      const opening = state.started && state.known ? state.level : null;
      let inflow = 0;
      let sold = 0;
      let counted = false;
      const ids: string[] = [];
      while (idx < list.length && list[idx]!.businessDate === date) {
        const e = list[idx]!;
        const r = apply(state, e);
        inflow += r.inflow;
        sold += r.sold;
        if (e.kind === "count") counted = true;
        ids.push(e.id);
        idx += 1;
      }
      days.push({
        date,
        opening,
        closing: state.known ? state.level : null,
        inflow,
        sold,
        counted,
        eventIds: ids,
      });
    }
    out.push({
      locationId: first.locationId,
      machineId: first.machineId,
      titleId: first.titleId,
      firstDate: first.businessDate,
      days,
    });
  }
  return out;
}

/**
 * Saldot vid slutet av `asOf` för varje lagerplats och titel, som vyn stock_levels
 * (senaste inventering plus händelserna efter), plus om saldot är känt.
 */
export function stockLevels(events: readonly StockEventRef[], asOf: IsoDate): StockLevel[] {
  assertIsoDate(asOf, "Dag för saldot");
  const out: StockLevel[] = [];
  const groups = grouped(events);
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!.filter((e) => e.businessDate <= asOf);
    const first = list[0];
    if (!first) continue;
    const state: ReplayState = { level: 0, known: false, started: false };
    let lastCountDate: IsoDate | null = null;
    let lastInflowDate: IsoDate | null = null;
    for (const e of list) {
      const r = apply(state, e);
      if (e.kind === "count") lastCountDate = e.businessDate;
      if (r.inflow > 0 && e.kind !== "count") lastInflowDate = e.businessDate;
    }
    out.push({
      locationId: first.locationId,
      machineId: first.machineId,
      titleId: first.titleId,
      onHand: state.level,
      known: state.known,
      lastCountDate,
      lastInflowDate,
    });
  }
  return out;
}
