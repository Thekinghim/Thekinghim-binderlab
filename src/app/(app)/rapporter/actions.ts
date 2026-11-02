"use server";

/**
 * Server actions för Rapporter. Indata valideras med zod, rollen kontrolleras här
 * (requireContextRole: ägare eller admin) och igen i tjänsten mot databasen, och allt
 * skrivs som användaren med RLS. Inget skickas utan godkännande (sendReportFor kräver det).
 *
 * Alla returnerar { ok: true, data } eller { ok: false, error } med ett svenskt meddelande.
 */

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";
import { MailError } from "@/server/mail/report-mailer";
import { PdfError } from "@/server/pdf/render";
import { currentReportViewer, renderReportPdf, sendDeps } from "@/server/reports/runtime";
import { userReportStore } from "@/server/reports/storage";
import {
  approveReportFor,
  createRecipientFor,
  createReportFor,
  ensurePdfFor,
  ReportError,
  sendReportFor,
  setRecipientActiveFor,
  type SendResult,
} from "@/server/reports/service";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof ReportError ||
    error instanceof AuthorizationError ||
    error instanceof MailError ||
    error instanceof PdfError
  ) {
    return { ok: false, error: error.message };
  }
  console.error("[rapporter]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentReportViewer();
}

function refresh(): void {
  revalidatePath("/rapporter");
  revalidateAppData();
}

const uuid = z.uuid({ error: "Ogiltigt id." });

const createSchema = z.object({
  type: z.enum(["butik", "bokforing", "delagare"], { error: "Välj rapporttyp." }),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Välj månad." }),
  storeId: uuid.nullable().optional(),
  greeting: z.string().max(1000, { error: "Hälsningen får vara högst 1 000 tecken." }).nullish(),
  comment: z.string().max(2000, { error: "Kommentaren får vara högst 2 000 tecken." }).nullish(),
});

/** Skapar ett utkast (ny version) för vald typ, månad och butik. */
export async function createReport(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = createSchema.parse(raw);
    const id = await createReportFor(viewer, {
      type: input.type,
      month: input.month,
      storeId: input.storeId ?? null,
      greeting: input.greeting ?? null,
      comment: input.comment ?? null,
    });
    refresh();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error);
  }
}

const approveSchema = z.object({
  reportId: uuid,
  note: z.string().max(500).nullish(),
});

/** Godkänner rapporten för utskick. */
export async function approveReport(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = approveSchema.parse(raw);
    // PDF:en skapas och sparas FÖRE godkännandet: en godkänd rapport har alltid sin fil
    // (butiksportalen visar godkända rapporter och länkar till PDF:en). Går det inte
    // godkänns rapporten inte, och felet visas.
    try {
      await ensurePdfFor(viewer, input.reportId, {
        store: await userReportStore(),
        render: renderReportPdf,
      });
    } catch (error) {
      unstable_rethrow(error);
      console.error("[rapporter] PDF vid godkännande:", error);
      const reason = error instanceof Error ? error.message : "okänt fel";
      return {
        ok: false,
        error: `PDF:en kunde inte skapas, så rapporten är inte godkänd: ${reason}`,
      };
    }
    await approveReportFor(viewer, input.reportId, input.note ?? null);
    refresh();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

const sendSchema = z.object({
  reportId: uuid,
  recipientIds: z.array(uuid).min(1, { error: "Välj minst en mottagare." }).max(50),
  followText: z.string().max(1000, { error: "Texten får vara högst 1 000 tecken." }).nullish(),
  resend: z.boolean().optional(),
});

/** Skickar en godkänd rapport till valda mottagare. */
export async function sendReport(raw: unknown): Promise<ActionResult<SendResult>> {
  try {
    const viewer = await operator();
    const input = sendSchema.parse(raw);
    const result = await sendReportFor(
      viewer,
      {
        reportId: input.reportId,
        recipientIds: input.recipientIds,
        followText: input.followText ?? null,
        resend: input.resend ?? false,
      },
      await sendDeps(viewer.organization.name),
    );
    refresh();
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}

const recipientSchema = z
  .object({
    name: z.string().trim().min(1, { error: "Skriv namnet." }).max(200),
    email: z.email({ error: "Ogiltig e-postadress." }).max(320),
    kind: z.enum(["store", "accountant", "partner"], { error: "Välj typ av mottagare." }),
    storeId: uuid.nullish(),
  })
  .refine((v) => v.kind !== "store" || Boolean(v.storeId), {
    error: "Välj vilken butik mottagaren hör till.",
    path: ["storeId"],
  });

/** Lägger till en mottagare. */
export async function createRecipient(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = recipientSchema.parse(raw);
    const id = await createRecipientFor(viewer, {
      name: input.name,
      email: input.email,
      kind: input.kind,
      storeId: input.storeId ?? null,
    });
    refresh();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error);
  }
}

const activeSchema = z.object({ recipientId: uuid, active: z.boolean() });

/** Pausar eller återaktiverar en mottagare. */
export async function setRecipientActive(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = activeSchema.parse(raw);
    await setRecipientActiveFor(viewer, input.recipientId, input.active);
    refresh();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
