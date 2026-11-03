/**
 * Rangordning av automater efter vinst per dag, för att se vilka som ska flyttas. Ren
 * funktion utan I/O. Talen kommer från Enhetsekonomi (compareUnitEconomics via
 * loadUnitEconomicsPage), så samma automat har samma vinst per dag på båda sidorna.
 *
 * "Flytta?" sätts på en automat som har minst RANK_MIN_DAYS aktiva dagar och antingen
 * går med förlust per dag eller tjänar högst hälften av snittet (vsAverageBp ≤ −5 000),
 * när minst RANK_MIN_MACHINES automater kan jämföras.
 */

import type { UnitEconomicsComparison } from "@/analytics/expansion/unit-economics-compare";
import { formatInt, formatSek, NBSP } from "@/lib/format";

/** Minsta antal aktiva dagar innan en automat kan få "Flytta?". */
export const RANK_MIN_DAYS = 14;
/** Minsta antal automater med aktiva dagar för att jämföra mot snittet. */
export const RANK_MIN_MACHINES = 3;
/** Högst så här långt under snittet (bp) och automaten föreslås flyttas. */
export const RANK_MOVE_BELOW_BP = -5_000;

export interface RankRow {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly href: string;
  readonly rank: number;
  readonly profitPerDayOre: number;
  readonly activeDays: number;
  /** Stapelns längd 0–1 (andel av den största vinsten per dag, förlust = 0). */
  readonly bar: number;
  readonly move: boolean;
  /** "−12 kr/dag mot snittet" eller null. */
  readonly vsAverage: string | null;
}

export interface RankingView {
  readonly rows: RankRow[];
  readonly averageProfitPerDayOre: number | null;
  readonly moveCount: number;
  readonly title: string;
  readonly aside: string;
}

export function perDayText(ore: number): string {
  return `${formatSek(ore / 100)}/dag`;
}

export function rankingView(args: {
  comparison: UnitEconomicsComparison;
  machines: ReadonlyArray<{ id: string; code: string; name: string }>;
  hrefOf: (code: string) => string;
}): RankingView {
  const { comparison } = args;
  const machine = new Map(args.machines.map((m) => [m.id, m]));
  const ranked = comparison.rows
    .filter((r) => r.rank !== null && r.profitPerDayOre !== null && machine.has(r.machineId))
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const comparable = ranked.length >= RANK_MIN_MACHINES;
  const top = Math.max(0, ...ranked.map((r) => r.profitPerDayOre ?? 0));
  const avg = comparison.averageProfitPerDayOre;
  const rows: RankRow[] = ranked.map((r) => {
    const m = machine.get(r.machineId)!;
    const perDay = r.profitPerDayOre ?? 0;
    const move =
      comparable &&
      r.activeDays >= RANK_MIN_DAYS &&
      (perDay < 0 || (r.vsAverageBp !== null && r.vsAverageBp <= RANK_MOVE_BELOW_BP));
    const diff = avg === null ? null : perDay - avg;
    return {
      machineId: r.machineId,
      code: m.code,
      name: m.name,
      href: args.hrefOf(m.code),
      rank: r.rank ?? 0,
      profitPerDayOre: perDay,
      activeDays: r.activeDays,
      bar: top > 0 ? Math.max(0, perDay) / top : 0,
      move,
      vsAverage:
        diff === null || !comparable
          ? null
          : `${diff >= 0 ? "+" : "−"}${formatSek(Math.abs(diff) / 100)} mot snittet`,
    };
  });
  const moveCount = rows.filter((r) => r.move).length;
  const worst = [...rows].reverse().find((r) => r.move);
  return {
    rows,
    averageProfitPerDayOre: avg,
    moveCount,
    title: "Vinst per dag.",
    aside:
      rows.length === 0
        ? "Ingen automat har sålt i perioden."
        : worst
          ? moveCount === 1
            ? `${worst.code} tjänar minst. Flytta?`
            : `${formatInt(moveCount)}${NBSP}automater tjänar minst. Flytta?`
          : avg !== null
            ? `Snitt ${perDayText(avg)}.`
            : "",
  };
}
