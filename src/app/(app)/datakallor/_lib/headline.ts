/**
 * Svaret högst upp på Datakällor: en tvådelad rubrik med fakta. Första delen
 * säger hur färsk datan är, andra delen det viktigaste att göra (eller att allt
 * är i ordning). Ren funktion.
 */

import { formatInt, NBSP } from "@/lib/format";

import { formatWhen, plural } from "./display";
import type { DatakallorData } from "./types";

/** Samma gräns som skalets synkstatus (STALE_SYNC_HOURS i src/server/data/core). */
export const STALE_HOURS = 26;

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

  const synced = active
    .map((s) => s.lastSyncedAt)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);
  const failing = active.some((s) => s.status === "error");
  const stale = !synced || now.getTime() - new Date(synced).getTime() > STALE_HOURS * 3_600_000;
  const title = synced
    ? `${failing ? "Synk misslyckades, senast" : "Synkad"} ${formatWhen(synced, data.timeZone, now)}.`
    : "Ingen import ännu.";

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
  if (!synced) {
    return { title, aside: "Ladda upp orderlistan från Awish.", tone: "neutral" };
  }
  if (stale) {
    return { title, aside: "Mer än ett dygn sedan. Ladda upp en ny orderlista.", tone: "warning" };
  }
  const orders = active.reduce((sum, s) => sum + s.orders, 0);
  return {
    title,
    aside: `${plural(orders, "order", "order")} importerade, alla automater kopplade.`,
    tone: "ok",
  };
}
