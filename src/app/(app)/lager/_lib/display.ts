/**
 * Visning på Lager: texter, datum och antal via src/lib/format. Ren och klientsäker.
 * Inga beräkningar av lager här: talen kommer färdiga ur vymodellen (./model).
 */

import { wallClockIn } from "@/components/shell/period-state";
import type { IsoDate } from "@/domain";
import { formatDate, formatDateTime, formatInt, MINUS, MISSING, NBSP } from "@/lib/format";

import type { HistoryKind, StockCell, StockStatus } from "./types";

export const STATUS_LABEL: Record<StockStatus, string> = {
  critical: "Kritisk",
  low: "Låg",
  ok: "OK",
};

/** StatusTag/StatusGlyph-status för en lagerstatus. */
export const STATUS_TONE: Record<StockStatus, "critical" | "warning" | "ok"> = {
  critical: "critical",
  low: "warning",
  ok: "ok",
};

export const HISTORY_LABEL: Record<HistoryKind, string> = {
  refill: "Påfyllning",
  count: "Inventering",
  waste: "Svinn",
  adjustment: "Justering",
  transfer_in: "Flytt in",
  transfer_out: "Flytt ut",
  receipt: "Inleverans",
};

/** '2026-11-04' → lokalt Date mitt på dagen (för format.ts). */
export function isoDateToDate(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/** "4 nov." (året bara om det inte är i år). */
export function formatIsoDate(date: IsoDate | null, today: IsoDate): string {
  if (!date) return MISSING;
  return formatDate(isoDateToDate(date), { year: "auto", now: isoDateToDate(today) });
}

/** "i dag", "i morgon" eller "4 nov.". */
export function relativeDay(date: IsoDate, today: IsoDate): string {
  if (date === today) return "i dag";
  const t = isoDateToDate(today);
  t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  if (date === tomorrow) return "i morgon";
  if (date < today) return `${formatIsoDate(date, today)} (passerat)`;
  return formatIsoDate(date, today);
}

/** "1 nov. 09:50" i organisationens tidszon. */
export function formatWhen(iso: string | null, timeZone: string, now: string): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { now: wallClockIn(new Date(now), timeZone) });
}

/** Automatkod som inte bryts: "BL‑002" med hårt bindestreck (U+2011). */
export function codeText(code: string): string {
  return code.replace(/-/g, "\u2011");
}

/** "12 pack" */
export function packs(n: number): string {
  return `${formatInt(n)}${NBSP}pack`;
}

/** "+12 st" · "−3 st" · "17 st" (inventering: räknat antal). */
export function historyQuantity(kind: HistoryKind, quantity: number): string {
  if (kind === "count") return `${formatInt(quantity)}${NBSP}st`;
  if (quantity < 0) return `${MINUS}${formatInt(-quantity)}${NBSP}st`;
  return `+${formatInt(quantity)}${NBSP}st`;
}

/** Tiondelar som decimaltal med komma: 23 → "2,3". */
export function tenthsText(tenths: number): string {
  const sign = tenths < 0 ? MINUS : "";
  const abs = Math.abs(tenths);
  return `${sign}${formatInt(Math.floor(abs / 10))},${abs % 10}`;
}

/** "2 d" · "< 1 d" · "slut" · "–" (ingen försäljning). */
export function daysLeftText(cell: Pick<StockCell, "onHand" | "daysLeft">): string {
  if (cell.onHand <= 0) return "slut";
  if (cell.daysLeft === null) return MISSING;
  if (cell.daysLeft === 0) return `<${NBSP}1${NBSP}d`;
  return `${formatInt(cell.daysLeft)}${NBSP}d`;
}

/** Lång form för skärmläsare och dialog: "räcker 2 dagar", "räcker mindre än 1 dag". */
export function daysLeftLong(
  cell: Pick<StockCell, "onHand" | "daysLeft">,
  windowDays: number,
): string {
  if (cell.onHand <= 0) return "slut";
  if (cell.daysLeft === null)
    return `ingen försäljning de senaste ${formatInt(windowDays)} dagarna`;
  if (cell.daysLeft === 0) return "räcker mindre än 1 dag";
  return `räcker ${formatInt(cell.daysLeft)}${NBSP}${cell.daysLeft === 1 ? "dag" : "dagar"}`;
}

/** "1 automat" / "3 automater" m.fl. */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}
