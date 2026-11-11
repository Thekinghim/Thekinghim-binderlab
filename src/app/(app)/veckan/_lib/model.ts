/**
 * Veckosammanfattningen: förra veckan (måndag–söndag) mot veckan innan. Sålda pack, vår
 * vinst, bästa produkten och antalet punkter i Att göra. Ren och klientsäker (testas i
 * model.test.ts).
 *
 * Vinsten är "vår vinst" FÖRE butikernas andel, som på Försäljning i den enkla vyn
 * (samma rader, samma summering: figuresOf och productProfits). Notisen skickas på måndag
 * morgon i organisationens tidszon (weeklyDue), en gång per person och vecka.
 */

import { localParts } from "@/analytics/todos/time";
import { addDays, dayOfWeek, isIsoDate, weekStart, type IsoDate, type Period } from "@/domain";
import type { Formatters } from "@/i18n/format";
import type { Messages } from "@/i18n/sv";

import { productProfits, type ProductProfitRow } from "../../_enkel/model";
import { daysIn, figuresOf, type SalesFigures, type SalesRow } from "../../forsaljning/_lib/model";

/** Första timmen (lokal tid) på måndagen då notisen skickas. */
export const WEEKLY_HOUR = 7;
/** Så många veckor bakåt går sidan Veckan att öppna för. */
export const WEEKLY_MAX_WEEKS_BACK = 26;

export interface WeekPeriods {
  /** Måndagen i veckan som sammanfattas (veckans nyckel). */
  readonly week: IsoDate;
  readonly last: Period;
  readonly previous: Period;
  /** Allt som behöver läsas: båda veckorna. */
  readonly all: Period;
}

/** Veckan som börjar måndagen `week`, och veckan före den. */
export function weekPeriods(week: IsoDate): WeekPeriods {
  const last = { start: week, end: addDays(week, 6) };
  const previous = { start: addDays(week, -7), end: addDays(week, -1) };
  return { week, last, previous, all: { start: previous.start, end: last.end } };
}

/** Förra veckan räknat från dagens affärsdatum (hela veckan före den som pågår). */
export function lastWeekOf(today: IsoDate): WeekPeriods {
  return weekPeriods(addDays(weekStart(today), -7));
}

/**
 * Veckan ur adressen (?v=ÅÅÅÅ-MM-DD): en måndag, en avslutad vecka, högst
 * WEEKLY_MAX_WEEKS_BACK veckor bak. Annat (eller inget) ger förra veckan.
 */
export function weekFromParam(value: unknown, today: IsoDate): WeekPeriods {
  const fallback = lastWeekOf(today);
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !isIsoDate(raw) || dayOfWeek(raw) !== 1) return fallback;
  if (raw > fallback.week || raw < addDays(fallback.week, -7 * WEEKLY_MAX_WEEKS_BACK)) {
    return fallback;
  }
  return weekPeriods(raw);
}

/**
 * Ska veckans notis skickas nu? Bara på måndagen, från WEEKLY_HOUR lokal tid. Ger veckan som
 * sammanfattas (måndagen i förra veckan), som också är nyckeln för "en gång per vecka".
 */
export function weeklyDue(
  now: Date,
  timeZone: string,
): { due: true; week: IsoDate } | { due: false; reason: "not_monday" | "not_yet" } {
  const local = localParts(now.getTime(), timeZone);
  const today = local.date;
  if (dayOfWeek(today) !== 1) return { due: false, reason: "not_monday" };
  if (Number(local.time.slice(0, 2)) < WEEKLY_HOUR) return { due: false, reason: "not_yet" };
  return { due: true, week: lastWeekOf(today).week };
}

export interface WeekBest {
  readonly titleId: string;
  readonly name: string;
  readonly packs: number;
  /** Vår vinst före butikernas andel; null när produkten saknar inköpspris. */
  readonly profitOre: number | null;
}

export interface WeeklySummary {
  readonly week: IsoDate;
  readonly last: Period;
  readonly previous: Period;
  readonly lastFigures: SalesFigures;
  readonly previousFigures: SalesFigures;
  /** Produkten med mest vinst förra veckan (flest pack om inköpspris saknas), annars null. */
  readonly best: WeekBest | null;
  /** Punkter i Att göra just nu; null = visas inte (rollen har ingen lista). */
  readonly todos: number | null;
}

/**
 * Sammanfattningen ur lönsamhetens rader: `days` per dag för båda veckorna och `titles`
 * per titel för förra veckan (båda räknade utan butikernas andel).
 */
export function buildWeeklySummary(args: {
  readonly periods: WeekPeriods;
  readonly days: readonly SalesRow[];
  readonly titleRows: readonly ProductProfitRow[];
  readonly titles: readonly { readonly id: string; readonly name: string }[];
  readonly todos: number | null;
}): WeeklySummary {
  const { periods } = args;
  const top = productProfits(args.titleRows, args.titles)[0] ?? null;
  return {
    week: periods.week,
    last: periods.last,
    previous: periods.previous,
    lastFigures: figuresOf(daysIn(args.days, periods.last)),
    previousFigures: figuresOf(daysIn(args.days, periods.previous)),
    best: top
      ? {
          titleId: top.titleId,
          name: top.name,
          packs: top.packs,
          profitOre: top.noPrice ? null : top.profitOre,
        }
      : null,
    todos: args.todos,
  };
}

const NAME_MAX = 40;

function shortName(name: string): string {
  const n = name.trim();
  return n.length > NAME_MAX ? `${n.slice(0, NAME_MAX - 1).trimEnd()}…` : n;
}

/** Notisens rubrik och text på personens språk. Det viktigaste först. */
export function weeklyPushText(
  s: WeeklySummary,
  t: Messages,
  f: Formatters,
): { title: string; body: string } {
  const last = s.lastFigures;
  const prev = s.previousFigures;
  const title =
    last.packs === 0
      ? t.week.pushTitleNone
      : t.week.pushTitle(last.packs, f.sek(last.profitOre / 100));
  const parts: string[] = [
    prev.packs === 0
      ? t.week.pushBeforeNone
      : t.week.pushBefore(prev.packs, f.sek(prev.profitOre / 100)),
  ];
  if (s.best) parts.push(t.week.pushBest(shortName(s.best.name)));
  if (s.todos !== null && s.todos > 0) parts.push(t.week.pushTodos(s.todos));
  return { title, body: parts.join(" ") };
}

/** Sidan notisen öppnar: Veckan i hela appen, Försäljning (startsidan) i den enkla vyn. */
export function weeklyHref(week: IsoDate, viewMode: "full" | "simple"): string {
  return viewMode === "simple" ? `/?vecka=${week}` : `/veckan?v=${week}`;
}

/**
 * Orden för veckan som visas: "Förra veckan" bara när det är veckan före den som pågår.
 * En äldre vecka (notisen öppnad senare, eller ?v= i adressen) kallas "Den veckan".
 */
export function weekWords(
  t: Messages,
  week: IsoDate,
  today: IsoDate,
): { label: string; headlineNone: string } {
  return lastWeekOf(today).week === week
    ? { label: t.week.lastWeek, headlineNone: t.week.headlineNone }
    : { label: t.week.thatWeek, headlineNone: t.week.headlineNoneThat };
}

export type WeekTrend = "up" | "down" | "same";

export function trendOf(now: number, before: number): WeekTrend {
  return now > before ? "up" : now < before ? "down" : "same";
}
