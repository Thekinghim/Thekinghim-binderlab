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
 * 3. För varje plats räknas takten per automat och månad, exakt som bråk, med domänens
 *    regel för enhetsekonomi: belopp / automatmånader, där automatmånader = Σ dagar /
 *    dagar i kalendermånaden (en hel oktober = 1, 15 av 30 novemberdagar = 0,5). Samma
 *    automat och period ger därför samma vinst per månad och återbetalningstid här som i
 *    `compareUnitEconomics`. Vinsten är lönsamhetsvyns vinst (efter inköp, avgifter, VMB-moms,
 *    butikens andel och hyra). Anges villkor för den nya platsen (`terms`) ersätts platsens
 *    ersättning med dem (VMB-momsen på vår vinst är kvar): vinstdelning = andel × max(0,
 *    täckningsbidrag), utan VMB-avdrag som standard; med avtalets val `vmbBeforeSplit`
 *    andel × max(0, täckningsbidrag − VMB-moms), där VMB-moms = 20 % av max(0, intäkt −
 *    inköp) (förlust ger butiken 0); provision = intäkt
 *    × provisionssats; hyra = månadshyra × automatmånader. Takten per dag (belopp /
 *    automatdagar) visas också.
 * 4. Förväntat värde = snittet av platsernas takt viktat efter likhet. Intervallet är
 *    lägsta och högsta platsens takt.
 * 5. Återbetalningstid = investering / vinst per månad, i tiondels månader. Bästa fallet
 *    räknas från högsta vinsten, sämsta från lägsta. Vinst ≤ 0 → återbetalas inte (`null`).
 * 6. Avkastning per år = vinst per månad × 12 / investering, i bp (som enhetsekonomin).
 *
 * Resultatet är alltid märkt som uppskattning (`kind: 'estimate'`, texten börjar med
 * "Uppskattning").
 */

