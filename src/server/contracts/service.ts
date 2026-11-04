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
  type ContractParty,
  type ContractTemplateInput,
  type ContractTerms,
} from "@/reports/contract-pdf";
import { dateText } from "@/reports/text";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { attachContractFileFor } from "@/server/accounting/service";
import { queryActiveContracts } from "@/server/data/core/queries";
import type { SignableContract } from "@/analytics/contracts/signed";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";

import { readOperator, operatorGaps } from "./operator";
import {
  backdatedFrom,
  planContractAgreement,
  suggestContractStart,
  type ContractStatus,
} from "./plan";

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
   * Föreslagen startdag (suggestContractStart i ./plan): början på butikens öppna villkor,
   * annars butikens första försäljning eller placering, så att kontraktet täcker allt
   * automaten har sålt. null = i dag.
   */
  readonly suggestedFrom: IsoDate | null;
  /** Butikens första försäljning (utan testköp), eller null. */
  readonly firstSale: IsoDate | null;
  /** Butikens uppgifter som står i kontraktet (för förhandsvisningen). */
  readonly party: {
    readonly name: string;
    readonly address: string | null;
    readonly contactName: string | null;
    readonly email: string | null;
    readonly phone: string | null;
  };
}

export interface ContractSetup {
  readonly options: ContractTargetOption[];
  /** Organisationsnumret saknas (Inställningar → Företaget); avtalet får en tom rad. */
  readonly orgNumberMissing: boolean;
  /** Våra rader som blir tomma i kontraktet ("org.nr", "adress" …), tom = allt ifyllt. */
  readonly operatorGaps: string[];
  /** Vi i kontraktet (för förhandsvisningen): Inställningar → Företaget. */
  readonly operator: ContractParty;
}

/** Butikerna och platserna i pipelinen som kan få ett avtal. `today` = affärsdagen. */
export async function loadContractSetupFor(
  viewer: Viewer,
  today?: IsoDate,
): Promise<ContractSetup> {
  const orgId = viewer.organization.id;
  const day = today ?? businessToday(new Date(), viewer.organization.timezone);
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const [stores, leads, operator, contracts, openTerms, sales] = await Promise.all([
      tx
        .select({
          id: s.stores.id,
          name: s.stores.name,
          address: s.stores.address,
          contactName: s.stores.contactName,
          email: s.stores.email,
          phone: s.stores.phone,
        })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), isNull(s.stores.archivedAt)))
        .orderBy(asc(s.stores.name)),
      tx
        .select({
          id: s.expansionLeads.id,
          name: s.expansionLeads.name,
          stage: s.expansionLeads.stage,
          address: s.expansionLeads.address,
          contactName: s.expansionLeads.contactName,
          email: s.expansionLeads.contactEmail,
          phone: s.expansionLeads.contactPhone,
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
      readOperator(tx, orgId, viewer.organization.name),
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
          validTo: s.storeAgreements.validTo,
        })
        .from(s.storeAgreements)
        .where(eq(s.storeAgreements.organizationId, orgId)),
      queryStoreSales(tx, orgId),
    ]);
    const withContract = new Set(contracts.map((c) => c.storeId));
    const suggestFor = (storeId: string): IsoDate | null => {
      const own = openTerms.filter((a) => a.storeId === storeId);
      const open = own
        .filter((a) => a.validTo === null)
        .map((a) => a.validFrom as IsoDate)
        .sort()[0];
      const closedUntil = own
        .filter((a) => a.validTo !== null)
        .map((a) => a.validTo as IsoDate)
        .sort()
        .at(-1);
      const sale = sales.get(storeId);
      return suggestContractStart({
        today: day,
        openTermsFrom: open ?? null,
        closedUntil: closedUntil ?? null,
        firstSale: sale?.firstSale ?? null,
        firstPlacement: sale?.firstPlacement ?? null,
      });
    };
    // Det som väntar på ett avtal först: platser i steget Avtal eller Möte, sedan butiker
    // utan avtal, övriga platser och sist butiker som redan har ett avtal.
    const waiting = leads.filter((x) => x.stage === "agreement" || x.stage === "meeting");
    const later = leads.filter((x) => x.stage !== "agreement" && x.stage !== "meeting");
    type Row = {
      id: string;
      name: string;
      address: string | null;
      contactName: string | null;
      email: string | null;
      phone: string | null;
    };
    const party = (x: Row) => ({
      name: x.name,
      address: x.address,
      contactName: x.contactName,
      email: x.email,
      phone: x.phone,
    });
    const leadOption = (x: Row): ContractTargetOption => ({
      value: `lead:${x.id}`,
      label: `${x.name} (ny från pipelinen)`,
      suggestedFrom: null,
      firstSale: null,
      party: party(x),
    });
    const storeOption = (x: Row): ContractTargetOption => ({
      value: `store:${x.id}`,
      label: withContract.has(x.id) ? `${x.name} (har kontrakt)` : x.name,
      suggestedFrom: suggestFor(x.id),
      firstSale: sales.get(x.id)?.firstSale ?? null,
      party: party(x),
    });
    return {
      options: [
        ...waiting.map(leadOption),
        ...stores.filter((x) => !withContract.has(x.id)).map(storeOption),
        ...later.map(leadOption),
        ...stores.filter((x) => withContract.has(x.id)).map(storeOption),
      ],
      orgNumberMissing: !operator.orgNumber,
      operatorGaps: operatorGaps(operator),
      operator,
    };
  });
}

