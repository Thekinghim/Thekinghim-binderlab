"use server";

/**
 * Server actions för Automater. Tunna omslag: organisationen är alltid den aktiva
 * (läses på servern, aldrig från klienten), rollen kontrolleras mot databasen i varje
 * funktion i ./_lib/service (bara ägare och admin) och allt körs under RLS. Triggarna
 * loggar ändringarna i audit_log.
 *
 * En ändrad automat, placering eller driftperiod påverkar Hem, Att göra, Lönsamhet,
 * Butiker, Lager och rapporterna: hela appen räknas om (revalidateAppData).
 */

import { unstable_rethrow } from "next/navigation";

import { isUuid } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { loadMachineHistoryFor } from "@/server/data/v2/analytics/history";
import type { HistoryEntry } from "@/server/data/v2/analytics/history-model";
import { revalidateAppData } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import {
  createMachineFor,
  decommissionMachineFor,
  moveMachineFor,
  reactivateMachineFor,
  updateMachineFor,
} from "./_lib/service";
import { currentViewer } from "./_lib/session";
import { correctProductSwapFor } from "./_lib/swap-correction";
import type { Viewer } from "./_lib/service";

async function withViewer<T>(
  fn: (viewer: Viewer) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let viewer: Viewer;
  try {
    viewer = await currentViewer();
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  const result = await fn(viewer);
  if (result.ok) revalidateAppData();
  return result;
}

/** Lägger till en automat. Returnerar id och kod (för länken till automatens sida). */
export async function createMachine(input: {
  code: string;
  name: string;
  serial?: string;
  activeFrom: string;
  storeId?: string;
}): Promise<ActionResult<{ id: string; code: string }>> {
  return withViewer((v) => createMachineFor(v, input));
}

/** Ändrar namn, serienummer och driftstart. */
export async function updateMachine(input: {
  machineId: string;
  name: string;
  serial?: string;
  activeFrom: string;
}): Promise<ActionResult> {
  return withViewer((v) => updateMachineFor(v, input));
}

/** Flyttar automaten till en annan butik från och med ett datum. */
export async function moveMachine(input: {
  machineId: string;
  storeId: string;
  from: string;
  note?: string;
}): Promise<ActionResult> {
  return withViewer((v) => moveMachineFor(v, input));
}

/** Avvecklar automaten (sista dag i drift). Historiken behålls. */
export async function decommissionMachine(input: {
  machineId: string;
  activeTo: string;
}): Promise<ActionResult> {
  return withViewer((v) => decommissionMachineFor(v, input));
}

/** Ångrar en avveckling. */
export async function reactivateMachine(input: { machineId: string }): Promise<ActionResult> {
  return withViewer((v) => reactivateMachineFor(v, input));
}

/**
 * Automatens historik (V2, Automater → Historik): påfyllningar, inventeringar, produktbyten,
 * offline och placeringar. Inga belopp; alla roller. Läses först när fliken öppnas.
 */
export async function machineHistory(
  machineId: string,
): Promise<ActionResult<readonly HistoryEntry[]>> {
  if (!isUuid(machineId)) return { ok: false, error: "Automaten finns inte." };
  try {
    const viewer = await currentViewer();
    return { ok: true, data: await loadMachineHistoryFor(viewer, machineId) };
  } catch (error) {
    // Utloggad: Nexts omdirigering till inloggningen ska gå vidare, inte bli ett fel här.
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    console.error("[automater] Historiken kunde inte läsas:", error);
    return { ok: false, error: "Historiken kunde inte läsas. Försök igen." };
  }
}

/**
 * "Det var ett produktbyte" (Svinn): ett gammalt byte i ett Awish-fack som räknats som svinn
 * rättas med en flytt tillbaka till lagret strax före räkningen. Bara ägare och admin.
 */
export async function correctProductSwap(input: {
  machineId: string;
  titleId: string;
  quantity: number;
}): Promise<ActionResult<{ quantity: number }>> {
  return withViewer((v) => correctProductSwapFor(v, input));
}
