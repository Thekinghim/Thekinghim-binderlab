/**
 * "När säljer vi mest" på Hem (V2, byggplanen 2.2 och 3.7): köp per veckodag och
 * tvåtimmarsblock i organisationens tidszon, och sålda pack per vecka för varje veckodag.
 * Samma order och samma klockslag som värmekartan på Automater och Lönsamhet
 * (salesHeatmap räknar per timme, här slås två timmar ihop). Ren funktion, ingen databas.
 *
 * Ett köp är ett pack (samma som nyckeltalet Sålda pack). Order utan klockslag räknas inte.
 */

import { localParts, tryParseInstant } from "@/analytics/todos/time";
import { dayOfWeek } from "@/domain";

/** Tolv block om två timmar: 00–02, 02–04 … 22–24. */
export const WHEN_BLOCKS = 12;
/** Fem steg i färgskalan (0 = inga köp). */
export const WHEN_LEVELS = 5;

export const WEEKDAYS_SHORT = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"] as const;
const WEEKDAYS_PLURAL = [
  "måndagar",
  "tisdagar",
  "onsdagar",
  "torsdagar",
  "fredagar",
  "lördagar",
  "söndagar",
] as const;

export interface WhenOrder {
  readonly orderedAt?: string | null;
}

export interface WhenGrid {
  /** cells[veckodag 0 = mån][block 0–11] = antal köp. */
  readonly cells: number[][];
  /** Steg 0–5 per ruta (0 = inga köp, 5 = flest). */
  readonly levels: number[][];
  /** Sålda pack per vecka för veckodagen, i tiondelar (106 pack = 1 060). */
  readonly perWeekTenths: number[];
  readonly total: number;
  /** Bästa blocket: veckodag, block och snitt köp per vecka där (tiondelar). */
  readonly peak: {
    readonly weekday: number;
    readonly block: number;
    readonly perWeekTenths: number;
  } | null;
  /** Antal veckor perioden motsvarar (dagar ÷ 7, minst 1), i tiondelar. */
  readonly weeksTenths: number;
}

/**
 * Köpen per veckodag × tvåtimmarsblock. `days` är periodens längd i dagar (för "per
 * vecka"); perioder kortare än en vecka räknas som en vecka.
 */
export function whenGrid(orders: readonly WhenOrder[], timeZone: string, days: number): WhenGrid {
  const cells = Array.from({ length: 7 }, () => new Array<number>(WHEN_BLOCKS).fill(0));
  let total = 0;
  for (const o of orders) {
    if (!o.orderedAt) continue;
    const ms = tryParseInstant(o.orderedAt);
    if (ms === null) continue;
    const parts = localParts(ms, timeZone);
    const weekday = dayOfWeek(parts.date) - 1;
    const hour = Number(parts.time.slice(0, 2));
    const row = cells[weekday];
    if (!row || !Number.isFinite(hour)) continue;
    const block = Math.min(WHEN_BLOCKS - 1, Math.floor(hour / 2));
    row[block] = (row[block] ?? 0) + 1;
    total++;
  }
  const weeksTenths = Math.max(10, Math.round((Math.max(0, days) * 10) / 7));
  const perWeekTenths = cells.map((row) =>
    Math.round((row.reduce((a, b) => a + b, 0) * 100) / weeksTenths),
  );
  const top = Math.max(0, ...cells.flat());
  const levels = cells.map((row) => row.map((v) => whenLevel(v, top)));
  let peak: WhenGrid["peak"] = null;
  let best = 0;
  cells.forEach((row, w) =>
    row.forEach((v, b) => {
      if (v > best) {
        best = v;
        peak = { weekday: w, block: b, perWeekTenths: Math.round((v * 100) / weeksTenths) };
      }
    }),
  );
  return { cells, levels, perWeekTenths, total, peak, weeksTenths };
}

/** Steget för ett antal: 0 utan köp, annars 1–5 i lika stora delar av det största. */
export function whenLevel(value: number, top: number): number {
  if (value <= 0 || top <= 0) return 0;
  return Math.max(1, Math.min(WHEN_LEVELS, Math.ceil((value * WHEN_LEVELS) / top)));
}

/** "18–20" för block 9. */
export function blockText(block: number): string {
  const from = block * 2;
  return `${String(from).padStart(2, "0")}–${String(from + 2).padStart(2, "0")}`;
}

/** "lördagar 18–20" (bästa blocket i ord). */
export function peakText(peak: NonNullable<WhenGrid["peak"]>): string {
  return `${WEEKDAYS_PLURAL[peak.weekday] ?? ""} ${blockText(peak.block)}`;
}
