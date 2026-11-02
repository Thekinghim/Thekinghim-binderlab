/**
 * Expansionspipeline: potential per tänkbar plats (lead), uppskattad från liknande
 * befintliga platser med samma regler som scenariot "ny automat" (estimate.ts).
 *
 * Sortering (bäst först):
 * 1. leads med uppskattning före leads utan underlag,
 * 2. kortast förväntad återbetalningstid (en lead som inte återbetalas kommer sist bland dem med uppskattning),
 * 3. högst förväntad vinst per månad,
 * 4. leadens id.
 */

import { DomainError, type Period, type ProfitabilityInput } from "@/domain";
import { estimateSite, type SiteEstimateOptions } from "./estimate";
import { siteHistories } from "./site-history";
import type {
  InvestmentPlan,
  SiteEstimate,
  SiteHistory,
  SiteTerms,
  StoreAttributes,
  StoreProfile,
} from "./types";

/** Var i processen en lead är. */
export type LeadStage = "idea" | "contacted" | "negotiating" | "signed" | "rejected";

/** En tänkbar plats. */
export interface ExpansionLead extends StoreAttributes {
  readonly id: string;
  readonly name: string;
  readonly stage?: LeadStage;
  /** Leadens egen investering. Saknas den används pipelinens standardinvestering. */
  readonly investment?: InvestmentPlan;
  /** Erbjudna eller förhandlade villkor. Saknas de används liknande platsers egna avtal. */
  readonly terms?: SiteTerms | null;
  /** Befintlig butik som leaden gäller (t.ex. en andra automat). Den används inte som underlag. */
  readonly storeId?: string | null;
}

/** En lead med uppskattning. */
export interface LeadPotential {
  readonly leadId: string;
  readonly name: string;
  readonly stage: LeadStage | null;
  /** 1 = bäst. */
  readonly rank: number;
  readonly estimate: SiteEstimate;
}

/** Indata till `expansionPipeline`. */
export interface ExpansionPipelineInput {
  readonly leads: readonly ExpansionLead[];
  /** Befintliga butiker med attribut. */
  readonly stores: readonly StoreProfile[];
  /** Historik per butik. Anges den inte räknas den från `sources`. */
  readonly histories?: readonly SiteHistory[];
  /** Order och avtal för perioden (behövs om `histories` saknas). */
  readonly sources?: ProfitabilityInput;
  readonly period: Period;
  /** Investering för leads som saknar egen. */
  readonly defaultInvestment: InvestmentPlan;
  readonly options?: SiteEstimateOptions;
  /** Ta med leads i steget 'rejected'. Standard: nej. */
  readonly includeRejected?: boolean;
}

function compareLeads(
  a: { lead: ExpansionLead; estimate: SiteEstimate },
  b: { lead: ExpansionLead; estimate: SiteEstimate },
): number {
  const okA = a.estimate.status === "ok";
  const okB = b.estimate.status === "ok";
  if (okA !== okB) return okA ? -1 : 1;
  if (okA && okB) {
    const pa = a.estimate.paybackTenths?.expected ?? null;
    const pb = b.estimate.paybackTenths?.expected ?? null;
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    }
    const va = a.estimate.profitPerMonthOre!.expected;
    const vb = b.estimate.profitPerMonthOre!.expected;
    if (va !== vb) return vb - va;
  }
  return a.lead.id < b.lead.id ? -1 : a.lead.id > b.lead.id ? 1 : 0;
}

/**
 * Potential per lead, rangordnad. Varje lead får en uppskattning med intervall,
 * återbetalningstid och de platser den bygger på (se `estimateSite`).
 */
export function expansionPipeline(input: ExpansionPipelineInput): LeadPotential[] {
  let histories = input.histories;
  if (!histories) {
    if (!input.sources) {
      throw new DomainError(
        "invalid_input",
        "Pipelinen behöver antingen historik per butik eller order och avtal.",
      );
    }
    histories = siteHistories({ ...input.sources, period: input.period });
  }
  const scored = input.leads
    .filter((l) => input.includeRejected || l.stage !== "rejected")
    .map((lead) => {
      const exclude = [...(input.options?.excludeStoreIds ?? [])];
      if (lead.storeId) exclude.push(lead.storeId);
      const estimate = estimateSite({
        target: lead,
        targetName: lead.name.trim() || lead.id,
        stores: input.stores,
        histories: histories,
        period: input.period,
        investment: lead.investment ?? input.defaultInvestment,
        terms: lead.terms ?? null,
        options: { ...input.options, excludeStoreIds: exclude },
      });
      return { lead, estimate };
    })
    .sort(compareLeads);
  return scored.map(({ lead, estimate }, i) => ({
    leadId: lead.id,
    name: lead.name.trim() || lead.id,
    stage: lead.stage ?? null,
    rank: i + 1,
    estimate,
  }));
}
