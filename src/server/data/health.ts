/**
 * Maskinhälsan för sidorna som visar automaternas status (Automater, Hem m.fl.), med
 * exakt samma indata och uträkning som Drift och larmjobbet: loadHealthData (försäljningen
 * ur lagret, lagret och hur långt försäljningen är importerad) och healthOf
 * (@/analytics/health). Då säger Automater aldrig "misstänkt fel" för en automat som Drift
 * visar som i drift bara för att dagens fil inte laddats upp än.
 *
 * Läses som användaren (RLS) efter rollkontroll mot databasen. Alla roller som ser
 * automaterna (ägare, admin, läsare, påfyllare); inga belopp.
 */

import "server-only";

import { cache } from "react";

import type { MachineHealth } from "@/analytics/health";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { healthOf, loadHealthData } from "@/server/alerts/inputs";

import { loadContext } from "./core";
import { businessToday, type Viewer } from "./core/loaders";
import { ALL_ROLES } from "./core/types";
import { currentViewer } from "@/server/purchasing/session";

/** Hälsa per automat (inte arkiverade), som på Drift. */
export async function loadMachineHealthFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<MachineHealth[]> {
  await requireRoleFor(viewer.user, viewer.organization.id, ALL_ROLES);
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const data = await withUserDbFor(viewer.user, (tx) =>
    loadHealthData(tx, viewer.organization.id, today, now),
  );
  return healthOf(data, timeZone, now);
}

/** För serverkomponenter: hälsan som den inloggade, memoiserad per förfrågan. */
export const loadMachineHealth = cache(async (): Promise<MachineHealth[]> => {
  const ctx = await loadContext();
  return loadMachineHealthFor(await currentViewer(), new Date(ctx.now));
});
