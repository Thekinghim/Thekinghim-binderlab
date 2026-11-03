/**
 * Svaret högst upp på Datakällor: EN kort mening. Det som behöver göras går
 * först (automater att koppla, hämtning som stoppat); annars hur ny datan är
 * (den senaste orderns tid, inte när någon senast laddade upp: en gammal export
 * ska inte se färsk ut). `aside` är en kort grå rad under. Ren funktion.
 */

import { formatInt, NBSP } from "@/lib/format";

import { formatWhen, plural } from "./display";
import type { DatakallorData, SourceView } from "./types";

/** Samma gräns som skalets synkstatus (STALE_SYNC_HOURS i src/server/data/core). */
export const STALE_HOURS = 26;

/** Den senaste orderns tid bland källorna (ISO), eller null. */
export function latestOrderOf(sources: readonly SourceView[]): string | null {
  return (
    sources
      .map((s) => s.latestOrderAt)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null
  );
}

/** true om den senaste ordern är äldre än STALE_HOURS (eller saknas). */
export function isStale(latestOrderAt: string | null, now: Date): boolean {
  return (
    latestOrderAt === null ||
    now.getTime() - new Date(latestOrderAt).getTime() > STALE_HOURS * 3_600_000
  );
}

export interface Headline {
  readonly title: string;
  readonly aside: string;
  /** Det som kräver åtgärd, för att välja ton. */
  readonly tone: "ok" | "warning" | "critical" | "neutral";
}

export function headlineOf(data: DatakallorData): Headline {
  const now = new Date(data.now);
  const active = data.sources.filter((s) => !s.archived);
  if (active.length === 0) {
    return { title: "Ingen datakälla ännu.", aside: "Koppla Awish nedan.", tone: "neutral" };
  }

  const latest = latestOrderOf(active);
  const failing = active.some((s) => s.status === "error");
  const stale = isStale(latest, now);
  const dataUntil = latest ? `Data till ${formatWhen(latest, data.timeZone, now)}.` : null;

  const queuedOrders = data.queue.reduce((sum, q) => sum + q.pendingOrders, 0);
  if (data.queue.length > 0) {
    return {
      title: `${plural(data.queue.length, "automat", "automater")} att koppla.`,
      aside:
        queuedOrders > 0
          ? `${plural(queuedOrders, "order", "order")} saknar automat.`
          : (dataUntil ?? ""),
      tone: "warning",
    };
  }
  if (failing) {
    return { title: "Hämtningen stoppade.", aside: dataUntil ?? "", tone: "critical" };
  }

  const last = data.imports[0];
  if (last && last.status === "failed") {
    return { title: "Senaste importen misslyckades.", aside: dataUntil ?? "", tone: "critical" };
  }
  if (!dataUntil) {
    return { title: "Inga order ännu.", aside: "Koppla Awish nedan.", tone: "neutral" };
  }
  if (last && (last.rowsConflict > 0 || last.rowsError > 0)) {
    const parts = [
      `${formatInt(last.rowsNew)} nya`,
      last.rowsConflict > 0 ? plural(last.rowsConflict, "konflikt", "konflikter") : null,
      last.rowsError > 0 ? `${formatInt(last.rowsError)}${NBSP}fel` : null,
    ].filter(Boolean);
    return { title: dataUntil, aside: `Senaste importen: ${parts.join(", ")}.`, tone: "warning" };
  }
  if (stale) {
    return { title: dataUntil, aside: "Mer än ett dygn gammal.", tone: "warning" };
  }
  const orders = active.reduce((sum, s) => sum + s.orders, 0);
  return { title: dataUntil, aside: `${plural(orders, "order", "order")}.`, tone: "ok" };
}
