/**
 * Uppskattning för en ny automat på en plats, utifrån liknande befintliga platser.
 *
 * Regler:
 * 1. Varje befintlig butik jämförs med målplatsen (similarity.ts).
 * 2. En butik tas med i underlaget om
 *    - den inte är uttryckligen undantagen,
 *    - den har minst `minMachineDays` automatdagar i perioden (standard 28),
 *    - högst `maxUnpricedShareBp` av dess intäkt saknar inköpspris (standard 10 %), annars
 *      blir vinsten missvisande,
 *    - likheten är minst `minScoreBp` (standard 60 %).
 *    Av dem tas de `maxSites` mest lika (standard 3; lika likhet → lägst id).
 * 3. För varje plats räknas takten per automat och dag, exakt som bråk:
 *    intäkt / automatdagar och vinst / automatdagar. Vinsten är lönsamhetsvyns vinst
 *    (efter inköp, avgifter, provision och hyra). Anges villkor för den nya platsen
 *    (`terms`) ersätts platsens provision och hyra med dem: provision = intäkt per dag ×
 *    provisionssats, hyra per dag = månadshyra × 12 / 365.
 * 4. Förväntat värde = snittet av platsernas takt viktat efter likhet. Intervallet är
 *    lägsta och högsta platsens takt. Per månad = per dag × 365 / 12.
 * 5. Återbetalningstid = investering / vinst per månad, i tiondels månader. Bästa fallet
 *    räknas från högsta vinsten, sämsta från lägsta. Vinst ≤ 0 → återbetalas inte (`null`).
 * 6. Avkastning per år = vinst per dag × 365 / investering, i bp.
 *
 * Resultatet är alltid märkt som uppskattning (`kind: 'estimate'`, texten börjar med
 * "Uppskattning").
 */

import { assertPeriod, BP_SCALE, type Period } from "@/domain";
import { kr, pct, periodText, plural, tenths } from "../todos/text";
import {
  assertNonNegative,
  assertRateBp,
  DAYS_PER_YEAR,
  fig,
  perMonth,
  Ratio,
  scenarioEvidence,
  weightedMean,
  type ScenarioFigure,
} from "./common";
import { DEFAULT_SIMILARITY_WEIGHTS, rankBySimilarity, type SimilarityWeights } from "./similarity";
import type {
  BasisSite,
  EstimateConfidence,
  EstimateRange,
  ExcludedSite,
  InvestmentPlan,
  PaybackRange,
  SiteEstimate,
  SiteHistory,
  SiteTerms,
  StoreAttributes,
  StoreProfile,
} from "./types";

/** Inställningar för urvalet av platser. */
export interface SiteEstimateOptions {
  readonly weights?: SimilarityWeights;
  /** Minsta likhet i bp. Standard 6 000 (60 %). */
  readonly minScoreBp?: number;
  /** Högst så många platser. Standard 3. */
  readonly maxSites?: number;
  /** Minsta antal automatdagar i perioden. Standard 28. */
  readonly minMachineDays?: number;
  /** Högsta andel intäkt utan inköpspris, bp. Standard 1 000 (10 %). */
  readonly maxUnpricedShareBp?: number;
  /** Butiker som inte får användas (t.ex. leadens egen butik). */
  readonly excludeStoreIds?: readonly string[];
}

/** Standardvärden för urvalet. */
export const SITE_ESTIMATE_DEFAULTS = {
  minScoreBp: 6_000,
  maxSites: 3,
  minMachineDays: 28,
  maxUnpricedShareBp: 1_000,
} as const;

/** Indata till `estimateSite`. */
export interface SiteEstimateArgs {
  readonly target: StoreAttributes;
  /** Namn på målplatsen i texterna, t.ex. "en butik som liknar Ica Nära Söder". */
  readonly targetName: string;
  /** Befintliga butiker med attribut. */
  readonly stores: readonly StoreProfile[];
  /** Historik per butik (`siteHistories`) för `period`. */
  readonly histories: readonly SiteHistory[];
  readonly period: Period;
  readonly investment: InvestmentPlan;
  readonly terms?: SiteTerms | null;
  readonly options?: SiteEstimateOptions;
}

/** Totala investeringen: automat + installation + övrigt. */
export function totalInvestment(plan: InvestmentPlan): number {
  assertNonNegative(plan.purchaseOre, "Inköpet av automaten");
  assertNonNegative(plan.installationOre, "Installationen");
  const other = plan.otherOre ?? 0;
  assertNonNegative(other, "Övrig investering");
  return plan.purchaseOre + plan.installationOre + other;
}

/**
 * Återbetalningstid i tiondels månader: round(investering × 10 / vinst per månad).
 * 0 utan investering. `null` när vinsten per månad är ≤ 0.
 */
