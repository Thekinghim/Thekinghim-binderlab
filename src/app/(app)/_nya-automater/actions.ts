"use server";

/**
 * Server actions för nya automater från Awish och guiden "Ny butik"
 * (src/server/machines/new-machines.ts). Användaren och organisationen läses på servern;
 * rollen kontrolleras i tjänsten (ägare och admin). Hela appen räknas om efteråt.
 */

import type { ActionResult } from "@/server/auth/flows";
import { revalidateAppData } from "@/server/data/core";
import type { Viewer } from "@/server/data/core/loaders";
import {
  connectNewMachineFor,
  createStoreGuideFor,
  ignoreNewMachineFor,
  NEW_MACHINE_MESSAGES,
  unignoreNewMachineFor,
} from "@/server/machines/new-machines";
import { loadMachineReadinessSafe } from "@/server/onboarding/machine-ready-load";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

async function run<T>(fn: (viewer: Viewer) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let viewer: Viewer | null = null;
  try {
    const user = await requireUser();
    const organization = await getActiveOrganization();
    viewer = organization ? { user, organization } : null;
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
  }
  if (!viewer) return { ok: false, error: NEW_MACHINE_MESSAGES.forbidden };
  const result = await fn(viewer);
  if (result.ok) revalidateAppData();
  return result;
}

/** Startklar-raden som visas direkt efter Koppla. */
export interface ConnectedReady {
  /** "BL-004: 3 av 7 klart. Nästa: lägg in avtalet." */
  readonly headline: string;
  /** Automatens sida, där hela listan står. */
  readonly href: string;
}

/**
 * Kopplar en automat som Awish hittat till en butik. Svaret har också Startklar-raden för
 * den nya automaten (null när allt redan är klart eller listan inte gick att läsa).
 */
export async function connectNewMachine(input: {
  sourceMachineId: string;
  storeId: string;
}): Promise<
  ActionResult<{ machineId: string; code: string; orders: number; ready: ConnectedReady | null }>
> {
  return run(async (v) => {
    const result = await connectNewMachineFor(v, input);
    if (!result.ok || !result.data) return result as { ok: false; error: string };
    const { machineId, code, orders } = result.data;
    const list = await loadMachineReadinessSafe(v.user, v.organization.id);
    const r = list.find((x) => x.machineId === machineId && !x.complete);
    return {
      ok: true,
      data: {
        machineId,
        code,
        orders,
        ready: r
          ? { headline: r.headline, href: `/automater/${encodeURIComponent(code.toLowerCase())}` }
          : null,
      },
    };
  });
}

/** "Inte vår": döljer automaten på Att göra. */
export async function ignoreNewMachine(input: { sourceMachineId: string }): Promise<ActionResult> {
  return run((v) => ignoreNewMachineFor(v, input));
}

/** Ångrar "Inte vår". */
export async function unignoreNewMachine(input: {
  sourceMachineId: string;
}): Promise<ActionResult> {
  return run((v) => unignoreNewMachineFor(v, input));
}

/** Guiden "Ny butik": butik, avtal och automat i ett steg. */
export async function createStoreGuide(input: {
  store: { name: string; address?: string; city?: string };
  terms: { preset: string; share?: string; rent?: string };
  machine:
    | { kind: "awish"; sourceMachineId: string }
    | { kind: "new"; code?: string; name?: string }
    | null;
}): Promise<ActionResult<{ storeId: string; machineCode: string | null }>> {
  return run((v) => createStoreGuideFor(v, input));
}
