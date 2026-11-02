/**
 * Svaret högst upp på Datakällor: en tvådelad rubrik med fakta. Första delen
 * säger hur ny datan är (den senaste orderns tid, inte när någon senast laddade
 * upp: en gammal export ska inte se färsk ut), andra delen det viktigaste att
 * göra (eller att allt är i ordning). Ren funktion.
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
    return {
      title: "Ingen datakälla ännu.",
      aside: "Lägg till Awish-orderlistan och ladda upp den första filen.",
      tone: "neutral",
    };
  }

  const latest = latestOrderOf(active);
  const failing = active.some((s) => s.status === "error");
  const stale = isStale(latest, now);
  const title = latest
    ? `${failing ? "Synken misslyckades. Data till" : "Data till"} ${formatWhen(latest, data.timeZone, now)}.`
    : "Inga order ännu.";

  const queuedOrders = data.queue.reduce((sum, q) => sum + q.pendingOrders, 0);
  if (data.queue.length > 0) {
    return {
      title,
      aside:
        `${plural(data.queue.length, "automat", "automater")} väntar på koppling` +
        (queuedOrders > 0 ? `, ${plural(queuedOrders, "order", "order")} saknar automat.` : "."),
      tone: "warning",
    };
  }

  const last = data.imports[0];
  if (last && last.status === "failed") {
    return { title, aside: "Senaste importen misslyckades.", tone: "critical" };
  }
  if (last && (last.rowsConflict > 0 || last.rowsError > 0)) {
    const parts = [
      `${formatInt(last.rowsNew)} nya`,
      last.rowsConflict > 0 ? plural(last.rowsConflict, "konflikt", "konflikter") : null,
      last.rowsError > 0 ? `${formatInt(last.rowsError)}${NBSP}fel` : null,
    ].filter(Boolean);
    return { title, aside: `Senaste importen: ${parts.join(", ")}.`, tone: "warning" };
  }
  if (!latest) {
    return { title, aside: "Ladda upp orderlistan från Awish.", tone: "neutral" };
  }
  if (stale) {
    const synced = active
      .map((s) => s.lastSyncedAt)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1);
    return {
      title,
      aside: synced
        ? `Senaste uppladdningen ${formatWhen(synced, data.timeZone, now)} hade inget nyare. Exportera en ny orderlista från Awish.`
        : "Mer än ett dygn gammal. Ladda upp en ny orderlista.",
      tone: "warning",
    };
  }
  const orders = active.reduce((sum, s) => sum + s.orders, 0);
  return {
    title,
    aside: `${plural(orders, "order", "order")} importerade, alla automater kopplade.`,
    tone: "ok",
  };
}