/** Butikens första försäljning (utan testköp) och första placering. */
export interface StoreSales {
  readonly firstSale: IsoDate | null;
  readonly lastSale: IsoDate | null;
  readonly firstPlacement: IsoDate | null;
}

/**
 * Första och sista försäljningsdag per butik (ordern räknas till butiken där automaten stod
 * den dagen; testköp räknas inte) och butikens första placering. En fråga för alla butiker.
 */
export async function queryStoreSales(tx: Tx, orgId: string): Promise<Map<string, StoreSales>> {
  const rows = Array.from(
    await tx.execute(sql`
      with placed as (
        select p.store_id, min(p.valid_from) as first_placement
          from public.machine_placements p
         where p.organization_id = ${orgId}::uuid
         group by p.store_id
      ), sold as (
        select p.store_id, min(o.business_date) as first_sale, max(o.business_date) as last_sale
          from public.orders o
          join public.machine_placements p
            on p.organization_id = o.organization_id
           and p.machine_id = o.machine_id
           and o.business_date >= p.valid_from
           and (p.valid_to is null or o.business_date <= p.valid_to)
         where o.organization_id = ${orgId}::uuid
           and o.test_purchase_at is null
         group by p.store_id
      )
      select placed.store_id::text as store_id, placed.first_placement::text as first_placement,
             sold.first_sale::text as first_sale, sold.last_sale::text as last_sale
        from placed left join sold using (store_id)`),
  ) as Array<Record<string, unknown>>;
  const day = (v: unknown) => (typeof v === "string" ? (v.slice(0, 10) as IsoDate) : null);
  return new Map(
    rows.map((r) => [
      String(r.store_id),
      {
        firstSale: day(r.first_sale),
        lastSale: day(r.last_sale),
        firstPlacement: day(r.first_placement),
      },
    ]),
  );
}

/** Försäljningen per butik (Kontrakt: "försäljning utan signerat kontrakt"). */
export async function loadStoreSalesFor(viewer: Viewer): Promise<Map<string, StoreSales>> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, (tx) => queryStoreSales(tx, orgId));
}