import {
  assertPeriod,
  BP_SCALE,
  MONTH_LCM,
  mulDivRound,
  vmbVatOfMargin,
  type Period,
} from "@/domain";
import { kr, pct, periodText, plural, tenths } from "../todos/text";
import {
  assertNonNegative,
  assertRateBp,
  fig,
  MONTHS_PER_YEAR,
  perMachineMonth,
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

/**
 * Avkastning per år i bp: round(vinst per månad × 12 × 10 000 / investering), samma regel
 * som i enhetsekonomins jämförelse. `null` utan investering.
 */
export function annualReturnBp(investmentOre: number, profitPerMonth: Ratio): number | null {
  assertNonNegative(investmentOre, "Investeringen");
  if (investmentOre === 0) return null;
  return profitPerMonth
    .mul(MONTHS_PER_YEAR * BP_SCALE)
    .div(investmentOre)
    .round();
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
  revenuePerMonth: Ratio;
  profitPerMonth: Ratio;
}

/**
 * Platsens takt per automatdag och per automatmånad. Med villkor: vinst = täckningsbidrag
 * − butikens andel av vinsten − intäkt × provisionssats − månadshyra × automatmånader.
 */
function siteRates(h: SiteHistory, terms: SiteTerms | null): SiteRates {
  const units = h.machineMonthUnits;
  let profit = new Ratio(h.profitOre);
  if (terms) {
    const commission = new Ratio(h.revenueOre).mul(new Ratio(terms.commissionBp ?? 0, BP_SCALE));
    const rent = new Ratio(terms.monthlyRentOre ?? 0).mul(new Ratio(units, MONTH_LCM));
    const shareBp = terms.profitShareBp ?? 0;
    let share = new Ratio(0);
    if (shareBp > 0) {
      // Samma regel som avtalet (profitSplit): VMB på platsens marginal bara när avtalet
      // drar av den före delningen (standard: nej).
      const vmb = terms.vmbBeforeSplit === true ? vmbVatOfMargin(h.revenueOre - h.costOre) : 0;
      const base = h.contributionOre - vmb;
      if (base > 0) share = new Ratio(base).mul(new Ratio(shareBp, BP_SCALE));
    }
    profit = new Ratio(h.contributionOre)
      .sub(new Ratio(h.vmbVatOre))
      .sub(share)
      .sub(commission)
      .sub(rent);
  }
  return {
    revenuePerDay: new Ratio(h.revenueOre, h.machineDays),
    profitPerDay: profit.div(h.machineDays),
    revenuePerMonth: perMachineMonth(h.revenueOre, units),
    profitPerMonth: perMachineMonth(profit, units),
  };
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
    if (terms.profitShareBp != null) assertRateBp(terms.profitShareBp, "Butikens andel");
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
    excluded.push({
      storeId,
      name: nameOf(storeId),
      scoreBp,
      reason,
      text: `${nameOf(storeId)}: ${why}`,
    });

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
    ? `butiksersättning enligt angivna villkor: ${[
        ...((terms.profitShareBp ?? 0) > 0
          ? [`${pct(terms.profitShareBp!)} av vinsten efter kostnader`]
          : []),
        ...((terms.commissionBp ?? 0) > 0 ? [`provision ${pct(terms.commissionBp!)}`] : []),
        `hyra ${kr(terms.monthlyRentOre ?? 0)} per månad`,
      ].join(", ")}`
    : "butiksersättning enligt platsernas egna avtal";
  const rule =
    "Snittet per automat och månad av de mest lika befintliga butikerna, viktat efter likhet (butikstyp, ort, öppettider, yta); intervallet är lägsta och högsta platsens takt. Per månad = belopp / aktiva automatmånader (som enhetsekonomin). Återbetalningstid = investering / vinst per månad.";

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
    rates.push({ ...r, weight: sim.scoreBp });
    basis.push({
      storeId: sim.storeId,
      name: nameOf(sim.storeId),
      similarity: sim,
      machineDays: history.machineDays,
      machineMonthsHundredths: mulDivRound(history.machineMonthUnits, 100, MONTH_LCM),
      machineIds: history.machineIds,
      revenuePerDayOre: r.revenuePerDay.round(),
      profitPerDayOre: r.profitPerDay.round(),
      revenuePerMonthOre: r.revenuePerMonth.round(),
      profitPerMonthOre: r.profitPerMonth.round(),
      paybackTenths: paybackTenths(investment, r.profitPerMonth),
    });
  }

  // 4. Viktat snitt och intervall (en plats med vikt 0 räknas lika).
  const anyWeight = rates.some((r) => r.weight > 0);
  const w = (r: { weight: number }) => (anyWeight ? r.weight : 1);
  const mean = (pick: (r: SiteRates) => Ratio) =>
    weightedMean(rates.map((r) => ({ value: pick(r), weight: w(r) })));
  const span = (pick: (r: SiteRates) => Ratio): { min: Ratio; max: Ratio } => {
    const sorted = rates.map(pick).sort((a, b) => a.compare(b));
    return { min: sorted[0]!, max: sorted[sorted.length - 1]! };
  };
  const range = (pick: (r: SiteRates) => Ratio): EstimateRange => {
    const { min, max } = span(pick);
    return { low: min.round(), expected: mean(pick).round(), high: max.round() };
  };
  const profitPerDayOre = range((r) => r.profitPerDay);
  const profitPerMonthOre = range((r) => r.profitPerMonth);
  const revenuePerMonthOre = range((r) => r.revenuePerMonth);
  const expProfitMonth = mean((r) => r.profitPerMonth);
  const { min: minProfitMonth, max: maxProfitMonth } = span((r) => r.profitPerMonth);

  // 5–6. Återbetalning och avkastning.
  const payback: PaybackRange = {
    low: paybackTenths(investment, maxProfitMonth),
    expected: paybackTenths(investment, expProfitMonth),
    high: paybackTenths(investment, minProfitMonth),
  };
  const ret = annualReturnBp(investment, expProfitMonth);
  const annual: EstimateRange | null =
    ret === null
      ? null
      : {
          low: annualReturnBp(investment, minProfitMonth)!,
          expected: ret,
          high: annualReturnBp(investment, maxProfitMonth)!,
        };

  const confidence = estimateConfidence(basis.map((b) => b.similarity.scoreBp));
  const basisNames = basis.map((b, i) =>
    i === 0
      ? `${b.name} (${pct(b.similarity.scoreBp)} lik)`
      : `${b.name} (${pct(b.similarity.scoreBp)})`,
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
      fig(
        `site:${b.storeId}:machineMonths`,
        `${b.name}: automatmånader (hundradelar)`,
        b.machineMonthsHundredths,
        "hundredths",
      ),
      fig(
        `site:${b.storeId}:profitPerMonthOre`,
        `${b.name}: vinst per månad`,
        b.profitPerMonthOre,
        "ore",
      ),
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
      orderIds: chosen.flatMap((c) => c.history.orderIds),
      dates: chosen.flatMap((c) => c.history.dates),
      figures,
    }),
  };
}
