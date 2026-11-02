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
import { LocalFileStore } from "@/import/file-store";
import {
  AccountingError,
  archiveFixedCostFor,
  BookkeepingNotConfiguredError,
  currentViewer,
  deliverVouchersFor,
  importPayoutFileFor,
  MAX_PAYOUT_FILE_BYTES,
  reviewDeviationFor,
  saveFixedCostFor,
  type PayoutImportResult,
} from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";

import { fixedCostSchema, isoDate, monthSchema } from "./_lib/schemas";

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
    const data = await importPayoutFileFor(
      viewer,
      { name: file.name, bytes },
      { fileStore: new LocalFileStore() },
    );
    revalidateAppData();
    return { ok: true, data };
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

/** Skickar månadens verifikationer till bokföringsprogrammet. */
export async function deliverVouchers(raw: unknown): Promise<ActionResult<{ count: number }>> {
  try {
    const viewer = await operator();
    const { month } = z.object({ month: monthSchema }).parse(raw);
    const result = await deliverVouchersFor(viewer, month);
    return { ok: true, data: { count: result.count } };
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
