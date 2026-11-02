/**
 * Orderlistans rubrik: ett påstående med siffror, räknat ur listans antal och summa och
 * jämförelseperiodens summa med samma filter. Förändringen kommer från @/domain.
 * Första och senaste order gäller urvalet (filter och sökning), inte hela organisationen.
 * Rent och klientsäkert.
 */

import { wallClockIn } from "@/components/shell/period-state";
import { changeBp, type IsoDate, type Period } from "@/domain";
import {
  formatDate,
  formatDateTime,
  formatInt,
  formatNumber,
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
  /** Organisationen har minst en order. */
  readonly hasOrders: boolean;
  /** Senaste ordern som matchar filtret (utan periodgräns), eller null. */
  readonly latestOrderAt: string | null;
  /** Första affärsdagen med en order som matchar filtret (utan periodgräns), eller null. */
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

/** "i snitt 23 order per dag" (en decimal under 10). */
function perDayPhrase(count: number, days: number): string {
  const perDay = count / days;
  return `i snitt ${formatNumber(perDay, perDay < 10 ? 1 : 0)}${NBSP}order per dag`;
}

export function orderHeadline(input: HeadlineInput): Headline {
  if (!input.hasOrders) {
    return { title: "Inga order ännu.", aside: "Orderna kommer in via Datakällor." };
  }
  const latest = formatAt(input.latestOrderAt, input.timeZone, input.now);
  if (input.totals.count === 0) {
    if (input.filtered) {
      return {
        title: "Inga order matchar filtret.",
        aside:
          input.latestOrderAt === null
            ? "Inte heller utanför perioden."
            : sentence(`Senaste ordern som matchar kom ${latest}`),
      };
    }
    return {
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
  // Började urvalet efter periodens första dag säger vi när (perioden säger inte det).
  if (input.dataStart !== null && input.dataStart > input.period.start) {
    const first = formatDate(isoToLocalDate(input.dataStart), { year: "auto", now: input.now });
    return {
      title,
      aside: sentence(
        `${paid}. ${input.filtered ? "Första ordern i urvalet" : "Första ordern"} kom ${first}`,
      ),
    };
  }
  if (input.periodKey === "idag" || input.days <= 1) return { title, aside: `${paid}.` };
  return { title, aside: sentence(`${paid}, ${perDayPhrase(input.totals.count, input.days)}`) };
}
