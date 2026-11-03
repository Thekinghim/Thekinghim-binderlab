/**
 * Skapa avtal (Avtal och Expansion): ett placeringsavtal från mallen med ett klick.
 *
 * createStoreContractFor, i en transaktion som användaren (RLS):
 *  1. Butiken väljs, eller skapas från en plats i pipelinen (expansion_leads). Platsen
 *     kopplas till butiken och flyttas till steget Avtal.
 *  2. Avtalet (contracts) sparas: gäller från startdagen tills vidare, 1 månads
 *     uppsägningstid, mallen placering-vinstdelning-v1, status utkast.
 *  3. Villkoren (store_agreements) blir 50 % av vinsten efter kostnader
 *     (profit_after_costs, förlust ger 0, ingen hyra) från startdagen, kopplade till
 *     avtalet. Villkor som gäller dagen före avslutas dagen före; villkor som börjar samma
 *     dag skrivs om. Butiksrapporten räknar därmed med avtalet direkt.
 * Sedan skrivs avtalet ut som PDF (src/reports/contract-pdf.ts, renderHtml) och sparas i
 * bucketen 'contracts' (attachContractFileFor). Kan PDF inte skapas här sparas avtalet
 * ändå; /avtal/{id}/mall visar det för utskrift.
 *
 * En startdag före i dag räknar om butikens ersättning bakåt; då krävs `confirmHistory`
 * (svaret `needsConfirm`). Stängda månader skyddas av databasen (t40_period_guard).
 *
 * Status: utkast → skickat (sent_at) → signerat (signed_at, när den signerade kopian laddas
 * upp eller ägaren markerar avtalet som signerat).
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { DEFAULT_PROFIT_SHARE_BP, type IsoDate } from "@/domain";
import type { FileStore } from "@/import/file-store";
import {
  CONTRACT_NOTICE_MONTHS,
  CONTRACT_TEMPLATE,
  contractHtml,
  contractTermsSummary,
  type ContractTemplateInput,
} from "@/reports/contract-pdf";
import { dateText } from "@/reports/text";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { attachContractFileFor } from "@/server/accounting/service";
import type { Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";

import { backdatedFrom, planContractAgreement, type ContractStatus } from "./plan";

export type { Viewer };

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** Ett val i Skapa avtal: en butik eller en plats i pipelinen utan butik. */
export interface ContractTargetOption {
  /** "store:{id}" eller "lead:{id}". */
  readonly value: string;
  readonly label: string;
  /**
   * Föreslagen startdag: början på butikens öppna villkor när de är andel av försäljningen
   * (fel modell). Ett avtal från den dagen skriver om dem till vinstdelning bakåt.
   */
  readonly suggestedFrom: IsoDate | null;
}

export interface ContractSetup {
  readonly options: ContractTargetOption[];
  /** Organisationsnumret saknas (Ekonomi → Bokföring); avtalet får en tom rad. */
  readonly orgNumberMissing: boolean;
}

/** Butikerna och platserna i pipelinen som kan få ett avtal. */
export async function loadContractSetupFor(viewer: Viewer): Promise<ContractSetup> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const [stores, leads, orgNumber, contracts, openTerms] = await Promise.all([
      tx
        .select({ id: s.stores.id, name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), isNull(s.stores.archivedAt)))
        .orderBy(asc(s.stores.name)),
      tx
        .select({
          id: s.expansionLeads.id,
          name: s.expansionLeads.name,
          stage: s.expansionLeads.stage,
        })
        .from(s.expansionLeads)
        .where(
          and(
            eq(s.expansionLeads.organizationId, orgId),
            isNull(s.expansionLeads.archivedAt),
            isNull(s.expansionLeads.storeId),
            ne(s.expansionLeads.stage, "lost"),
          ),
        )
        .orderBy(asc(s.expansionLeads.name)),
      readOrgNumber(tx, orgId),
      tx
        .select({ storeId: s.contracts.storeId })
        .from(s.contracts)
        .where(
          and(
            eq(s.contracts.organizationId, orgId),
            isNull(s.contracts.archivedAt),
            isNull(s.contracts.terminatedOn),
          ),
        ),
      tx
        .select({
          storeId: s.storeAgreements.storeId,
          validFrom: s.storeAgreements.validFrom,
          commissionBase: s.storeAgreements.commissionBase,
          commissionBp: s.storeAgreements.commissionBp,
        })
        .from(s.storeAgreements)
        .where(and(eq(s.storeAgreements.organizationId, orgId), isNull(s.storeAgreements.validTo))),
    ]);
    const withContract = new Set(contracts.map((c) => c.storeId));
    const wrongModel = new Map(
      openTerms
        .filter((a) => a.commissionBase === "net_excl_vat" && (a.commissionBp ?? 0) > 0)
        .map((a) => [a.storeId, a.validFrom as IsoDate]),
    );
    // Det som väntar på ett avtal först: platser i steget Avtal eller Möte, sedan butiker
    // utan avtal, övriga platser och sist butiker som redan har ett avtal.
    const waiting = leads.filter((x) => x.stage === "agreement" || x.stage === "meeting");
    const later = leads.filter((x) => x.stage !== "agreement" && x.stage !== "meeting");
    const leadOption = (x: { id: string; name: string }): ContractTargetOption => ({
      value: `lead:${x.id}`,
      label: `${x.name} (ny från pipelinen)`,
      suggestedFrom: null,
    });
    const storeOption = (x: { id: string; name: string }): ContractTargetOption => ({
      value: `store:${x.id}`,
      label: withContract.has(x.id) ? `${x.name} (har avtal)` : x.name,
      suggestedFrom: wrongModel.get(x.id) ?? null,
    });
    return {
      options: [
        ...waiting.map(leadOption),
        ...stores.filter((x) => !withContract.has(x.id)).map(storeOption),
        ...later.map(leadOption),
        ...stores.filter((x) => withContract.has(x.id)).map(storeOption),
      ],
      orgNumberMissing: orgNumber === null,
    };
  });
}

