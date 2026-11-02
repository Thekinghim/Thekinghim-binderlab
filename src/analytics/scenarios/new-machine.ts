/**
 * Scenario "ny automat": vad ger en ny automat i en butik som liknar butik X?
 *
 * Målplatsen får butik X:s attribut (butikstyp, ort, öppettider, yta), eventuellt
 * justerade med `overrides`. Uppskattningen räknas med samma regler som
 * expansionspipelinen (`estimateSite`): de mest lika befintliga butikerna, viktat efter
 * likhet, med intervall, återbetalningstid och vilka platser den bygger på. Butik X är
 * själv med i underlaget om den har tillräcklig historik; den är oftast mest lik.
 */

import { DomainError, type ProfitabilityInput } from "@/domain";
import { estimateSite, type SiteEstimateOptions } from "../expansion/estimate";
import { siteHistories } from "../expansion/site-history";
import type {
  InvestmentPlan,
  SiteEstimate,
  SiteTerms,
  StoreAttributes,
  StoreProfile,
} from "../expansion/types";

/** Indata till `newMachineScenario`. */
export interface NewMachineScenarioInput {
  /** Order, priser, avtal, placeringar, inställningar och perioden som historiken räknas på. */
  readonly sources: ProfitabilityInput;
  /** Befintliga butiker med attribut. */
  readonly stores: readonly StoreProfile[];
  /** Butiken som den nya platsen liknar. */
  readonly likeStoreId: string;
  /** Attribut som skiljer den nya platsen från butik X (t.ex. en annan ort). */
  readonly overrides?: Partial<StoreAttributes>;
  /** Investering: automat + installation (+ övrigt). */
  readonly investment: InvestmentPlan;
  /** Villkor för den nya platsen. Utan dem används liknande platsers egna avtal. */
  readonly terms?: SiteTerms | null;
  readonly options?: SiteEstimateOptions;
}

/**
 * Uppskattning för en ny automat i en butik som liknar `likeStoreId`.
 * Kastar `DomainError('invalid_input')` om butiken inte finns bland `stores`.
 */
export function newMachineScenario(input: NewMachineScenarioInput): SiteEstimate {
  const like = input.stores.find((s) => s.id === input.likeStoreId);
  if (!like) {
    throw new DomainError("invalid_input", `Butiken ${input.likeStoreId} finns inte.`);
  }
  const target: StoreAttributes = {
    storeType: like.storeType,
    city: like.city,
    openHoursPerWeek: like.openHoursPerWeek,
    areaSqm: like.areaSqm,
    ...input.overrides,
  };
  const name = like.name.trim() || like.id;
  return estimateSite({
    target,
    targetName: `en butik som liknar ${name}`,
    stores: input.stores,
    histories: siteHistories(input.sources),
    period: input.sources.period,
    investment: input.investment,
    terms: input.terms ?? null,
    options: input.options,
  });
}