export function paybackTenths(investmentOre: number, profitPerMonth: Ratio): number | null {
  assertNonNegative(investmentOre, "Investeringen");
  if (investmentOre === 0) return 0;
  if (profitPerMonth.sign() <= 0) return null;
  return new Ratio(investmentOre * 10).div(profitPerMonth).round();
}

/** Avkastning per år i bp: round(vinst per dag × 365 × 10 000 / investering). `null` utan investering. */
export function annualReturnBp(investmentOre: number, profitPerDay: Ratio): number | null {
  if (investmentOre === 0) return null;
  return profitPerDay.mul(DAYS_PER_YEAR * BP_SCALE).div(investmentOre).round();
}

/** Säkerhet: hög med ≥ 3 platser som alla är ≥ 80 % lika, medel med ≥ 2 och ≥ 70 %, annars låg. */
export function estimateConfidence(scores: readonly number[]): EstimateConfidence | null {
  if (scores.length === 0) return null;
  const min = Math.min(...scores);
  if (scores.length >= 3 && min >= 8_000) return "high";
  if (scores.length >= 2 && min >= 7_000) return "medium";
  return "low";
}

const CONFIDENCE_TEXT: Record<EstimateConfidence, string> = {
  high: "hög",
  medium: "medel",
  low: "låg",
};

/** "A", "A och B", "A, B och C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} och ${items[items.length - 1]}`;
}

/** Återbetalningstid som text: "7,2 månader", "7,2–14,3 månader", "inte alls". */
export function paybackText(p: PaybackRange): string {
  if (p.expected === null) return "återbetalas inte med den vinsten";
  const exp = `${tenths(p.expected)} månader`;
  if (p.low === p.expected && p.high === p.expected) return `återbetald på ${exp}`;
  const low = p.low === null ? "–" : tenths(p.low);
  const high = p.high === null ? "inte alls i sämsta fallet" : `${tenths(p.high)}`;
  if (p.high === null) return `återbetald på ${exp} (${low} i bästa fallet, ${high})`;
  return `återbetald på ${exp} (${low}–${high})`;
}

function rangeText(r: EstimateRange): string {
  if (r.low === r.high) return kr(r.expected);
  return `${kr(r.expected)} (${kr(r.low)} till ${kr(r.high)})`;
}

interface SiteRates {
  revenuePerDay: Ratio;
  profitPerDay: Ratio;
}

function siteRates(h: SiteHistory, terms: SiteTerms | null): SiteRates {
  const days = h.machineDays;
  const revenuePerDay = new Ratio(h.revenueOre, days);
  if (!terms) return { revenuePerDay, profitPerDay: new Ratio(h.profitOre, days) };
  const contribution = new Ratio(h.contributionOre, days);
  const commission = revenuePerDay.mul(new Ratio(terms.commissionBp ?? 0, BP_SCALE));
  const rent = new Ratio((terms.monthlyRentOre ?? 0) * 12, DAYS_PER_YEAR);
  return { revenuePerDay, profitPerDay: contribution.sub(commission).sub(rent) };
}

/**
 * Uppskattar intäkt, vinst, återbetalningstid och avkastning för en ny automat på en
 * plats med attributen `target`, utifrån de mest lika befintliga butikerna. Se reglerna
 * överst i filen.
 */
