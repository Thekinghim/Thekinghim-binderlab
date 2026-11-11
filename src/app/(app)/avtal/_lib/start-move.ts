/**
 * "Ändra start till 14 okt.": flyttar ett osignerat kontrakts startdag till första dagen
 * med försäljning utan signerat kontrakt, och kontraktets villkor till samma dag, i en
 * transaktion. Dagen räknas här på servern (samma uppslag som varningen på sidan), aldrig
 * från klienten. Utan beroende på Next; testas i test/db/r2-t6-kontrakt-start.test.ts.
 *
 * Kontraktets PDF: ett mallkontrakt skrivs ut på nytt, så att PDF:en säger den nya dagen
 * och en redan skickad signeringslänk slutar gälla (länken är knuten till PDF:en). Går
 * PDF:en inte att skriva ut, eller är den uppladdad för hand, säger svaret det (`pdf`).
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import * as s from "@/db/schema";
import type { FileStore } from "@/import/file-store";
import type { IsoDate } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { attachContractFileFor, loadContractsFor } from "@/server/accounting";
import { contractTemplateHtmlFor, loadStoreSalesFor, type Viewer } from "@/server/contracts";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import { planStartMove, startFix, uncoveredSales } from "./model";

export class StartMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartMoveError";
  }
}

export interface StartMoveResult {
  /** Nya startdagen. */
  readonly to: IsoDate;
  /** Villkoren fick också den nya startdagen. */
  readonly termsMoved: boolean;
  /**
   * 'updated' = PDF:en är utskriven på nytt med nya dagen; 'stale' = PDF:en säger
   * fortfarande den gamla dagen; 'none' = kontraktet har ingen PDF.
   */
  readonly pdf: "updated" | "stale" | "none";
}

export interface StartMoveDeps {
  readonly today: IsoDate;
  /** Skriver ut HTML som PDF; null = PDF kan inte skapas här. */
  readonly renderPdf: ((html: string) => Promise<Uint8Array>) | null;
  readonly fileStore: () => Promise<FileStore> | FileStore;
}

/** Flyttar kontraktets start (och villkorens). Ägare och admin. */
export async function moveContractStartFor(
  viewer: Viewer,
  contractId: string,
  deps: StartMoveDeps,
): Promise<StartMoveResult> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const [data, sales] = await Promise.all([
    loadContractsFor(viewer, deps.today, { overview: false }),
    loadStoreSalesFor(viewer),
  ]);
  const contract = data.contracts.find((c) => c.id === contractId);
  if (!contract || contract.archived) throw new StartMoveError("Kontraktet finns inte.");
  if (contract.signedAt) throw new StartMoveError("Kontraktet är redan signerat.");
  const stores = data.stores
    .filter((st) => !st.archived)
    .map((st) => ({ id: st.id, name: st.name }));
  const store = stores.find((st) => st.id === contract.storeId);
  if (!store) throw new StartMoveError("Butiken finns inte.");
  const uncovered = uncoveredSales({
    stores: [store],
    sales,
    contracts: data.contracts.map((c) => ({
      id: c.id,
      storeId: c.storeId,
      validFrom: c.validFrom,
      validTo: c.validTo,
      noticeMonths: c.noticePeriodMonths,
      noticeDays: c.noticePeriodDays,
      renewalMonths: c.renewalMonths,
      terminatedOn: c.terminatedOn,
      template: c.template,
      sentAt: c.sentAt,
      signedAt: c.signedAt,
      hasFile: c.hasFile,
      archived: c.archived,
    })),
    today: deps.today,
  })[0];
  const fix = uncovered ? startFix(uncovered, deps.today) : null;
  if (!fix || fix.contractId !== contractId) {
    throw new StartMoveError("Startdagen behöver inte ändras. Ladda om sidan.");
  }
  const plan = planStartMove({
    fix,
    storeName: store.name,
    agreements: data.agreements,
    today: deps.today,
  });
  if (!plan.ok) throw new StartMoveError(plan.reason);

  await withUserDbFor(viewer.user, async (tx) => {
    // Villkoren först: går de inte att flytta (stängd månad, krock) ändras ingenting.
    if (plan.moveAgreementId) {
      const moved = await tx
        .update(s.storeAgreements)
        .set({ validFrom: fix.to })
        .where(
          and(
            eq(s.storeAgreements.organizationId, orgId),
            eq(s.storeAgreements.id, plan.moveAgreementId),
            eq(s.storeAgreements.contractId, contractId),
          ),
        )
        .returning({ id: s.storeAgreements.id });
      if (moved.length === 0) throw new StartMoveError("Villkoren har ändrats. Ladda om sidan.");
    }
    const rows = await tx
      .update(s.contracts)
      .set({ validFrom: fix.to })
      .where(
        and(
          eq(s.contracts.organizationId, orgId),
          eq(s.contracts.id, contractId),
          eq(s.contracts.validFrom, fix.from),
        ),
      )
      .returning({ id: s.contracts.id });
    if (rows.length === 0) throw new StartMoveError("Kontraktet har ändrats. Ladda om sidan.");
  });

  // PDF:en ska säga samma dag som kontraktet. Startdagen är redan sparad: ett fel här
  // rapporteras som 'stale', det rullar inte tillbaka ändringen.
  let pdf: StartMoveResult["pdf"] = contract.hasFile ? "stale" : "none";
  if (contract.template !== null && deps.renderPdf) {
    try {
      const html = await contractTemplateHtmlFor(viewer, contractId);
      const bytes = await deps.renderPdf(html);
      await attachContractFileFor(
        viewer,
        { contractId, fileName: `Placeringsavtal ${store.name}.pdf`, bytes },
        { fileStore: await deps.fileStore() },
      );
      pdf = "updated";
    } catch (error) {
      console.error("[avtal] PDF:en kunde inte skrivas ut efter ny startdag:", error);
    }
  }
  return { to: fix.to, termsMoved: plan.moveAgreementId !== null, pdf };
}