/**
 * Organisationsnumret från Ekonomi → Bokföring (bookkeeping_settings), eller null. Läses med
 * SQL så att Avtal inte beror på Bokföringens schema: utan tabellen blir det en tom rad.
 */
async function readOrgNumber(tx: Tx, orgId: string): Promise<string | null> {
  const exists = Array.from(
    await tx.execute(sql`select to_regclass('public.bookkeeping_settings') is not null as ok`),
  )[0] as { ok?: boolean } | undefined;
  if (!exists?.ok) return null;
  const row = Array.from(
    await tx.execute(
      sql`select org_number from public.bookkeeping_settings where organization_id = ${orgId}::uuid`,
    ),
  )[0] as { org_number?: string | null } | undefined;
  return row?.org_number ?? null;
}

export interface CreateContractInput {
  /** "store:{id}" eller "lead:{id}". */
  readonly target: string;
  readonly validFrom: IsoDate;
  readonly confirmHistory?: boolean;
}

export type CreateContractResult =
  | {
      readonly ok: true;
      readonly contractId: string;
      readonly storeId: string;
      readonly storeName: string;
      /** PDF:en skapades och sparades. */
      readonly pdf: boolean;
    }
  | { readonly ok: false; readonly needsConfirm: true; readonly message: string };

export interface CreateContractDeps {
  readonly today: IsoDate;
  /** Skriver ut HTML som PDF; null = PDF kan inte skapas här. */
  readonly renderPdf: ((html: string) => Promise<Uint8Array>) | null;
  readonly fileStore: (() => Promise<FileStore>) | FileStore;
}

const TARGET = /^(store|lead):([0-9a-f-]{36})$/i;

/** Butiken för avtalet: vald, eller skapad från platsen i pipelinen. */
async function resolveStore(tx: Tx, orgId: string, target: string): Promise<string> {
  const m = TARGET.exec(target);
  if (!m) throw new ContractError("Välj en butik.");
  const [, kind, id] = m as unknown as [string, "store" | "lead", string];
  if (kind === "store") return id;
  const [lead] = await tx
    .select()
    .from(s.expansionLeads)
    .where(and(eq(s.expansionLeads.organizationId, orgId), eq(s.expansionLeads.id, id)))
    .for("update");
  if (!lead) throw new ContractError("Platsen finns inte.");
  if (lead.storeId) return lead.storeId;
  const [store] = await tx
    .insert(s.stores)
    .values({
      organizationId: orgId,
      name: lead.name,
      address: lead.address,
      contactName: lead.contactName,
      email: lead.contactEmail,
      phone: lead.contactPhone,
      storeType: lead.storeType,
      city: lead.city,
      openHoursPerWeek: lead.openHoursPerWeek,
      areaSqm: lead.areaSqm,
    })
    .returning({ id: s.stores.id });
  const early = ["lead", "contacted", "meeting"].includes(lead.stage);
  await tx
    .update(s.expansionLeads)
    .set({ storeId: store!.id, ...(early ? { stage: "agreement" as const } : {}) })
    .where(and(eq(s.expansionLeads.organizationId, orgId), eq(s.expansionLeads.id, id)));
  return store!.id;
}

interface Prepared {
  readonly contractId: string;
  readonly storeId: string;
  readonly template: ContractTemplateInput;
}

