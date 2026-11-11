"use server";

/**
 * Ny butik, sista steget: kontraktet. Butiken (och automaten) är redan sparade av
 * createStoreGuide; här skapas kontraktet med villkoren från guiden, från samma dag som
 * butikens villkor (createStoreContractFor med fromOpenTerms), och PDF:en. Kom guiden från
 * en plats i pipelinen kopplas platsen till butiken och flyttas till steget Avtal.
 */

import { and, eq, isNull } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import * as s from "@/db/schema";
import { DomainError } from "@/domain";
import { AuthorizationError, withUserDbFor } from "@/server/access";
import { contractFileStore, currentViewer } from "@/server/accounting";
import { ContractError, createStoreContractFor } from "@/server/contracts";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { businessToday } from "@/server/data/core/loaders";
import { dbErrorMessage } from "@/server/errors";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";

import { contractTermsSchema } from "../_lib/validation";
import { leadGuessSafe, saveLeadGuess } from "./_lib/guess";

export type FinishResult =
  | { ok: true; data: { contractId: string; storeName: string; pdf: boolean } }
  | { ok: false; error: string };

export async function finishStoreGuide(raw: unknown): Promise<FinishResult> {
  try {
    await requireContextRole(OPERATOR_ROLES);
    const viewer = await currentViewer();
    const input = z
      .object({
        storeId: z.uuid("Butiken finns inte."),
        leadId: z.uuid().nullable().optional(),
        terms: z.unknown(),
      })
      .parse(raw);
    const terms = contractTermsSchema.parse(input.terms);
    const orgId = viewer.organization.id;
    const today = businessToday(new Date(), viewer.organization.timezone);
    if (input.leadId) {
      const leadId = input.leadId;
      // Gissningen för platsen sparas nu: när platsen har blivit butik går den inte att
      // räkna fram igen. Räknas innan platsen kopplas till butiken.
      const guess = await leadGuessSafe(viewer, leadId);
      await withUserDbFor(viewer.user, async (tx) => {
        if (guess) await saveLeadGuess(tx, orgId, leadId, guess);
        const [lead] = await tx
          .select({ stage: s.expansionLeads.stage })
          .from(s.expansionLeads)
          .where(and(eq(s.expansionLeads.organizationId, orgId), eq(s.expansionLeads.id, leadId)));
        // Som Skapa kontrakt från pipelinen: tidiga steg flyttas till Avtal, senare behålls.
        const early = lead ? ["lead", "contacted", "meeting"].includes(lead.stage) : false;
        await tx
          .update(s.expansionLeads)
          .set({ storeId: input.storeId, ...(early ? { stage: "agreement" as const } : {}) })
          .where(
            and(
              eq(s.expansionLeads.organizationId, orgId),
              eq(s.expansionLeads.id, leadId),
              isNull(s.expansionLeads.storeId),
            ),
          );
      });
    }
    const result = await createStoreContractFor(
      viewer,
      {
        target: `store:${input.storeId}`,
        validFrom: today,
        fromOpenTerms: true,
        terms: {
          shareBp: terms.shareBp,
          base: terms.base,
          lossTreatment: terms.lossTreatment,
          vmbBeforeSplit: terms.vmbBeforeSplit,
          monthlyRentOre: terms.monthlyRentOre,
        },
        specialTerms: terms.specialTerms,
      },
      {
        today,
        renderPdf: pdfStatus().configured ? (html) => getPdfRenderer().renderHtml(html) : null,
        fileStore: () => contractFileStore(),
      },
    );
    if (!result.ok) return { ok: false, error: result.message };
    revalidateAppData();
    return {
      ok: true,
      data: { contractId: result.contractId, storeName: result.storeName, pdf: result.pdf },
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ZodError) {
      return { ok: false, error: error.issues[0]?.message ?? "Kontrollera villkoren." };
    }
    if (
      error instanceof ContractError ||
      error instanceof AuthorizationError ||
      error instanceof DomainError
    ) {
      return { ok: false, error: error.message };
    }
    console.error("[ny butik]", error);
    return { ok: false, error: dbErrorMessage(error) };
  }
}
