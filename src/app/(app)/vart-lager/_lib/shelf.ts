/**
 * Vårt lagers hylla (visuellt): hur rutorna sorteras, färgas och filtreras, och texterna för
 * det som är på väg. Bara presentation: talen (hemma, ute, Hemma räcker, Köp in) kommer
 * oförändrade ur vymodellen (./model.ts, ./v2-model.ts). Ren och klientsäker.
 *
 * - Ton: rött när titeln är slut eller tar slut (isOut/isLow, samma regel som tabellens
 *   Slut/Lågt), orange när inköpsplanen vill att den köps in eller packas (row.action), annars
 *   lugnt. Utgångna titlar är "idle" och viks ihop längst ner.
 * - Ordning: rött, orange, resten; inom varje kortast Hemma räcker först, sedan namn.
 * - Räcker-stapeln: dagar på en skala till SHELF_SCALE_DAYS, med ett streck vid titelns
 *   leveranstid när inköpsplanen har en.
 */

import { formatInt, NBSP } from "@/lib/format";

import type { VartLagerRow } from "./model";
import { isLow, isOut } from "./v2-model";

export type ShelfTone = "crit" | "warn" | "ok" | "idle";
export type ShelfChip = "alla" | "kop" | "vag" | "utgar";

/** Räcker-stapelns fulla längd i dagar. */
export const SHELF_SCALE_DAYS = 90;

export function shelfTone(r: VartLagerRow): ShelfTone {
  if (r.retired) return "idle";
  if (isOut(r) || isLow(r)) return "crit";
  if (r.action !== null) return "warn";
  return "ok";
}

/** Etiketten i rutans hörn, eller null. */
export function shelfFlag(r: VartLagerRow): string | null {
  if (r.retired) return null;
  if (isOut(r)) return "Slut";
  if (isLow(r)) return "Slut snart";
  if (r.action !== null) return r.action.kind === "pack" ? "Packa" : "Lågt";
  return null;
}

const RANK: Record<ShelfTone, number> = { crit: 0, warn: 1, ok: 2, idle: 3 };

/** Hyllans ordning: det som behöver köpas in först. */
export function shelfOrder(rows: readonly VartLagerRow[]): VartLagerRow[] {
  const days = (d: number | null) => (d === null ? Number.POSITIVE_INFINITY : d);
  return [...rows].sort(
    (a, b) =>
      RANK[shelfTone(a)] - RANK[shelfTone(b)] ||
      days(a.daysLeft) - days(b.daysLeft) ||
      days(a.lastsDays) - days(b.lastsDays) ||
      a.name.localeCompare(b.name, "sv"),
  );
}

/** Rader för ett chip. `wayIds` = titlar som är på väg. */
export function shelfFilter(
  rows: readonly VartLagerRow[],
  chip: ShelfChip,
  wayIds: ReadonlySet<string>,
): VartLagerRow[] {
  switch (chip) {
    case "kop":
      return rows.filter((r) => !r.retired && r.action !== null);
    case "vag":
      return rows.filter((r) => wayIds.has(r.titleId));
    case "utgar":
      return rows.filter((r) => r.retired);
    default:
      return rows.filter((r) => !r.retired);
  }
}

export function shelfCounts(
  rows: readonly VartLagerRow[],
  wayIds: ReadonlySet<string>,
): Record<ShelfChip, number> {
  return {
    alla: shelfFilter(rows, "alla", wayIds).length,
    kop: shelfFilter(rows, "kop", wayIds).length,
    vag: shelfFilter(rows, "vag", wayIds).length,
    utgar: shelfFilter(rows, "utgar", wayIds).length,
  };
}

/** Räcker-stapelns längd 0–1. */
export function daysShare(days: number | null): number {
  if (days === null || days <= 0) return 0;
  return Math.min(1, days / SHELF_SCALE_DAYS);
}

/** Andelen hemma av hemma + ute (0–1), eller null när inget finns någonstans. */
export function homeShare(home: number, out: number): number | null {
  const h = Math.max(0, home);
  const o = Math.max(0, out);
  return h + o > 0 ? h / (h + o) : null;
}

/** Hela dagar från `from` till `to` (ISO-datum). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function weekdayShort(date: string): string {
  return new Intl.DateTimeFormat("sv-SE", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(".", "");
}

/**
 * Märket under ett pack på väg: "4 d sen" (försenat), "i dag", "i morgon" eller veckodagen
 * ("tor"). `late` = försenat enligt inköpslistan.
 */
export function wayBadge(expectedOn: string, today: string, late: boolean): string {
  const d = daysBetween(today, expectedOn);
  if (late || d < 0) return d < 0 ? `${formatInt(-d)}${NBSP}d sen` : "sen";
  if (d === 0) return "i dag";
  if (d === 1) return "i morgon";
  if (d < 7) return weekdayShort(expectedOn);
  return `om ${formatInt(d)}${NBSP}d`;
}

/** Rubrikens märke: "Skulle kommit tor · 4 d sen" eller "Väntas tor". */
export function wayHeadline(expectedOn: string, today: string, late: boolean): string {
  const d = daysBetween(today, expectedOn);
  const day = weekdayShort(expectedOn);
  if (late || d < 0) {
    return d < 0 ? `Skulle kommit ${day} · ${formatInt(-d)}${NBSP}d sen` : `Skulle kommit ${day}`;
  }
  if (d === 0) return "Väntas i dag";
  if (d === 1) return "Väntas i morgon";
  return `Väntas ${day}`;
}

/** Hylla eller Tabell (Vårt lager och Inköpspriser). */
export type ShelfView = "hylla" | "tabell";

/** Kakan som minns vyn, per sida (servern läser den, ./view-toggle.tsx skriver den). */
export const VIEW_COOKIE = { lager: "bl-lager-vy", priser: "bl-priser-vy" } as const;

/** Kakans värde → vy (allt okänt = Hylla). */
export function parseShelfView(raw: string | null | undefined): ShelfView {
  return raw === "tabell" ? "tabell" : "hylla";
}
