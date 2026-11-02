/**
 * Expansion, enhetsekonomi och effekt: rena hjälpfunktioner mellan databasen och
 * beräkningarna i @/domain och @/analytics. Ingen I/O och inget Next, så allt testas i
 * model.test.ts.
 *
 * Här räknas ingen egen ekonomi. Det som räknas är:
 * - urval och summering av rader (investeringar per automat, snitt för en ny automat),
 * - säljunderlaget: butiksersättningen per butik kommer från domänens `storeCompensation`,
 *   automatmånaderna från `siteHistories` och takten per automatmånad från
 *   `perMachineMonth` (samma regel som enhetsekonomin),
 * - översättningar (steg i pipelinen, länkar till underlaget).
 */

import {
  perMachineMonth,
  Ratio,
  siteHistories,
  type ExpansionLead,
  type InvestmentPlan,
  type LeadStage,
  type ScenarioEvidence,
} from "@/analytics/expansion";
import {
  addDays,
  monthStart,
  MONTH_LCM,
  mulDivRound,
  roundHalfUp,
  storeCompensation,
  type IsoDate,
  type IsoMonth,
  type MachineInvestment,
  type Period,
  type ProfitabilityInput,
} from "@/domain";

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Stegen i databasen (expansion_lead_stage), i ordning. */
export const LEAD_STAGES = [
  "lead",
  "contacted",
  "meeting",
  "agreement",
  "installed",
  "lost",
] as const;
export type LeadStageKey = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABEL: Record<LeadStageKey, string> = {
  lead: "Lead",
  contacted: "Kontaktad",
  meeting: "Möte",
  agreement: "Avtal",
  installed: "Installerad",
  lost: "Förlorad",
};

/** Öppna steg (räknas i pipelinen). Installerad och förlorad är avslutade. */
export const OPEN_STAGES: readonly LeadStageKey[] = ["lead", "contacted", "meeting", "agreement"];

/**
 * Stegen i analysens pipeline (`@/analytics/expansion`): lead → idea, kontaktad →
 * contacted, möte → negotiating, avtal och installerad → signed, förlorad → rejected
 * (räknas inte).
 */
export function analyticsStage(stage: LeadStageKey): LeadStage {
  switch (stage) {
    case "lead":
      return "idea";
    case "contacted":
      return "contacted";
    case "meeting":
      return "negotiating";
    case "agreement":
    case "installed":
      return "signed";
    case "lost":
      return "rejected";
  }
}

/** En lead som den lagras (belopp i öre, andelar i bp). */
export interface LeadRecord {
  readonly id: string;
  readonly name: string;
  readonly stage: LeadStageKey;
  readonly stageChangedAt: string;
  readonly storeType: string | null;
  readonly city: string | null;
  readonly openHoursPerWeek: number | null;
  readonly areaSqm: number | null;
  readonly address: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly notes: string | null;
  readonly nextStep: string | null;
  readonly nextStepOn: IsoDate | null;
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
  readonly purchaseOre: number | null;
  readonly installationOre: number | null;
  readonly storeId: string | null;
  readonly archived: boolean;
}

/** Leadens investering, eller null om ingen del är angiven (standardinvesteringen gäller då). */
export function leadInvestment(lead: LeadRecord): InvestmentPlan | null {
  if (lead.purchaseOre === null && lead.installationOre === null) return null;
  return { purchaseOre: lead.purchaseOre ?? 0, installationOre: lead.installationOre ?? 0 };
}

/** Leaden i analysens form. Villkor används bara när minst ett av dem är angivet. */
export function toAnalyticsLead(lead: LeadRecord): ExpansionLead {
  const terms =
    lead.commissionBp === null && lead.monthlyRentOre === null
      ? null
      : { commissionBp: lead.commissionBp, monthlyRentOre: lead.monthlyRentOre };
  const investment = leadInvestment(lead);
  return {
    id: lead.id,
    name: lead.name,
    stage: analyticsStage(lead.stage),
    storeType: lead.storeType,
    city: lead.city,
    openHoursPerWeek: lead.openHoursPerWeek,
    areaSqm: lead.areaSqm,
    terms,
    storeId: lead.storeId,
    ...(investment ? { investment } : {}),
  };
}

