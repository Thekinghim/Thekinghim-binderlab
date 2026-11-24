/**
 * Laddar "Om Awish krånglar" för Datakällor: hälsan per Awish-väg för organisationen
 * (public.awish_path_health via vakten, src/server/monitoring/watch.ts) som rader på svenska
 * (./awish-health.ts). Läses som systemrollen med organisationen ur den kontrollerade
 * sessionen, bara för ägare och admin. Ett fel ger null (panelen döljs), aldrig en trasig sida.
 */

import "server-only";

import { getServiceDb, type Db } from "@/db/client";
import type { Viewer } from "@/server/data/core/loaders";
import { safely } from "@/server/monitoring/failures";
import { loadAwishWatchFacts } from "@/server/monitoring/watch";

import { awishHealthRows, awishHealthSummary, type AwishHealthRowView } from "./awish-health";
import { formatWhen } from "./display";

export interface AwishHealthPanelData {
  readonly rows: readonly AwishHealthRowView[];
  readonly summary: ReturnType<typeof awishHealthSummary>;
  /** Påfyllningar som väntar på Awish (antal automater). */
  readonly pushPending: number;
}

export async function awishHealthPanel(
  db: Db,
  orgId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<AwishHealthPanelData> {
  const facts = await loadAwishWatchFacts(db, orgId);
  const rows = awishHealthRows(facts.paths, (at) => formatWhen(at, timeZone, now));
  return {
    rows,
    summary: awishHealthSummary(rows),
    pushPending: facts.push?.pendingMachines ?? 0,
  };
}

export async function loadAwishHealthPanelFor(
  viewer: Viewer,
  timeZone: string,
  now: Date = new Date(),
): Promise<AwishHealthPanelData | null> {
  const role = viewer.organization.role;
  if (role !== "owner" && role !== "admin") return null;
  return safely(
    "Awish-hälsan i Datakällor",
    () => awishHealthPanel(getServiceDb(), viewer.organization.id, timeZone, now),
    null,
  );
}
