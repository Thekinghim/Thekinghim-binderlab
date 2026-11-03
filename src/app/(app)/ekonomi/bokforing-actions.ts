"use server";

/**
 * Server actions för Ekonomi → Bokföring. Tunna omslag kring src/server/bokforing: rollen
 * kontrolleras här (requireContextRole) och i tjänsten mot databasen, och allt skrivs som
 * användaren med RLS. Svarar { ok, data } eller { ok: false, error } på svenska.
 */

import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { AccountingError, currentViewer } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import {
  archiveReceiptFor,
  markMonthSentFor,
  saveBokforingSettingsFor,
  unmarkMonthSentFor,
  uploadReceiptFor,
  type BokforingSettingsInput,
} from "@/server/bokforing/service";
import { MAX_RECEIPT_BYTES } from "@/server/bokforing/receipts";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { businessToday } from "@/server/data/core/loaders";
import { dbErrorMessage } from "@/server/errors";

import { monthSchema } from "./_lib/schemas";

export type BokforingResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof AccountingError || error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  console.error("[bokforing]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  const viewer = await currentViewer();
  return { viewer, today: businessToday(new Date(), viewer.organization.timezone) };
}

export async function saveBokforingSettings(raw: BokforingSettingsInput): Promise<BokforingResult> {
  try {
    const { viewer } = await operator();
    await saveBokforingSettingsFor(viewer, raw);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function setMonthSent(raw: {
  month: string;
  sent: boolean;
}): Promise<BokforingResult> {
  try {
    const input = z.object({ month: monthSchema, sent: z.boolean() }).parse(raw);
    const { viewer, today } = await operator();
    if (input.sent) await markMonthSentFor(viewer, input.month, today);
    else await unmarkMonthSentFor(viewer, input.month);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/** FormData: `month` och en eller flera `file`. */
export async function uploadReceipts(
  form: FormData,
): Promise<BokforingResult<{ saved: number; duplicates: number }>> {
  try {
    const month = monthSchema.parse(form.get("month"));
    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return { ok: false, error: "Välj ett kvitto (PDF eller bild)." };
    if (files.length > 20) return { ok: false, error: "Högst 20 kvitton åt gången." };
    const tooBig = files.find((f) => f.size > MAX_RECEIPT_BYTES);
    if (tooBig) return { ok: false, error: `${tooBig.name} är för stor (högst 10 MB).` };
    const { viewer, today } = await operator();
    let saved = 0;
    let duplicates = 0;
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      try {
        const r = await uploadReceiptFor(viewer, month, { name: f.name, bytes }, today);
        if (r.duplicate) duplicates++;
        else saved++;
      } catch (error) {
        if (error instanceof AccountingError) {
          return { ok: false, error: `${f.name}: ${error.message}` };
        }
        throw error;
      }
    }
    revalidateAppData();
    return { ok: true, data: { saved, duplicates } };
  } catch (error) {
    return failure(error);
  }
}

export async function archiveReceipt(raw: { id: string }): Promise<BokforingResult> {
  try {
    const { viewer } = await operator();
    await archiveReceiptFor(viewer, z.object({ id: z.string() }).parse(raw).id);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
