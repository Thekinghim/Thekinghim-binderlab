"use server";

/**
 * Server actions för stängda månader: ägarens "Öppna månaden igen" (med anledning) och
 * "Stäng månaden" (ägare och admin). Tunna omslag kring src/server/periods/service.ts;
 * databasen kontrollerar rollen och loggar.
 */

import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { AuthorizationError } from "@/server/access";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateSettlementData,
} from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";
import { closeMonthFor, PeriodError, reopenMonthFor } from "@/server/periods/service";

export type PeriodActionResult = { ok: true } | { ok: false; error: string };

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ogiltig månad.");
const reasonSchema = z
  .string()
  .trim()
  .min(3, "Skriv varför månaden öppnas.")
  .max(500, "Skriv kortare (högst 500 tecken).");

function failure(error: unknown, denied: string): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof PeriodError) return { ok: false, error: error.message };
  if (error instanceof AuthorizationError) return { ok: false, error: denied };
  console.error("[manad]", safeErrorForLog(error));
  return { ok: false, error: dbErrorMessage(error) };
}

/** "Öppna månaden igen": bara ägaren, anledningen sparas och loggas. */
export async function reopenMonth(month: unknown, reason: unknown): Promise<PeriodActionResult> {
  try {
    await requireContextRole(["owner"]);
    const viewer = await requireViewer();
    await reopenMonthFor(viewer, monthSchema.parse(month), reasonSchema.parse(reason));
    await revalidateSettlementData();
    return { ok: true };
  } catch (error) {
    return failure(error, "Bara ägaren kan öppna en stängd månad.");
  }
}

/** "Stäng månaden": ägare och admin. */
export async function closeMonth(month: unknown): Promise<PeriodActionResult> {
  try {
    await requireContextRole(OPERATOR_ROLES);
    const viewer = await requireViewer();
    await closeMonthFor(viewer, monthSchema.parse(month));
    await revalidateSettlementData();
    return { ok: true };
  } catch (error) {
    return failure(error, "Bara ägare och admin kan stänga en månad.");
  }
}
