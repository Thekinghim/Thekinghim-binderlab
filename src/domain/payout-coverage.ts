/**
 * Vilka försäljningsdagar en utbetalning från Nayax gäller, när rapporten inte säger det.
 * Ren funktion, belopp i öre.
 *
 * Nayax betalar ut klumpsummor på oregelbundna dagar. Utan period i rapporten antar vi att
 * pengarna gäller den ÄLDSTA försäljningen som ingen utbetalning täcker än:
 *
 *   1. Kandidatdagarna är dagen efter den senast täckta dagen till och med betaldagen −
 *      `lagDays` (Nayax betalar tidigast dagen efter). Högst 366 dagar (databasens gräns).
 *   2. Vi går igenom dagarna äldst först och summerar det vi väntar oss att få för varje dag
 *      (försäljning − återbetalningar − beräknad kortavgift).
 *   3. Slutdagen är den där summan ligger närmast beloppet. Lika nära: den tidigare dagen.
 *
 * Perioden börjar alltid dagen efter den senast täckta dagen, så två utbetalningar
 * överlappar aldrig (samma regel som databasen har för payouts).
 */

import { addDays, daysBetween } from "./dates";
import type { IsoDate } from "./types";

export const MAX_COVERAGE_DAYS = 366;

export interface CoverageDay {
  readonly date: IsoDate;
  /** Det vi väntar oss från Nayax för dagen (öre). */
  readonly expectedNetOre: number;
}

export interface CoverageInput {
  /** Väntat netto per dag; dagar som saknas räknas som 0. */
  readonly days: readonly CoverageDay[];
  /** Sista dagen som en tidigare utbetalning täcker, eller null (ingen än). */
  readonly lastCoveredEnd: IsoDate | null;
  /** Dagen pengarna kom. */
  readonly paidOn: IsoDate;
  readonly amountOre: number;
  /** Dagar mellan sista försäljningsdagen och betaldagen (standard 1). */
  readonly lagDays?: number;
}

export type CoverageResult =
  | {
      readonly ok: true;
      readonly from: IsoDate;
      readonly to: IsoDate;
      readonly expectedNetOre: number;
      /** Belopp − väntat. */
      readonly diffOre: number;
      readonly note: string;
    }
  | { readonly ok: false; readonly reason: "no_days" | "covered" };

/** Perioden utbetalningen troligen gäller (se filhuvudet). */
export function inferCoverage(input: CoverageInput): CoverageResult {
  const lag = input.lagDays ?? 1;
  const last = addDays(input.paidOn, -lag);
  const byDay = new Map<IsoDate, number>();
  for (const d of input.days) byDay.set(d.date, (byDay.get(d.date) ?? 0) + d.expectedNetOre);
  let start: IsoDate;
  if (input.lastCoveredEnd !== null) {
    start = addDays(input.lastCoveredEnd, 1);
  } else {
    const withSales = [...byDay.entries()]
      .filter(([date, v]) => v !== 0 && date <= last)
      .map(([date]) => date)
      .sort();
    if (withSales.length === 0) return { ok: false, reason: "no_days" };
    start = withSales[0]!;
  }
  if (start > last) return { ok: false, reason: "covered" };
  // Högst 366 dagar: äldre dagar än så kan inte vara med i en utbetalning.
  const maxEnd = addDays(start, MAX_COVERAGE_DAYS);
  const end = last < maxEnd ? last : maxEnd;
  let cum = 0;
  let best: IsoDate = start;
  let bestCum = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0, d = start; d <= end; i++, d = addDays(start, i)) {
    cum += byDay.get(d) ?? 0;
    const gap = Math.abs(cum - input.amountOre);
    if (gap < bestGap) {
      bestGap = gap;
      best = d;
      bestCum = cum;
    }
  }
  const diffOre = input.amountOre - bestCum;
  return {
    ok: true,
    from: start,
    to: best,
    expectedNetOre: bestCum,
    diffOre,
    note: coverageNote(start, best, diffOre),
  };
}

const MONTHS = [
  "jan.",
  "feb.",
  "mars",
  "apr.",
  "maj",
  "juni",
  "juli",
  "aug.",
  "sep.",
  "okt.",
  "nov.",
  "dec.",
];

/** "3–9 nov.", "28 okt.–3 nov.", "28 dec. 2026–3 jan. 2027". */
export function coverageRangeText(from: IsoDate, to: IsoDate): string {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  if (from === to) return `${fd} ${MONTHS[fm - 1]}`;
  if (fy !== ty) return `${fd} ${MONTHS[fm - 1]} ${fy}–${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fm === tm) return `${fd}–${td} ${MONTHS[tm - 1]}`;
  return `${fd} ${MONTHS[fm - 1]}–${td} ${MONTHS[tm - 1]}`;
}

/** Hela kronor med mellanslag som tusentalsavgränsare ("12 340"). */
export function wholeKrText(ore: number): string {
  const kr = Math.round(Math.abs(ore) / 100);
  const digits = String(kr);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += " ";
    out += digits[i];
  }
  return `${ore < 0 && kr !== 0 ? "−" : ""}${out}`;
}

function coverageNote(from: IsoDate, to: IsoDate, diffOre: number): string {
  const days = daysBetween(from, to) + 1;
  const base = `Vi antog att pengarna gäller ${coverageRangeText(from, to)} (${days === 1 ? "1 dag" : `${days} dagar`}, äldsta obetalda försäljningen först).`;
  if (Math.abs(diffOre) < 100) return `${base} Stämmer med vår försäljning.`;
  return `${base} Skiljer ${wholeKrText(Math.abs(diffOre))} kr mot vår försäljning.`;
}
