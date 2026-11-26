"use server";

/**
 * Server actions för Ekonomi → Bokföring. Tunna omslag kring src/server/bokforing: rollen
 * kontrolleras här (requireContextRole) och i tjänsten mot databasen, och allt skrivs som
 * användaren med RLS. Svarar { ok, data } eller { ok: false, error } på svenska.
 */

import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { z, ZodError } from "zod";

import { AccountingError, currentViewer } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import {
  archiveReceiptFor,
  markMonthSentFor,
  saveBokforingSettingsFor,
  setBokforingVmbFor,
  unmarkMonthSentFor,
  uploadReceiptFor,
  type BokforingSettingsInput,
} from "@/server/bokforing/service";
import { MAX_RECEIPT_BYTES } from "@/server/bokforing/receipts";
import { refreshUnsentPackagesFor } from "@/server/bokforing/stored";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { businessToday } from "@/server/data/core/loaders";
import { dbErrorMessage } from "@/server/errors";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { monthLong } from "@/server/periods/model";
import { undoOutcomeText } from "@/server/periods/service";

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
    await revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * "VMB i bokföringen" på eller av. Svarar direkt när valet är sparat; sparade paket för
 * månader som inte är skickade tas fram på nytt efter svaret (after), annars gör det
 * schemalagda jobbet eller nedladdningen det.
 */
export async function setBokforingVmb(raw: { enabled: boolean }): Promise<BokforingResult> {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(raw);
    const { viewer, today } = await operator();
    await setBokforingVmbFor(viewer, enabled);
    // Efter svaret: valet är sparat även om PDF-renderingen tar lång tid eller går fel.
    after(async () => {
      try {
        const renderPdf = pdfStatus().configured
          ? (html: string) => getPdfRenderer().renderHtml(html)
          : null;
        await refreshUnsentPackagesFor(viewer, today, { renderPdf });
      } catch (error) {
        console.error("[bokforing] paketen togs inte fram på nytt", error);
      }
    });
    await revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Markera som skickad (månaden stängs) eller ångra (månaden öppnas, om inget annat håller
 * den stängd). `periodText` säger vad som hände med månaden, eller null.
 */
export async function setMonthSent(raw: {
  month: string;
  sent: boolean;
}): Promise<BokforingResult<{ periodText: string | null }>> {
  try {
    const input = z.object({ month: monthSchema, sent: z.boolean() }).parse(raw);
    const { viewer, today } = await operator();
    let periodText: string | null = null;
    if (input.sent) {
      const sent = await markMonthSentFor(viewer, input.month, today);
      if (sent.monthClosed) {
        const name = monthLong(input.month);
        periodText = `${name.charAt(0).toUpperCase()}${name.slice(1)} är stängd. Inget ändras där nu.`;
      }
    } else {
      periodText = undoOutcomeText(await unmarkMonthSentFor(viewer, input.month), input.month);
    }
    await revalidateAppData();
    return { ok: true, data: { periodText } };
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
    await revalidateAppData();
    return { ok: true, data: { saved, duplicates } };
  } catch (error) {
    return failure(error);
  }
}

export async function archiveReceipt(raw: { id: string }): Promise<BokforingResult> {
  try {
    const { viewer } = await operator();
    await archiveReceiptFor(viewer, z.object({ id: z.string() }).parse(raw).id);
    await revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
