"use server";

/**
 * Server actions för Rutt (V2). Tunna omslag: organisationen är den aktiva, rollen kontrolleras
 * i tjänsten och mot databasen (RLS), och triggrarna loggar ändringen.
 */

import { unstable_rethrow } from "next/navigation";

import type { ActionResult } from "@/server/auth/flows";
import { revalidateAppData } from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import {
  changeRouteFor,
  ROUTE_MESSAGES,
  saveRouteLimitsFor,
  undoRouteChangeFor,
  type RouteChangeKind,
  type RouteLimitsInput,
} from "./_lib/service";

async function viewerOrNull() {
  try {
    return await currentViewer();
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

/** Hoppa över, Till i morgon eller Lägg till i dagens rutt. */
export async function changeRoute(
  machineId: string,
  change: RouteChangeKind,
): Promise<ActionResult<{ id: string; replaced: RouteChangeKind | null }>> {
  const viewer = await viewerOrNull();
  if (!viewer) return { ok: false, error: ROUTE_MESSAGES.forbidden };
  const result = await changeRouteFor(viewer, String(machineId ?? ""), change);
  if (result.ok) await revalidateAppData();
  return result;
}

/** Ångra en ändring (och lägg tillbaka den som ersattes). */
export async function undoRouteChange(
  id: string,
  restore: RouteChangeKind | null = null,
): Promise<ActionResult> {
  const viewer = await viewerOrNull();
  if (!viewer) return { ok: false, error: ROUTE_MESSAGES.forbidden };
  const result = await undoRouteChangeFor(viewer, String(id ?? ""), restore);
  if (result.ok) await revalidateAppData();
  return result;
}

/** Dagens gräns (ägare och admin). */
export async function saveRouteLimits(input: RouteLimitsInput): Promise<ActionResult> {
  const viewer = await viewerOrNull();
  if (!viewer) return { ok: false, error: ROUTE_MESSAGES.limitsForbidden };
  const result = await saveRouteLimitsFor(viewer, {
    maxStops: Number(input?.maxStops),
    maxPacks: Number(input?.maxPacks),
    weekdays: Array.isArray(input?.weekdays) ? input.weekdays.map(Number) : [],
  });
  if (result.ok) await revalidateAppData();
  return result;
}