// ---------------------------------------------------------------------------
// Investeringar
// ---------------------------------------------------------------------------

/** Standardinvestering för en ny automat: snittet av befintliga automaters investering. */
export interface DefaultInvestment {
  readonly plan: InvestmentPlan;
  /** Automater som snittet bygger på. */
  readonly machineIds: string[];
  readonly totalOre: number;
}

/**
 * Snittet per automat av registrerade investeringar: inköp (inklusive övrigt) och
 * installation var för sig, avrundat till helt öre. `null` när ingen automat har en
 * investering. Bara investeringar med datum senast `asOf` räknas.
 */
export function defaultInvestment(
  investments: readonly MachineInvestment[],
  asOf: IsoDate,
): DefaultInvestment | null {
  const per = new Map<string, { purchase: number; installation: number }>();
  for (const inv of investments) {
    if (inv.date > asOf) continue;
    const m = per.get(inv.machineId) ?? { purchase: 0, installation: 0 };
    if (inv.kind === "installation") m.installation += inv.amountOre;
    else m.purchase += inv.amountOre;
    per.set(inv.machineId, m);
  }
  const ids = [...per.keys()].sort();
  if (ids.length === 0) return null;
  let purchase = 0;
  let installation = 0;
  for (const id of ids) {
    purchase += per.get(id)!.purchase;
    installation += per.get(id)!.installation;
  }
  const plan = {
    purchaseOre: roundHalfUp(purchase, ids.length),
    installationOre: roundHalfUp(installation, ids.length),
  };
  return { plan, machineIds: ids, totalOre: plan.purchaseOre + plan.installationOre };
}

// ---------------------------------------------------------------------------
// Säljunderlag
// ---------------------------------------------------------------------------

/** Minsta antal butiker för att snittet ska visas (annars går en enskild butik att räkna ut). */
export const SALES_DECK_MIN_STORES = 3;

export interface SalesDeck {
  readonly status: "ok" | "too-few-stores";
  readonly period: Period;
  /** Butiker med minst en automat placerad i perioden. */
  readonly stores: number;
  readonly machineMonthsHundredths: number;
  /** Butiksersättning (provision + hyra) per automat och månad. null när snittet inte visas. */
  readonly compensationPerMonthOre: number | null;
  readonly commissionPerMonthOre: number | null;
  readonly rentPerMonthOre: number | null;
  /** Försäljning (nettointäkt, alla order) per automat och månad. */
  readonly salesPerMonthOre: number | null;
  /** Ersättningen per år = per månad × 12. */
  readonly compensationPerYearOre: number | null;
  /** Andel av försäljningen som går till butiken, bp. */
  readonly compensationShareBp: number | null;
}

/**
 * Vad partnerbutikerna tjänar i snitt per automat och månad, anonymiserat. Bara butiker
 * där minst en automat stod under perioden räknas. Färre än `minStores` butiker → inga
 * belopp (`too-few-stores`), så att ingen enskild butiks ersättning kan räknas ut.
 *
 * Ersättningen per butik är domänens `storeCompensation` (provision på alla order +
 * hyra), automatmånaderna är enhetsekonomins aktiva månader (`siteHistories`), och
 * snittet är Σ ersättning / Σ automatmånader (`perMachineMonth`), avrundat en gång.
 */
