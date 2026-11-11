"use server";

/**
 * Server actions för Ekonomi. Tunna omslag kring src/server/accounting: indata valideras här
 * (zod), rollen kontrolleras både här (requireContextRole) och i tjänsten mot databasen, och
 * allt läses och skrivs som användaren med RLS. Svarar { ok, data } eller { ok: false, error }
 * med ett svenskt meddelande. Ändringar som påverkar siffror räknar om sidorna sist.
 */

import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { DomainError } from "@/domain";
import { ImportError } from "@/import/errors";
import {
  AccountingError,
  archiveFixedCostFor,
  addManualPayoutFor,
  archivePayoutFor,
  BookkeepingNotConfiguredError,
  currentViewer,
  deliverVouchersFor,
  importPayoutFileFor,
  MAX_PAYOUT_FILE_BYTES,
  payoutExpectationFor,
  reviewDeviationFor,
  saveFixedCostFor,
  type ManualPayoutResult,
  type PayoutImportResult,
} from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { businessToday } from "@/server/data/core/loaders";
import { dbErrorMessage } from "@/server/errors";

import { fixedCostSchema, isoDate, kronorToOre, monthSchema } from "./_lib/schemas";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof AccountingError ||
    error instanceof ImportError ||
    error instanceof AuthorizationError ||
    error instanceof DomainError ||
    error instanceof BookkeepingNotConfiguredError
  ) {
    return { ok: false, error: error.message };
  }
  console.error("[ekonomi]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

/** Utbetalningsfil (CSV): FormData med `file`. */
export async function uploadPayoutFile(form: FormData): Promise<ActionResult<PayoutImportResult>> {
  try {
    const viewer = await operator();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Välj en CSV-fil med utbetalningar." };
    }
    if (file.size > MAX_PAYOUT_FILE_BYTES) {
      return { ok: false, error: "Filen är för stor (högst 10 MB)." };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Underlaget sparas där orderimporten sparar sina filer (IMPORT_FILE_STORE).
    const data = await importPayoutFileFor(viewer, { name: file.name, bytes });
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

const manualPayoutSchema = z.object({
  start: isoDate,
  end: isoDate,
  amount: kronorToOre,
  paidOn: isoDate,
});

/**
 * "Vad betalade Awish?": sparar en utbetalning som skrivits in för hand (belopp i kronor som
 * text, dagen pengarna kom och perioden den gäller). Ägare och admin.
 */
export async function addManualPayout(raw: unknown): Promise<ActionResult<ManualPayoutResult>> {
  try {
    const viewer = await operator();
    const input = manualPayoutSchema.parse(raw);
    const today = businessToday(new Date(), viewer.organization.timezone);
    const data = await addManualPayoutFor(
      viewer,
      {
        period: { start: input.start, end: input.end },
        amountOre: input.amount,
        paidOn: input.paidOn,
      },
      today,
    );
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Det försäljningen ger för en egen period i frågan (läser bara). Ägare och admin. */
export async function payoutExpectation(
  raw: unknown,
): Promise<ActionResult<{ start: string; end: string; orders: number; payoutOre: number }>> {
  try {
    const viewer = await operator();
    const input = z.object({ start: isoDate, end: isoDate }).parse(raw);
    const today = businessToday(new Date(), viewer.organization.timezone);
    const q = await payoutExpectationFor(viewer, { start: input.start, end: input.end }, today);
    return {
      ok: true,
      data: {
        start: q.period.start,
        end: q.period.end,
        orders: q.expected.orders,
        payoutOre: q.expected.payoutOre,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

const reviewSchema = z.object({
  start: isoDate,
  end: isoDate,
  key: z.string().trim().min(1).max(300),
  action: z.enum(["investigated", "reopened"]),
  note: z
    .string()
    .trim()
    .max(2000, "Anteckningen får vara högst 2 000 tecken.")
    .nullable()
    .optional(),
});

/** Markerar en avvikelse som utredd, eller öppnar den igen. */
export async function reviewDeviation(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = reviewSchema.parse(raw);
    if (input.end < input.start) return { ok: false, error: "Ogiltig period." };
    const data = await reviewDeviationFor(viewer, {
      period: { start: input.start, end: input.end },
      key: input.key,
      action: input.action,
      note: input.note ?? null,
    });
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Skickar en avslutad månads verifikationer till bokföringsprogrammet (en gång, loggas). */
export async function deliverVouchers(
  raw: unknown,
): Promise<ActionResult<{ count: number; firstNumber: number; lastNumber: number }>> {
  try {
    const viewer = await operator();
    const { month } = z.object({ month: monthSchema }).parse(raw);
    const today = businessToday(new Date(), viewer.organization.timezone);
    const result = await deliverVouchersFor(viewer, month, today);
    revalidateAppData();
    return {
      ok: true,
      data: {
        count: result.count,
        firstNumber: result.firstNumber,
        lastNumber: result.lastNumber,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Arkiverar en felaktig utbetalning (med anteckning), så att en rättad kan importeras. */
export async function archivePayout(raw: unknown): Promise<ActionResult<{ reference: string }>> {
  try {
    const viewer = await operator();
    const input = z
      .object({
        id: z.uuid(),
        note: z
          .string()
          .trim()
          .min(1, "Skriv varför utbetalningen arkiveras.")
          .max(2000, "Anteckningen får vara högst 2 000 tecken."),
      })
      .parse(raw);
    const data = await archivePayoutFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Skapar eller ändrar en fast kostnad. */
export async function saveFixedCost(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = fixedCostSchema.parse(raw);
    const data = await saveFixedCostFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Arkiverar eller återställer en fast kostnad. */
export async function archiveFixedCost(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = z.object({ id: z.uuid(), archived: z.boolean() }).parse(raw);
    await archiveFixedCostFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