export interface CreateContractInput {
  /** "store:{id}" eller "lead:{id}". */
  readonly target: string;
  readonly validFrom: IsoDate;
  readonly confirmHistory?: boolean;
  /** Dra av VMB-moms från vinsten före delningen. Standard falskt (utan `terms`). */
  readonly vmbBeforeSplit?: boolean;
  /**
   * Villkoren ägaren valt (Skapa kontrakt, Ny butik). Utelämnat = 50 % av vinsten efter
   * kostnader, förlust ger 0, och butikens hyra behålls om villkoren skrivs om samma dag.
   */
  readonly terms?: ContractTerms;
  /** Särskilda villkor (fritext) i PDF:en. */
  readonly specialTerms?: string | null;
  /**
   * Ny butik: kontraktet börjar samma dag som butikens öppna villkor (som guiden just lagt
   * in) och skriver om dem. Bakåtdateringen är redan vald i guiden och kräver ingen ny
   * bekräftelse.
   */
  readonly fromOpenTerms?: boolean;
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
  const back = input.fromOpenTerms ? null : backdatedFrom(input.validFrom, deps.today);
  if (back && !input.confirmHistory) {
    return {
      ok: false,
      needsConfirm: true,
      message: `Kontraktet börjar ${dateText(back)}. Butikens ersättning räknas om från den dagen. Stängda månader ändras inte.`,
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
        `${store.name} har redan ett kontrakt (${status}). Öppna det under Kontrakt.`,
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
    const openTerms = input.fromOpenTerms
      ? existing
          .filter((a) => a.validTo === null)
          .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0]
      : undefined;
    const validFrom: IsoDate = (openTerms?.validFrom as IsoDate | undefined) ?? input.validFrom;
    const plan = planContractAgreement(existing, validFrom);
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
    const terms: Required<ContractTerms> = input.terms
      ? {
          shareBp: input.terms.shareBp,
          base:
            input.terms.shareBp === null
              ? "net_excl_vat"
              : (input.terms.base ?? "profit_after_costs"),
          lossTreatment: input.terms.lossTreatment,
          vmbBeforeSplit: input.terms.vmbBeforeSplit === true,
          monthlyRentOre: input.terms.monthlyRentOre,
        }
      : {
          shareBp: DEFAULT_PROFIT_SHARE_BP,
          base: "profit_after_costs",
          lossTreatment: "zero",
          vmbBeforeSplit: input.vmbBeforeSplit === true,
          monthlyRentOre: keptRent !== null && keptRent > 0 ? keptRent : null,
        };
    if (terms.shareBp === null && (terms.monthlyRentOre ?? 0) <= 0) {
      throw new ContractError("Ange andel, hyra eller båda.");
    }
    const monthlyRentOre = terms.monthlyRentOre;
    const specialTerms = input.specialTerms?.trim() ? input.specialTerms.trim() : null;
    await tx.insert(s.contracts).values({
      id: contractId,
      organizationId: orgId,
      storeId,
      title: "Placeringsavtal",
      validFrom,
      validTo: null,
      noticePeriodMonths: CONTRACT_NOTICE_MONTHS,
      terms: contractTermsSummary(terms),
      template: CONTRACT_TEMPLATE,
      specialTerms,
    });

    const agreement = {
      commissionBp: terms.shareBp,
      commissionBase: terms.base,
      lossTreatment: terms.lossTreatment,
      vmbBeforeSplit: terms.vmbBeforeSplit,
      monthlyRentOre,
      contractId,
      note: "Enligt kontraktet",
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
        validFrom,
        validTo: null,
        ...agreement,
      });
    }

    const operator = await readOperator(tx, orgId, viewer.organization.name);
    return {
      contractId,
      storeId,
      template: {
        operator,
        store: {
          name: store.name,
          address: store.address,
          contactName: store.contactName,
          email: store.email,
          phone: store.phone,
        },
        validFrom,
        shareBp: terms.shareBp,
        base: terms.base,
        lossTreatment: terms.lossTreatment,
        vmbBeforeSplit: terms.vmbBeforeSplit,
        monthlyRentOre,
        specialTerms,
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
        specialTerms: s.contracts.specialTerms,
      })
      .from(s.contracts)
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, contractId)));
    if (!c || c.template === null) throw new ContractError("Avtalet är inte skapat från mallen.");
    const [[store], [terms], operator] = await Promise.all([
      tx
        .select()
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, c.storeId))),
      tx
        .select({
          commissionBp: s.storeAgreements.commissionBp,
          commissionBase: s.storeAgreements.commissionBase,
          lossTreatment: s.storeAgreements.lossTreatment,
          vmbBeforeSplit: s.storeAgreements.vmbBeforeSplit,
          monthlyRentOre: s.storeAgreements.monthlyRentOre,
        })
        .from(s.storeAgreements)
        .where(
          and(eq(s.storeAgreements.organizationId, orgId), eq(s.storeAgreements.contractId, c.id)),
        )
        .orderBy(asc(s.storeAgreements.validFrom))
        .limit(1),
      readOperator(tx, orgId, viewer.organization.name),
    ]);
    if (!store) throw new ContractError("Butiken finns inte.");
    return contractHtml({
      operator,
      store,
      validFrom: c.validFrom,
      // Utan kopplade villkor: mallens standard (50 % av vinsten efter kostnader).
      shareBp: terms ? terms.commissionBp : DEFAULT_PROFIT_SHARE_BP,
      base: terms?.commissionBase ?? "profit_after_costs",
      lossTreatment: terms?.lossTreatment ?? "zero",
      vmbBeforeSplit: terms?.vmbBeforeSplit ?? false,
      monthlyRentOre: terms?.monthlyRentOre === undefined ? null : terms.monthlyRentOre,
      specialTerms: c.specialTerms,
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

/**
 * Kontrakten som inte är arkiverade, med mall och signering: underlaget för "har butiken
 * ett signerat kontrakt?" (@/analytics/contracts/signed). Ägare, admin och läsare.
 */
export async function loadSignableContractsFor(viewer: Viewer): Promise<SignableContract[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, (tx) => queryActiveContracts(tx, orgId));
}
