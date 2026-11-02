/**
 * Visning på Datakällor: tider i organisationens tidszon (svensk tid) via
 * src/lib/format, filstorlek och radstatus. Ren och klientsäker.
 */

import { wallClockIn } from "@/components/shell/period-state";
import { formatDateTime, formatDecimal, formatInt, MISSING, NBSP } from "@/lib/format";

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
