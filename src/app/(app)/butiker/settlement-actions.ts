"use server";

/**
 * Server actions för månadsavräkningarna (Butiker → Utbetalning). Tunna omslag:
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
  revalidateSettlementData,
} from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";
import { monthLong } from "@/server/periods/model";
import { undoOutcomeText } from "@/server/periods/service";
import {
  carryDifferenceFor,
  ensureSettlementsFor,
  markSettlementPaidFor,
  PaidAmountQuestion,
  removeCorrectionFor,
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
 *
 * Säger rapporten butiken fick ett annat belopp betalas inget förrän ägaren valt vilket
 * belopp som betalades (`paidChoice`): svaret har då `ask` med båda beloppen.
 */
export async function markSettlementPaid(
  id: unknown,
  paidOn: unknown,
  expectedOre?: unknown,
  paidChoice?: unknown,
): Promise<
  | SettlementActionResult<{
      storeName: string;
      amountOre: number;
      /** Beloppet som betalades (rapportens när ägaren valde det). */
      paidOre: number;
      /** Dagens uträkning − betalt (0 = inget återstår). */
      differenceOre: number;
      /** "Oktober 2026 är stängd." när betalningen stängde månaden, annars null. */
      closedText: string | null;
    }>
  | { ok: false; error: string; ask: { reportOre: number; liveOre: number } }
> {
  try {
    const viewer = await operator();
    const paid = await markSettlementPaidFor(
      viewer,
      idSchema.parse(id),
      dateSchema.parse(paidOn),
      expectedOre === undefined || expectedOre === null ? null : amountSchema.parse(expectedOre),
      new Date(),
      paidChoice === "live" || paidChoice === "report" ? paidChoice : null,
    );
    await revalidateSettlementData();
    const name = monthLong(paid.month);
    return {
      ok: true,
      data: {
        storeName: paid.storeName,
        amountOre: paid.amountOre,
        paidOre: paid.paidOre,
        differenceOre: paid.differenceOre,
        closedText: paid.monthClosed
          ? `${name.charAt(0).toUpperCase()}${name.slice(1)} är stängd. Inget ändras där nu.`
          : null,
      },
    };
  } catch (error) {
    if (error instanceof PaidAmountQuestion) {
      return {
        ok: false,
        error: error.message,
        ask: { reportOre: error.reportOre, liveOre: error.liveOre },
      };
    }
    return failure(error);
  }
}

/**
 * "Lägg på nästa avräkning": skillnaden på en betald avräkning blir en egen rad på butikens
 * nästa obetalda. `expectedOre` är skillnaden ägaren såg.
 */
export async function carrySettlementDifference(
  id: unknown,
  expectedOre: unknown,
): Promise<SettlementActionResult<{ storeName: string; amountOre: number; targetMonth: string }>> {
  try {
    const viewer = await operator();
    const data = await carryDifferenceFor(
      viewer,
      idSchema.parse(id),
      amountSchema.parse(expectedOre),
    );
    await revalidateSettlementData();
    return { ok: true, data: { ...data, targetMonth: monthLong(data.targetMonth) } };
  } catch (error) {
    return failure(error);
  }
}

/** "Ta bort rättelsen" på en obetald avräkning. */
export async function removeSettlementCorrection(
  targetId: unknown,
  sourceId: unknown,
): Promise<SettlementActionResult> {
  try {
    const viewer = await operator();
    await removeCorrectionFor(viewer, idSchema.parse(targetId), idSchema.parse(sourceId));
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Ångra "betald". `periodText` säger vad som hände med månaden när den var stängd
 * ("Oktober 2026 är öppen igen." eller "… är fortfarande stängd. Bara ägaren kan öppna den.").
 */
export async function undoSettlementPaid(
  id: unknown,
): Promise<SettlementActionResult<{ periodText: string | null }>> {
  try {
    const viewer = await operator();
    const undo = await undoSettlementPaidFor(viewer, idSchema.parse(id));
    await revalidateSettlementData();
    return { ok: true, data: { periodText: undoOutcomeText(undo.period, undo.month) } };
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
    await revalidateSettlementData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Skapa förra månadens saknade avräkningar (knappen på Utbetalning). Saknar en butik avtal
 * skapas inget utan `confirmNoAgreement`: svaret säger vilka butiker (de får 0 kr de dagarna).
 */
export async function createMissingSettlements(confirmNoAgreement = false): Promise<
  SettlementActionResult<{
    created: number;
    errors: number;
    noAgreement?: { storeName: string; days: number; whole: boolean }[];
  }>
> {
  try {
    const viewer = await operator();
    const run = await ensureSettlementsFor(viewer, new Date(), {
      allowNoAgreement: confirmNoAgreement === true,
    });
    if (run?.noAgreement && run.noAgreement.length > 0) {
      return {
        ok: true,
        data: {
          created: 0,
          errors: 0,
          noAgreement: run.noAgreement.map((g) => ({
            storeName: g.storeName,
            days: g.days,
            whole: g.whole,
          })),
        },
      };
    }
    await revalidateSettlementData();
    return { ok: true, data: { created: run?.created ?? 0, errors: run?.errors.length ?? 0 } };
  } catch (error) {
    return failure(error);
  }
}
