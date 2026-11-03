"use server";

/**
 * Server actions för vem gör vad (src/server/team/service.ts). Användaren och
 * organisationen läses på servern; efter en lyckad ändring räknas sidorna om.
 */

import type { ActionResult } from "@/server/auth/flows";
import { revalidateAppData } from "@/server/data/core";
import type { Viewer } from "@/server/data/core/loaders";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";
import { assignTodoFor, setMachineResponsibleFor, TEAM_MESSAGES } from "@/server/team/service";

async function currentViewer(): Promise<Viewer | null> {
  try {
    const user = await requireUser();
    const organization = await getActiveOrganization();
    return organization ? { user, organization } : null;
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
}

async function run<T>(fn: (viewer: Viewer) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  const viewer = await currentViewer();
  if (!viewer) return { ok: false, error: TEAM_MESSAGES.forbidden };
  const result = await fn(viewer);
  if (result.ok) revalidateAppData();
  return result;
}

/** Vem som fyller på automaten ("" = Båda). */
export async function setMachineResponsible(input: {
  machineId: string;
  userId: string;
}): Promise<ActionResult<{ userId: string | null }>> {
  return run((viewer) => setMachineResponsibleFor(viewer, input));
}

/** Vem som gör punkten i Att göra ("" = Båda). */
export async function assignTodo(input: {
  key: string;
  userId: string;
}): Promise<ActionResult<{ userId: string | null }>> {
  return run((viewer) => assignTodoFor(viewer, input));
}