/**
 * Skapar avtalet från mallen, villkoren och PDF:en. Se filhuvudet.
 * Kastar ContractError med ett meddelande till användaren.
 */
export async function createStoreContractFor(
  viewer: Viewer,
  input: CreateContractInput,
  deps: CreateContractDeps,
): Promise<CreateContractResult> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const back = backdatedFrom(input.validFrom, deps.today);
  if (back && !input.confirmHistory) {
    return {
      ok: false,
      needsConfirm: true,
      message: `Avtalet börjar ${dateText(back)}. Butikens ersättning räknas om från den dagen. Stängda månader ändras inte.`,
    };
  }

  const prepared = await withUserDbFor(viewer.user, async (tx): Promise<Prepared> => {
    const storeId = await resolveStore(tx, orgId, input.target);
    // Låser butiken så att två samtidiga ändringar av villkoren köas.
    const [store] = await tx
      .select()
      .from(s.stores)
      .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, storeId)))
      .for("update");
    if (!store) throw new ContractError("Butiken finns inte.");
    if (store.archivedAt) throw new ContractError("Butiken är arkiverad.");

    // Ett klick för mycket ska inte ge två avtal: finns ett öppet avtal från mallen stoppas det.
    const [open] = await tx
      .select({ sentAt: s.contracts.sentAt, signedAt: s.contracts.signedAt })
      .from(s.contracts)
      .where(
        and(
          eq(s.contracts.organizationId, orgId),
          eq(s.contracts.storeId, storeId),
          isNotNull(s.contracts.template),
          isNull(s.contracts.archivedAt),
          isNull(s.contracts.terminatedOn),
          isNull(s.contracts.validTo),
        ),
      )
      .limit(1);
    if (open) {
      const status = open.signedAt ? "signerat" : open.sentAt ? "skickat" : "utkast";
      throw new ContractError(
        `${store.name} har redan ett avtal (${status}). Öppna det under Avtal.`,
      );
    }

    const existing = await tx
      .select({
        id: s.storeAgreements.id,
        validFrom: s.storeAgreements.validFrom,
        validTo: s.storeAgreements.validTo,
        monthlyRentOre: s.storeAgreements.monthlyRentOre,
      })
      .from(s.storeAgreements)
      .where(
        and(eq(s.storeAgreements.organizationId, orgId), eq(s.storeAgreements.storeId, storeId)),
      );
    const plan = planContractAgreement(existing, input.validFrom);
    if (plan.kind === "conflict") {
      throw new ContractError(
        `Butiken har villkor från ${dateText(plan.validFrom)} som krockar. Välj en startdag efter dem eller ändra dem under Butiker.`,
      );
    }

    const contractId = randomUUID();
    // Villkor som skrivs om samma dag behåller sin hyra; avtalet skriver ut den.
    const keptRent =
      plan.kind === "update"
        ? (existing.find((a) => a.id === plan.id)?.monthlyRentOre ?? null)
        : null;
    const monthlyRentOre = keptRent !== null && keptRent > 0 ? keptRent : null;
    const terms = {
      shareBp: DEFAULT_PROFIT_SHARE_BP,
      lossTreatment: "zero" as const,
      monthlyRentOre,
    };
    await tx.insert(s.contracts).values({
      id: contractId,
      organizationId: orgId,
      storeId,
      title: "Placeringsavtal",
      validFrom: input.validFrom,
      validTo: null,
      noticePeriodMonths: CONTRACT_NOTICE_MONTHS,
      terms: contractTermsSummary(terms),
      template: CONTRACT_TEMPLATE,
    });

    const agreement = {
      commissionBp: terms.shareBp,
      commissionBase: "profit_after_costs" as const,
      lossTreatment: terms.lossTreatment,
      monthlyRentOre,
      contractId,
      note: "Enligt placeringsavtal (mall)",
    };
    if (plan.kind === "update") {
      await tx
        .update(s.storeAgreements)
        .set(agreement)
        .where(and(eq(s.storeAgreements.organizationId, orgId), eq(s.storeAgreements.id, plan.id)));
    } else {
      if (plan.close) {
        await tx
          .update(s.storeAgreements)
          .set({ validTo: plan.close.validTo })
          .where(
            and(
              eq(s.storeAgreements.organizationId, orgId),
              eq(s.storeAgreements.id, plan.close.id),
            ),
          );
      }
      await tx.insert(s.storeAgreements).values({
        organizationId: orgId,
        storeId,
        validFrom: input.validFrom,
        validTo: null,
        ...agreement,
      });
    }

    const orgNumber = await readOrgNumber(tx, orgId);
    return {
      contractId,
      storeId,
      template: {
        operator: { name: viewer.organization.name, orgNumber },
        store: {
          name: store.name,
          address: store.address,
          contactName: store.contactName,
          email: store.email,
          phone: store.phone,
        },
        validFrom: input.validFrom,
        shareBp: terms.shareBp,
        lossTreatment: terms.lossTreatment,
        monthlyRentOre,
        reference: contractId.slice(0, 8).toUpperCase(),
      },
    };
  });

  let pdf = false;
  if (deps.renderPdf) {
    try {
      const bytes = await deps.renderPdf(contractHtml(prepared.template));
      const fileStore =
        typeof deps.fileStore === "function" ? await deps.fileStore() : deps.fileStore;
      await attachContractFileFor(
        viewer,
        {
          contractId: prepared.contractId,
          fileName: `Placeringsavtal ${prepared.template.store.name}.pdf`,
          bytes,
        },
        { fileStore },
      );
      pdf = true;
    } catch (error) {
      // Avtalet och villkoren är sparade; mallen kan skrivas ut från /avtal/{id}/mall.
      console.error("[avtal] PDF kunde inte skapas", prepared.contractId, error);
    }
  }
  return {
    ok: true,
    contractId: prepared.contractId,
    storeId: prepared.storeId,
    storeName: prepared.template.store.name,
    pdf,
  };
}

