/**
 * Orderlistans rubrik: ett påstående med siffror, räknat ur listans antal och summa och
 * jämförelseperiodens summa med samma filter. Förändring och snitt kommer från @/domain.
 * Rent och klientsäkert.
 */

import { wallClockIn } from "@/components/shell/period-state";
import { changeBp, roundHalfUp, type IsoDate, type Period } from "@/domain";
import {
  formatDate,
  formatDateTime,
  formatInt,
  formatKronor,
  formatPercent,
  formatPeriodShort,
  formatSek,
  MISSING,
  NBSP,
} from "@/lib/format";

import type { OrderTotals } from "./types";

export interface HeadlineInput {
  readonly totals: OrderTotals;
  readonly compareTotals: OrderTotals | null;
  readonly period: Period;
  readonly compare: Period | null;
  /** Antal dagar i perioden. */
  readonly days: number;
  /** "idag" ger "i dag" i stället för "på 1 dag". */
  readonly periodKey: string;
  readonly latestOrderAt: string | null;
  /** Första dagen med order i organisationen, eller null. */
  readonly dataStart: IsoDate | null;
  /** Sökning, titel-, butiks- eller automatfilter är satt. */
  readonly filtered: boolean;
  readonly timeZone: string;
  readonly now: Date;
}

export interface Headline {
  readonly title: string;
  readonly aside: string;
}

/** "2026-10-13" → lokal midnatt (för format.ts). */
export function isoToLocalDate(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function shortPeriod(p: Period, now: Date): string {
  return formatPeriodShort({ start: isoToLocalDate(p.start), end: isoToLocalDate(p.end) }, now);
}

/** Tidpunkt i organisationens tidszon: "1 nov. 17:17" (året bara om det inte är i år). */
export function formatAt(iso: string | null, timeZone: string, now: Date): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { now: wallClockIn(now, timeZone) });
}

/** Avslutar med punkt, men inte efter en förkortning som redan har en ("3 okt."). */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

function periodPhrase(input: HeadlineInput): string {
  if (input.periodKey === "idag") return "i dag";
  return `på ${plural(input.days, "dag", "dagar")}`;
}

/** Snittbelopp per order (öre), avrundat som i beräkningslagret. null utan order. */
export function averageOre(totals: OrderTotals): number | null {
  return totals.count > 0 ? roundHalfUp(totals.amountOre, totals.count) : null;
}

/**
 * "12 % mer än 23 sep. – 12 okt." · "4,2 % mindre än …" · "samma som …" · "inga order …".
 * null utan jämförelse, eller när jämförelseperioden ligger före första ordern.
 */
export function comparePhrase(input: HeadlineInput): string | null {
  if (!input.compare || !input.compareTotals) return null;
  const cp = shortPeriod(input.compare, input.now);
  if (input.compareTotals.count === 0) {
    if (input.dataStart !== null && input.dataStart > input.compare.end) return null;
    return `inga order ${cp}`;
  }
  const bp = changeBp(input.totals.amountOre, input.compareTotals.amountOre);
  if (bp === null) return null;
  if (bp === 0) return `samma som ${cp}`;
  const share = Math.abs(bp) / 10_000;
  const pct = formatPercent(share, share < 0.1 ? 1 : 0);
  return `${pct} ${bp > 0 ? "mer" : "mindre"} än ${cp}`;
}

export function orderHeadline(input: HeadlineInput): Headline {
  const latest = formatAt(input.latestOrderAt, input.timeZone, input.now);
  if (input.latestOrderAt === null) {
    return { title: "Inga order ännu.", aside: "Orderna kommer in via Datakällor." };
  }
  if (input.totals.count === 0) {
    return input.filtered
      ? {
          title: "Inga order matchar filtret.",
          aside: sentence(`Senaste ordern kom ${latest}`),
        }
      : {
          title: sentence(
            `Inga order ${input.periodKey === "idag" ? "i dag" : shortPeriod(input.period, input.now)}`,
          ),
          aside: sentence(`Senaste ordern kom ${latest}`),
        };
  }
  const paid = `${formatSek(input.totals.amountOre / 100)} betalt`;
  const title = `${plural(input.totals.count, "order", "order")} ${periodPhrase(input)}.`;
  const change = comparePhrase(input);
  if (change) return { title, aside: sentence(`${paid}, ${change}`) };
  // Ingen jämförelse: jämförelseperioden ligger före första ordern, eller "Allt".
  if (input.dataStart !== null && input.dataStart >= input.period.start) {
    return {
      title,
      aside: sentence(
        `${paid}. Första ordern kom ${formatDate(isoToLocalDate(input.dataStart), { year: "auto", now: input.now })}`,
      ),
    };
  }
  const avg = averageOre(input.totals);
  return {
    title,
    aside:
      avg !== null ? sentence(`${paid}, snitt ${formatKronor(avg / 100)} per order`) : `${paid}.`,
  };
}
