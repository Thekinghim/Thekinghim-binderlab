/**
 * Visning på Datakällor: tider i organisationens tidszon (svensk tid) via
 * src/lib/format, filstorlek och radstatus. Ren och klientsäker.
 */

import { wallClockIn } from "@/components/shell/period-state";
import { formatDate, formatDateTime, formatDecimal, formatInt, MISSING, NBSP } from "@/lib/format";

import type { RowStatus } from "./types";

/** "1 nov. 21:23" (året skrivs ut om det inte är i år), i tidszonen. */
export function formatWhen(iso: string | null, timeZone: string, now: Date = new Date()): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { now: wallClockIn(now, timeZone) });
}

/** Som formatWhen men alltid med år: "1 nov. 2026 17:17". */
export function formatWhenWithYear(iso: string | null, timeZone: string): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { year: "always" });
}

/** 840 B · 12 kB · 3,4 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return MISSING;
  if (bytes < 1000) return `${formatInt(bytes)}${NBSP}B`;
  if (bytes < 1_000_000) return `${formatInt(bytes / 1000)}${NBSP}kB`;
  return `${formatDecimal(bytes / 1_000_000)}${NBSP}MB`;
}

export const ROW_STATUS_LABELS: Record<RowStatus, string> = {
  new: "Ny",
  duplicate: "Dubblett",
  conflict: "Konflikt",
  error: "Fel",
  not_paid: "Ej betald",
};

/** "1 rad" / "12 rader" */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** Ett ISO-datum ("2026-11-01") som "1 nov. 2026". */
export function formatIsoDay(isoDay: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay ?? "");
  if (!m) return MISSING;
  return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), { year: "always" });
}

/**
 * Det som inte är nytt i en fil, som delar av en mening: "460 finns redan",
 * "1 konflikt", "2 fel", "1 ej betald".
 */
export function notNewParts(s: {
  duplicate: number;
  conflict: number;
  error: number;
  notPaid: number;
}): string[] {
  const parts: string[] = [];
  if (s.duplicate > 0) parts.push(`${formatInt(s.duplicate)}${NBSP}finns redan`);
  if (s.conflict > 0) parts.push(plural(s.conflict, "konflikt", "konflikter"));
  if (s.error > 0) parts.push(`${formatInt(s.error)}${NBSP}fel`);
  if (s.notPaid > 0) parts.push(plural(s.notPaid, "ej betald", "ej betalda"));
  return parts;
}