/** Avtalets mall som HTML (för utskrift när PDF saknas). Ägare, admin och läsare. */
export async function contractTemplateHtmlFor(viewer: Viewer, contractId: string): Promise<string> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const [c] = await tx
      .select({
        id: s.contracts.id,
        storeId: s.contracts.storeId,
        validFrom: s.contracts.validFrom,
        template: s.contracts.template,
      })
      .from(s.contracts)
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, contractId)));
    if (!c || c.template === null) throw new ContractError("Avtalet är inte skapat från mallen.");
    const [[store], [terms], orgNumber] = await Promise.all([
      tx
        .select()
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, c.storeId))),
      tx
        .select({
          commissionBp: s.storeAgreements.commissionBp,
          lossTreatment: s.storeAgreements.lossTreatment,
          monthlyRentOre: s.storeAgreements.monthlyRentOre,
        })
        .from(s.storeAgreements)
        .where(
          and(
            eq(s.storeAgreements.organizationId, orgId),
            eq(s.storeAgreements.contractId, c.id),
            eq(s.storeAgreements.commissionBase, "profit_after_costs"),
          ),
        )
        .orderBy(asc(s.storeAgreements.validFrom))
        .limit(1),
      readOrgNumber(tx, orgId),
    ]);
    if (!store) throw new ContractError("Butiken finns inte.");
    return contractHtml({
      operator: { name: viewer.organization.name, orgNumber },
      store,
      validFrom: c.validFrom,
      shareBp: terms?.commissionBp ?? DEFAULT_PROFIT_SHARE_BP,
      lossTreatment: terms?.lossTreatment ?? "zero",
      monthlyRentOre: terms?.monthlyRentOre === undefined ? null : terms.monthlyRentOre,
      reference: c.id.slice(0, 8).toUpperCase(),
    });
  });
}

/** Status per avtal från mallen (id → mall, skickat, signerat). Ägare, admin och läsare. */
export async function loadContractStatusesFor(
  viewer: Viewer,
): Promise<Map<string, { template: string | null; sentAt: Date | null; signedAt: Date | null }>> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const rows = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({
        id: s.contracts.id,
        template: s.contracts.template,
        sentAt: s.contracts.sentAt,
        signedAt: s.contracts.signedAt,
      })
      .from(s.contracts)
      .where(eq(s.contracts.organizationId, orgId)),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Sätter avtalets status. Signerat sätter också skickat (om det saknas). */
export async function setContractStatusFor(
  viewer: Viewer,
  input: { readonly id: string; readonly status: ContractStatus },
): Promise<void> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const set =
    input.status === "draft"
      ? { sentAt: null, signedAt: null }
      : input.status === "sent"
        ? { sentAt: sql`coalesce(${s.contracts.sentAt}, now())`, signedAt: null }
        : {
            sentAt: sql`coalesce(${s.contracts.sentAt}, now())`,
            signedAt: sql`coalesce(${s.contracts.signedAt}, now())`,
          };
  const rows = await withUserDbFor(viewer.user, (tx) =>
    tx
      .update(s.contracts)
      .set(set)
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, input.id)))
      .returning({ id: s.contracts.id }),
  );
  if (rows.length === 0) throw new ContractError("Avtalet finns inte.");
}