export function estimateSite(args: SiteEstimateArgs): SiteEstimate {
  const { target, targetName, stores, histories, period } = args;
  assertPeriod(period);
  const opts = { ...SITE_ESTIMATE_DEFAULTS, ...args.options };
  const weights = args.options?.weights ?? DEFAULT_SIMILARITY_WEIGHTS;
  assertRateBp(opts.minScoreBp, "Minsta likhet");
  assertRateBp(opts.maxUnpricedShareBp, "Högsta andel utan inköpspris");
  assertNonNegative(opts.minMachineDays, "Minsta antal automatdagar");
  assertNonNegative(opts.maxSites, "Högsta antal platser");
  const terms = args.terms ?? null;
  const attributes: StoreAttributes = {
    storeType: target.storeType,
    city: target.city,
    openHoursPerWeek: target.openHoursPerWeek,
    areaSqm: target.areaSqm,
  };
  if (terms) {
    if (terms.commissionBp !== null) assertRateBp(terms.commissionBp, "Provisionen");
    if (terms.monthlyRentOre !== null) assertNonNegative(terms.monthlyRentOre, "Hyran");
  }
  const investment = totalInvestment(args.investment);
  const excludedIds = new Set(opts.excludeStoreIds ?? []);
  const historyById = new Map(histories.map((h) => [h.storeId, h]));
  const nameById = new Map(stores.map((s) => [s.id, s.name.trim() || s.id]));
  const nameOf = (id: string) => nameById.get(id) ?? id;

  // 1–2. Rangordna och välj.
  const ranked = rankBySimilarity(
    target,
    stores.filter((s) => historyById.has(s.id)),
    weights,
  );
  const chosen: { sim: (typeof ranked)[number]; history: SiteHistory }[] = [];
  const excluded: ExcludedSite[] = [];
  const exclude = (storeId: string, scoreBp: number, reason: ExcludedSite["reason"], why: string) =>
    excluded.push({ storeId, name: nameOf(storeId), scoreBp, reason, text: `${nameOf(storeId)}: ${why}` });

  for (const sim of ranked) {
    const h = historyById.get(sim.storeId)!;
    if (excludedIds.has(sim.storeId)) {
      exclude(sim.storeId, sim.scoreBp, "excluded", "undantagen");
    } else if (h.machineDays < opts.minMachineDays) {
      exclude(
        sim.storeId,
        sim.scoreBp,
        "short-history",
        `bara ${plural(h.machineDays, "automatdag", "automatdagar")} (minst ${opts.minMachineDays})`,
      );
    } else if (h.unpricedShareBp !== null && h.unpricedShareBp > opts.maxUnpricedShareBp) {
      exclude(
        sim.storeId,
        sim.scoreBp,
        "unpriced",
        `${pct(h.unpricedShareBp)} av intäkten saknar inköpspris (högst ${pct(opts.maxUnpricedShareBp)})`,
      );
    } else if (sim.scoreBp < opts.minScoreBp) {
      exclude(
        sim.storeId,
        sim.scoreBp,
        "low-similarity",
        `${pct(sim.scoreBp)} lik (minst ${pct(opts.minScoreBp)})`,
      );
    } else if (chosen.length >= opts.maxSites) {
      exclude(
        sim.storeId,
        sim.scoreBp,
        "beyond-max",
        `${pct(sim.scoreBp)} lik, men ${opts.maxSites} mer lika platser räcker`,
      );
    } else {
      chosen.push({ sim, history: h });
    }
  }

  const investmentText = `Investering ${kr(investment)} (automat ${kr(args.investment.purchaseOre)}, installation ${kr(args.investment.installationOre)}${
    args.investment.otherOre ? `, övrigt ${kr(args.investment.otherOre)}` : ""
  })`;
  const termsText = terms
    ? `butiksersättning enligt angivna villkor: provision ${pct(terms.commissionBp ?? 0)}, hyra ${kr(terms.monthlyRentOre ?? 0)} per månad`
    : "butiksersättning enligt platsernas egna avtal";
  const rule =
    "Snittet per automat och dag av de mest lika befintliga butikerna, viktat efter likhet (butikstyp, ort, öppettider, yta); intervallet är lägsta och högsta platsens takt. Per månad = per dag × 365 / 12. Återbetalningstid = investering / vinst per månad.";

  if (chosen.length === 0) {
    const best = ranked.find((s) => !excludedIds.has(s.storeId));
    const why =
      ranked.length === 0
        ? "det finns inga befintliga butiker med historik att jämföra med"
        : `ingen befintlig butik uppfyller kraven (minst ${pct(opts.minScoreBp)} lik, minst ${opts.minMachineDays} automatdagar)`;
    return {
      kind: "estimate",
      status: "insufficient-data",
      target: attributes,
      targetName,
      period,
      basis: [],
      excluded,
      revenuePerMonthOre: null,
      profitPerMonthOre: null,
      profitPerDayOre: null,
      investmentOre: investment,
      paybackTenths: null,
      annualReturnBp: null,
      confidence: null,
      usesTerms: terms !== null,
      text: `Uppskattning saknas för ${targetName}: ${why}.`,
      detail: best
        ? `Mest lik: ${nameOf(best.storeId)}, ${pct(best.scoreBp)} (${best.text}).`
        : "Lägg till attribut (butikstyp, ort, öppettider, yta) för butikerna.",
      evidence: scenarioEvidence({
        rule,
        period,
        storeIds: excluded.map((e) => e.storeId),
        figures: [fig("investmentOre", "Investering", investment, "ore")],
      }),
    };
  }

  // 3. Takt per plats.
  const basis: BasisSite[] = [];
  const rates: (SiteRates & { weight: number })[] = [];
  for (const { sim, history } of chosen) {
    const r = siteRates(history, terms);
    const profitPerMonth = perMonth(r.profitPerDay);
    rates.push({ ...r, weight: sim.scoreBp });
    basis.push({
      storeId: sim.storeId,
      name: nameOf(sim.storeId),
      similarity: sim,
      machineDays: history.machineDays,
      machineIds: history.machineIds,
      revenuePerDayOre: r.revenuePerDay.round(),
      profitPerDayOre: r.profitPerDay.round(),
      revenuePerMonthOre: perMonth(r.revenuePerDay).round(),
      profitPerMonthOre: profitPerMonth.round(),
      paybackTenths: paybackTenths(investment, profitPerMonth),
    });
  }

  // 4. Viktat snitt och intervall (en plats med vikt 0 räknas lika).
  const anyWeight = rates.some((r) => r.weight > 0);
  const w = (r: { weight: number }) => (anyWeight ? r.weight : 1);
  const expRevenueDay = weightedMean(rates.map((r) => ({ value: r.revenuePerDay, weight: w(r) })));
  const expProfitDay = weightedMean(rates.map((r) => ({ value: r.profitPerDay, weight: w(r) })));
  const sortedProfit = [...rates].sort((a, b) => a.profitPerDay.compare(b.profitPerDay));
  const sortedRevenue = [...rates].sort((a, b) => a.revenuePerDay.compare(b.revenuePerDay));
  const minProfitDay = sortedProfit[0]!.profitPerDay;
  const maxProfitDay = sortedProfit[sortedProfit.length - 1]!.profitPerDay;

  const range = (low: Ratio, exp: Ratio, high: Ratio): EstimateRange => ({
    low: low.round(),
    expected: exp.round(),
    high: high.round(),
  });
  const profitPerDayOre = range(minProfitDay, expProfitDay, maxProfitDay);
  const profitPerMonthOre = range(
    perMonth(minProfitDay),
    perMonth(expProfitDay),
    perMonth(maxProfitDay),
  );
  const revenuePerMonthOre = range(
    perMonth(sortedRevenue[0]!.revenuePerDay),
    perMonth(expRevenueDay),
    perMonth(sortedRevenue[sortedRevenue.length - 1]!.revenuePerDay),
  );

  // 5–6. Återbetalning och avkastning.
  const payback: PaybackRange = {
    low: paybackTenths(investment, perMonth(maxProfitDay)),
    expected: paybackTenths(investment, perMonth(expProfitDay)),
    high: paybackTenths(investment, perMonth(minProfitDay)),
  };
  const ret = annualReturnBp(investment, expProfitDay);
  const annual: EstimateRange | null =
    ret === null
      ? null
      : {
          low: annualReturnBp(investment, minProfitDay)!,
          expected: ret,
          high: annualReturnBp(investment, maxProfitDay)!,
        };

  const confidence = estimateConfidence(basis.map((b) => b.similarity.scoreBp));
  const basisNames = basis.map((b, i) =>
    i === 0 ? `${b.name} (${pct(b.similarity.scoreBp)} lik)` : `${b.name} (${pct(b.similarity.scoreBp)})`,
  );
  const machineDays = basis.reduce((s, b) => s + b.machineDays, 0);
  const text = `Uppskattning för ${targetName}: ${rangeText(profitPerMonthOre)} vinst per månad, ${paybackText(payback)}. Bygger på ${listText(basisNames)}.`;
  const detail = `Snitt viktat efter likhet av ${plural(basis.length, "plats", "platser")} under ${periodText(period)} (${plural(machineDays, "automatdag", "automatdagar")}), ${termsText}. ${investmentText}. Säkerhet: ${CONFIDENCE_TEXT[confidence!]}.`;

  const figures: ScenarioFigure[] = [
    fig("profitPerMonthOre", "Vinst per månad, förväntad", profitPerMonthOre.expected, "ore"),
    fig("profitPerMonthLowOre", "Vinst per månad, lägsta", profitPerMonthOre.low, "ore"),
    fig("profitPerMonthHighOre", "Vinst per månad, högsta", profitPerMonthOre.high, "ore"),
    fig("revenuePerMonthOre", "Intäkt per månad, förväntad", revenuePerMonthOre.expected, "ore"),
    fig("investmentOre", "Investering", investment, "ore"),
  ];
  if (payback.expected !== null) {
    figures.push(
      fig("paybackTenths", "Återbetalningstid (tiondels månader)", payback.expected, "tenths"),
    );
  }
  for (const b of basis) {
    figures.push(
      fig(`site:${b.storeId}:scoreBp`, `${b.name}: likhet`, b.similarity.scoreBp, "bp"),
      fig(`site:${b.storeId}:machineDays`, `${b.name}: automatdagar`, b.machineDays, "days"),
      fig(`site:${b.storeId}:profitPerMonthOre`, `${b.name}: vinst per månad`, b.profitPerMonthOre, "ore"),
    );
  }

  return {
    kind: "estimate",
    status: "ok",
    target: attributes,
    targetName,
    period,
    basis,
    excluded,
    revenuePerMonthOre,
    profitPerMonthOre,
    profitPerDayOre,
    investmentOre: investment,
    paybackTenths: payback,
    annualReturnBp: annual,
    confidence,
    usesTerms: terms !== null,
    text,
    detail,
    evidence: scenarioEvidence({
      rule,
      period,
      storeIds: basis.map((b) => b.storeId),
      machineIds: basis.flatMap((b) => b.machineIds),
      figures,
    }),
  };
}
