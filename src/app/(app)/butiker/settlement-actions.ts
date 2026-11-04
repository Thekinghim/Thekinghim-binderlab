"use server";

/**
 * Server actions för månadsavräkningarna (Butiker → Butiksportal). Tunna omslag:
 * organisationen är den aktiva, rollen kontrolleras här (requireContextRole) och igen i
 * tjänsten mot databasen (src/server/settlements/service.ts), allt körs under RLS och
 * databasen låser beloppet på en betald avräkning.
 */

import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { AuthorizationError } from "@/server/access";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateAppData,
} from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";
import {
  ensureSettlementsFor,
  markSettlementPaidFor,
  recomputeSettlementFor,
  SettlementError,
  undoSettlementPaidFor,
} from "@/server/settlements/service";

export type SettlementActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string };

const idSchema = z.string().uuid("Avräkningen finns inte.");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Välj ett datum.");
const amountSchema = z.number().int("Ogiltigt belopp.").safe("Ogiltigt belopp.");

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof AuthorizationError) {
    return { ok: false, error: "Bara ägare och admin kan ändra avräkningar." };
  }
  if (error instanceof SettlementError) return { ok: false, error: error.message };
  console.error("[avrakning]", safeErrorForLog(error));
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

/**
 * Markera som betald (datum ÅÅÅÅ-MM-DD). `expectedOre` är beloppet som ägaren såg: har det
 * ändrats sedan dess betalas inget, och hen får se det nya beloppet först.
 */
export async function markSettlementPaid(
  id: unknown,
  paidOn: unknown,
  expectedOre?: unknown,
): Promise<SettlementActionResult<{ storeName: string; amountOre: number }>> {
  try {
    const viewer = await operator();
    const data = await markSettlementPaidFor(
      viewer,
      idSchema.parse(id),
      dateSchema.parse(paidOn),
      expectedOre === undefined || expectedOre === null ? null : amountSchema.parse(expectedOre),
    );
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Ångra "betald". */
export async function undoSettlementPaid(id: unknown): Promise<SettlementActionResult> {
  try {
    const viewer = await operator();
    await undoSettlementPaidFor(viewer, idSchema.parse(id));
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/** Räkna om en obetald avräkning. */
export async function recomputeSettlement(
  id: unknown,
): Promise<SettlementActionResult<{ amountOre: number; previousOre: number }>> {
  try {
    const viewer = await operator();
    const data = await recomputeSettlementFor(viewer, idSchema.parse(id));
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Skapa förra månadens saknade avräkningar (knappen på Butiksportal). */
export async function createMissingSettlements(): Promise<
  SettlementActionResult<{ created: number; errors: number }>
> {
  try {
    const viewer = await operator();
    const run = await ensureSettlementsFor(viewer);
    revalidateAppData();
    return { ok: true, data: { created: run?.created ?? 0, errors: run?.errors.length ?? 0 } };
  } catch (error) {
    return failure(error);
  }
}