export function salesDeck(input: ProfitabilityInput, minStores = SALES_DECK_MIN_STORES): SalesDeck {
  const histories = siteHistories(input).filter((h) => h.machineMonthUnits > 0);
  const ids = new Set(histories.map((h) => h.storeId));
  const comp = storeCompensation(input).stores.filter((s) => ids.has(s.storeId));
  let units = 0;
  let sales = 0;
  for (const h of histories) {
    units += h.machineMonthUnits;
    sales += h.revenueOre + h.unpricedRevenueOre;
  }
  let commission = 0;
  let rent = 0;
  for (const c of comp) {
    commission += c.commissionOre;
    rent += c.rentOre;
  }
  const machineMonthsHundredths = mulDivRound(units, 100, MONTH_LCM);
  const base = {
    period: input.period,
    stores: histories.length,
    machineMonthsHundredths,
  };
  if (histories.length < minStores || units === 0) {
    return {
      ...base,
      status: "too-few-stores",
      compensationPerMonthOre: null,
      commissionPerMonthOre: null,
      rentPerMonthOre: null,
      salesPerMonthOre: null,
      compensationPerYearOre: null,
      compensationShareBp: null,
    };
  }
  const perMonth = (v: number) => perMachineMonth(new Ratio(v), units);
  const total = perMonth(commission + rent);
  return {
    ...base,
    status: "ok",
    compensationPerMonthOre: total.round(),
    commissionPerMonthOre: perMonth(commission).round(),
    rentPerMonthOre: perMonth(rent).round(),
    salesPerMonthOre: perMonth(sales).round(),
    compensationPerYearOre: total.mul(12).round(),
    compensationShareBp: sales === 0 ? null : roundHalfUp((commission + rent) * 10_000, sales),
  };
}

// ---------------------------------------------------------------------------
// Månader och perioder
// ---------------------------------------------------------------------------

/** 'ÅÅÅÅ-MM' för ett datum. */
export function monthOfDate(date: IsoDate): IsoMonth {
  return date.slice(0, 7) as IsoMonth;
}

/** Månaderna som perioden berör, i ordning. */
export function monthsIn(period: Period): IsoMonth[] {
  const out: IsoMonth[] = [];
  let m = monthOfDate(period.start);
  const last = monthOfDate(period.end);
  while (m <= last) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = (mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`) as IsoMonth;
  }
  return out;
}

/** Hela månader som perioden berör, som en period (1:a i första till sista i sista). */
export function wholeMonths(period: Period): Period {
  const months = monthsIn(period);
  const last = months[months.length - 1]!;
  const [y, m] = last.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: monthStart(months[0]!), end: addDays(next, -1) };
}

/** 'ÅÅÅÅ-MM' → 'ÅÅÅÅ-MM-01' (formatet i goals.month och effect_measurements.month). */
export function monthToDate(month: IsoMonth): IsoDate {
  return `${month}-01`;
}

// ---------------------------------------------------------------------------
// Underlag
// ---------------------------------------------------------------------------

/** En länk till underlaget i panelen. */
export interface EvidenceLink {
  readonly label: string;
  readonly href: string;
}

function lonsamhet(period: Period | null, params: Record<string, string>): string {
  const q = new URLSearchParams();
  if (period) {
    q.set("from", period.start);
    q.set("to", period.end);
  }
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  const s = q.toString();
  return s ? `/lonsamhet?${s}` : "/lonsamhet";
}

/**
 * Länkar från ett underlag till Lönsamhet för samma period: en per butik och automat
 * (högst `max` av varje), och en till hela perioden per dag när underlaget bygger på order.
 */
export function evidenceLinks(
  evidence: ScenarioEvidence,
  names: { stores: (id: string) => string; machines: (id: string) => string },
  max = 6,
): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  const period = evidence.period ?? null;
  for (const id of evidence.storeIds.slice(0, max)) {
    links.push({
      label: names.stores(id),
      href: lonsamhet(period, { butik: id, grupp: "automat" }),
    });
  }
  for (const id of evidence.machineIds.slice(0, max)) {
    links.push({
      label: names.machines(id),
      href: lonsamhet(period, { automat: id, grupp: "titel" }),
    });
  }
  if (evidence.orderIds.length > 0 && period) {
    links.push({ label: "Per dag", href: lonsamhet(period, { grupp: "dag" }) });
  }
  return links;
}
