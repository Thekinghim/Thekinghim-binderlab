"use server";

/**
 * Rapporter: butiksrapporter för alla butiker hos en butiksägare i ett svep (en vanlig
 * butiksrapport per butik). Rollen kontrolleras här (ägare och admin) och igen i
 * tjänsten; allt skrivs som användaren med RLS. Inget skickas: utkasten godkänns och
 * skickas en och en som förut.
 */

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";
import { currentReportViewer } from "@/server/reports/runtime";
import { ReportError } from "@/server/reports/service";
import type { IsoMonth } from "@/domain";

import { createOwnerReportsFor, ownerReportsSummary } from "./_lib/owner-reports";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Skriv datum som ÅÅÅÅ-MM-DD." });

const schema = z.object({
  ownerId: z.uuid({ error: "Välj butiksägare." }),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Välj månad." }),
  from: day.nullish(),
  to: day.nullish(),
  greeting: z.string().max(1000, { error: "Hälsningen får vara högst 1 000 tecken." }).nullish(),
  storeIds: z
    .array(z.uuid({ error: "Ogiltigt id." }))
    .max(200)
    .optional(),
});

export type OwnerReportsActionResult =
  | { ok: true; data: { created: number; title: string; description?: string } }
  | { ok: false; error: string };

/** En butiksrapport (utkast) per butik som ägaren har, för månaden eller eget datum. */
export async function createOwnerReports(raw: unknown): Promise<OwnerReportsActionResult> {
  try {
    await requireContextRole(OPERATOR_ROLES);
    const viewer = await currentReportViewer();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Ogiltiga uppgifter." };
    }
    const input = parsed.data;
    if (Boolean(input.from) !== Boolean(input.to)) {
      return { ok: false, error: "Fyll i både från och till." };
    }
    const result = await createOwnerReportsFor(viewer, {
      ownerId: input.ownerId,
      month: input.month as IsoMonth,
      period: input.from && input.to ? { start: input.from, end: input.to } : null,
      greeting: input.greeting ?? null,
      ...(input.storeIds ? { storeIds: input.storeIds } : {}),
    });
    if (result.created.length > 0) {
      revalidatePath("/rapporter");
      await revalidateAppData();
    }
    const summary = ownerReportsSummary(result);
    if (result.created.length === 0) {
      return { ok: false, error: `${summary.title}. ${summary.description ?? ""}`.trim() };
    }
    return {
      ok: true,
      data: {
        created: result.created.length,
        title: summary.title,
        ...(summary.description ? { description: summary.description } : {}),
      },
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ReportError || error instanceof AuthorizationError) {
      return { ok: false, error: error.message };
    }
    console.error("[rapporter] butiksägare", error);
    return { ok: false, error: dbErrorMessage(error) };
  }
}
