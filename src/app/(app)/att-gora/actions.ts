"use server";

/**
 * Server actions för Att göra. Tunna omslag runt ./_lib/service: användaren och
 * organisationen läses alltid på servern (aldrig från klienten), rollen kontrolleras
 * mot databasen i varje funktion och allt körs under RLS. Efter en lyckad ändring
 * räknas alla sidor om (Hem, Att göra med menyns räknare, Lager, Lönsamhet …).
 */

import type { ActionResult } from "@/server/auth/flows";
import { revalidateAppData } from "@/server/data/core";
import type { Viewer } from "@/server/data/core/loaders";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

import {
  TODO_MESSAGES,
  dismissTodoFor,
  mergeTitlesFor,
  registerRefillFor,
  undoDismissFor,
} from "./_lib/service";

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
  if (!viewer) return { ok: false, error: TODO_MESSAGES.forbidden };
  const result = await fn(viewer);
  if (result.ok) revalidateAppData();
  return result;
}

/** Bockar av en punkt (nyckel och fingerprint från listan). */
export async function dismissTodo(input: {
  key: string;
  fingerprint: string;
}): Promise<ActionResult<{ key: string; title: string }>> {
  return run((viewer) => dismissTodoFor(viewer, input));
}

/** Ångrar en avbockning. */
export async function undoDismissTodo(input: { key: string }): Promise<ActionResult> {
  return run((viewer) => undoDismissFor(viewer, input));
}

/** Registrerar en påfyllning i en automat. */
export async function registerRefill(input: {
  machineId: string;
  titleId: string;
  quantity: number;
  fromWarehouse: boolean;
  note?: string;
}): Promise<ActionResult<{ quantity: number }>> {
  return run((viewer) => registerRefillFor(viewer, input));
}

/** Slår ihop två titlar som är samma (originaldata behålls). */
export async function mergeTitles(input: {
  fromTitleId: string;
  intoTitleId: string;
}): Promise<ActionResult<{ moved: number }>> {
  return run((viewer) => mergeTitlesFor(viewer, input));
}
