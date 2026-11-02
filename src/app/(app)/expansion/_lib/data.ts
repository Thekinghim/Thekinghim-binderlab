/**
 * Sidornas data: läser via de gemensamma laddarna (withUserDb, RLS) och ./service, och
 * räknar med @/domain och @/analytics. Ingen egen ekonomi här: bara urval av indata och
 * anrop till beräkningarna. Allt som returneras är serialiserbart (går till
 * klientkomponenter).
 */

import "server-only";

import {
  compareUnitEconomics,
  expansionPipeline,
  siteHistories,
  type LeadPotential,
  type SiteEstimate,
  type StoreProfile,
  type UnitEconomicsComparison,
} from "@/analytics/expansion";
import { binderlabEffect, type EffectSeries } from "@/analytics/effect";
import { goalProgress, type GoalProgress } from "@/analytics/goals";
import {
  newMachineScenario,
  priceChangeScenario,
  type PriceChangeScenario,
} from "@/analytics/scenarios";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { toURLSearchParams } from "@/components/shell/period-state";
import {
  addDays,
  maxDate,
  minDate,
  monthEnd,
  monthStart,
  type IsoDate,
  type IsoMonth,
  type MachineUnitEconomics,
  type Period,
} from "@/domain";
import { unitEconomics } from "@/domain";
import { parseAmountOre } from "@/import/amount";
import {
  loadDomainInput,
  loadPeriod,
  requireRoute,
  type AppContext,
  type AppPeriod,
} from "@/server/data/core";

import {
  clipToData,
  defaultInvestment,
  OPEN_STAGES,
  placementsFromData,
  salesDeck,
  toAnalyticsLead,
  wholeMonths,
  monthOfDate,
  monthsIn,
  type DataPeriod,
  type DefaultInvestment,
  type LeadRecord,
  type SalesDeck,
} from "./model";
import { parseHundredths, parseSignedOre } from "./schemas";
import {
  loadBaselinesFor,
  loadEffectSettingsFor,
  loadGoalsFor,
  loadInvestmentsFor,
  loadLeadsFor,
  loadMeasurementsFor,
  loadStoreProfilesFor,
  type BaselineRecord,
  type EffectSettingsRecord,
  type GoalRecord,
  type InvestmentRecord,
  type MeasurementRecord,
  type StoreProfileRecord,
} from "./service";
import { currentViewer } from "./session";

/** Namn och kod för val och tabeller. */
export interface Named {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly archived: boolean;
}

export interface Names {
  readonly stores: Named[];
  readonly machines: Named[];
  readonly titles: Named[];
}

/**
 * Perioden sidan räknar på: skalets period, klippt till första ordern (dagar före första
 * ordern saknar data och ska inte räknas som dagar utan försäljning). `requested` är
 * skalets period och `clippedFrom` första ordern när perioden klipptes.
 */
export interface PeriodInfo {
  readonly key: string;
  readonly period: Period;
  readonly days: number;
  readonly requested: Period;
  readonly clippedFrom: IsoDate | null;
}

function dataPeriodOf(p: AppPeriod): DataPeriod {
  return clipToData(p.period, p.dataStart);
}

function periodLabelInfo(p: AppPeriod, dp: DataPeriod = dataPeriodOf(p)): PeriodInfo {
  return {
    key: p.key,
    period: dp.period,
    days: dp.days,
    requested: p.period,
    clippedFrom: dp.clippedFrom,
  };
}

// ---------------------------------------------------------------------------
// Enhetsekonomi
// ---------------------------------------------------------------------------

export interface UnitEconomicsPageData {
  readonly ctx: Pick<AppContext, "canEdit" | "today">;
  readonly period: PeriodInfo;
  readonly comparison: UnitEconomicsComparison;
  /** Domänens enhetsekonomi per automat (avskrivning, bokfört värde). */
  readonly units: MachineUnitEconomics[];
  readonly investments: InvestmentRecord[];
  readonly names: Names;
  /** Automater i filtret. */
  readonly machineIds: string[];
}

export async function loadUnitEconomicsPage(sp: SearchParamsInput): Promise<UnitEconomicsPageData> {
  const ctx = await requireRoute("automater");
  const p = await loadPeriod(sp);
  const dp = dataPeriodOf(p);
  const viewer = await currentViewer();
  const [input, investments] = await Promise.all([
    loadDomainInput({ period: dp.period, ...p.scope }),
    loadInvestmentsFor(viewer),
  ]);
  const inScope = new Set<string>(input.current.placements.map((pl) => pl.machineId));
  if (p.scope.machineId) inScope.add(p.scope.machineId);
  if (!p.scope.storeId && !p.scope.machineId) {
    for (const m of input.machines) if (!m.archived) inScope.add(m.id);
  }
  const machineIds = [...inScope].sort();
  const ueInput = { ...input.current, investments: input.investments, machineIds };
  const comparison = compareUnitEconomics(
    ueInput,
    input.machines.map((m) => ({ id: m.id, name: m.name })),
  );
  return {
    ctx: { canEdit: ctx.canEdit, today: ctx.today },
    period: periodLabelInfo(p, dp),
    comparison,
    units: unitEconomics(ueInput),
    investments: investments.filter((i) => inScope.has(i.machineId)),
    names: namesOf(input),
    machineIds,
  };
}

function namesOf(input: {
  stores: readonly { id: string; name: string; archived: boolean }[];
  machines: readonly { id: string; name: string; code: string; archived: boolean }[];
  titles: readonly { id: string; name: string; archived: boolean }[];
}): Names {
  return {
    stores: input.stores.map((s) => ({ id: s.id, name: s.name, archived: s.archived })),
    machines: input.machines.map((m) => ({
      id: m.id,
      name: m.name,
      code: m.code,
      archived: m.archived,
    })),
    titles: input.titles.map((t) => ({ id: t.id, name: t.name, archived: t.archived })),
  };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** Scenariernas val, ur URL:en (?lik= &inkop= &installation= &provision= &hyra= …). */
export interface ScenarioParams {
  readonly likeStoreId: string | null;
  readonly purchase: string;
  readonly installation: string;
  readonly commission: string;
  readonly rent: string;
  readonly titleId: string | null;
  readonly delta: string;
  readonly elasticity: string;
}

export function scenarioParams(sp: SearchParamsInput): ScenarioParams {
  const q = toURLSearchParams(sp);
  const get = (k: string) => (q.get(k) ?? "").trim().slice(0, 40);
  return {
    likeStoreId: get("lik") || null,
    purchase: get("inkop"),
    installation: get("installation"),
    commission: get("provision"),
    rent: get("hyra"),
    titleId: get("titel") || null,
    delta: get("andring"),
    elasticity: get("elasticitet"),
  };
}

export interface ScenarioInputError {
  readonly field: string;
  readonly message: string;
}

export interface ExpansionPageData {
  readonly ctx: Pick<AppContext, "canEdit" | "today">;
  readonly period: PeriodInfo;
  readonly names: Names;
  readonly profiles: StoreProfileRecord[];
  readonly defaultInvestment: DefaultInvestment | null;
  readonly params: ScenarioParams;
  readonly newMachine: {
    readonly likeStoreId: string | null;
    readonly estimate: SiteEstimate | null;
    readonly errors: ScenarioInputError[];
  };
  readonly price: {
    readonly titleId: string | null;
    readonly deltaOre: number;
    readonly elasticityHundredths: number;
    readonly scenario: PriceChangeScenario | null;
    readonly errors: ScenarioInputError[];
  };
  readonly goals: { readonly records: GoalRecord[]; readonly progress: GoalProgress[] };
  readonly leads: LeadRecord[];
  readonly pipeline: LeadPotential[];
  readonly deck: SalesDeck;
}

const DEFAULT_DELTA_ORE = 500;

/** Elasticitet som text ("-1,5", "−0,5", "0") → hundradelar. */
function parseElasticity(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  const neg = /^[-−]/.test(t);
  const h = parseHundredths(t.replace(/^[-+−]/, ""));
  if (h === null || h > 1000) return null;
  return neg ? -h : h;
}

export async function loadExpansionPage(sp: SearchParamsInput): Promise<ExpansionPageData> {
  const ctx = await requireRoute("expansion");
  const p = await loadPeriod(sp);
  const dp = dataPeriodOf(p);
  const viewer = await currentViewer();
  const params = scenarioParams(sp);

  // Hela flottan: expansionen jämför alla platser, oavsett filter i skalet.
  const [input, profiles, goals, leads] = await Promise.all([
    loadDomainInput({ period: dp.period }),
    loadStoreProfilesFor(viewer),
    loadGoalsFor(viewer),
    loadLeadsFor(viewer),
  ]);
  const stores: StoreProfile[] = profiles
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      name: s.name,
      storeType: s.storeType,
      city: s.city,
      openHoursPerWeek: s.openHoursPerWeek,
      areaSqm: s.areaSqm,
    }));
  const histories = siteHistories(input.current);
  const defInv = defaultInvestment(input.investments, ctx.today);

  // Scenario: ny automat i en butik som liknar X. Standard: butiken med mest vinst.
  const nmErrors: ScenarioInputError[] = [];
  const bestStore = [...histories]
    .filter((h) => stores.some((s) => s.id === h.storeId))
    .sort((a, b) => b.profitOre - a.profitOre)[0]?.storeId;
  const likeStoreId =
    params.likeStoreId && stores.some((s) => s.id === params.likeStoreId)
      ? params.likeStoreId
      : (bestStore ?? stores[0]?.id ?? null);
  const money = (text: string, field: string, label: string, fallback: number | null) => {
    if (text === "") return fallback;
    const r = parseAmountOre(text);
    if (!r.ok) {
      nmErrors.push({ field, message: `${label}: ${r.message}` });
      return fallback;
    }
    return r.ore;
  };
  const purchase = money(params.purchase, "inkop", "Automat", defInv?.plan.purchaseOre ?? null);
  const installation = money(
    params.installation,
    "installation",
    "Installation",
    defInv?.plan.installationOre ?? null,
  );
  let commissionBp: number | null = null;
  if (params.commission !== "") {
    const h = parseHundredths(params.commission);
    if (h === null || h > 10_000) {
      nmErrors.push({
        field: "provision",
        message: "Provision: ange en procentsats mellan 0 och 100.",
      });
    } else commissionBp = h;
  }
  const rentOre = money(params.rent, "hyra", "Hyra", null);
  const terms =
    commissionBp === null && rentOre === null ? null : { commissionBp, monthlyRentOre: rentOre };
  const estimate =
    likeStoreId && purchase !== null && installation !== null
      ? newMachineScenario({
          sources: input.current,
          stores,
          likeStoreId,
          investment: { purchaseOre: purchase, installationOre: installation },
          terms,
        })
      : null;

  // Scenario: prisändring. Standard: titeln med flest sålda pack, +5 kr.
  const priceErrors: ScenarioInputError[] = [];
  const counts = new Map<string, number>();
  for (const o of input.current.orders) counts.set(o.titleId, (counts.get(o.titleId) ?? 0) + 1);
  const topTitle = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )[0]?.[0];
  const titleId =
    params.titleId && input.titles.some((t) => t.id === params.titleId)
      ? params.titleId
      : (topTitle ?? null);
  let deltaOre = DEFAULT_DELTA_ORE;
  if (params.delta !== "") {
    const d = parseSignedOre(params.delta);
    if (d === null)
      priceErrors.push({ field: "andring", message: "Ändring: ange kronor, t.ex. 5 eller −2,50." });
    else deltaOre = d;
  }
  let elasticity = 0;
  const e = parseElasticity(params.elasticity);
  if (e === null) {
    priceErrors.push({
      field: "elasticitet",
      message: "Elasticitet: ange ett tal mellan −10 och 10, t.ex. −1,5.",
    });
  } else elasticity = e;
  let scenario: PriceChangeScenario | null = null;
  if (titleId) {
    try {
      scenario = priceChangeScenario({
        ...input.current,
        titleId,
        titleName: input.titles.find((t) => t.id === titleId)?.name,
        deltaOre,
        elasticityHundredths: elasticity,
      });
    } catch (error) {
      priceErrors.push({
        field: "andring",
        message: error instanceof Error ? error.message : "Scenariot kunde inte räknas.",
      });
    }
  }

  // Mål: utfall och prognos för månaderna som har mål.
  const progress = await goalsProgress(goals, ctx.today, stores, input.machines);

  // Pipeline: öppna platser rangordnade efter uppskattad återbetalningstid.
  const open = leads.filter((l) => !l.archived && OPEN_STAGES.includes(l.stage));
  const pipeline = expansionPipeline({
    leads: open.map(toAnalyticsLead),
    stores,
    histories,
    period: input.current.period,
    defaultInvestment: defInv?.plan ?? { purchaseOre: 0, installationOre: 0 },
  });

  return {
    ctx: { canEdit: ctx.canEdit, today: ctx.today },
    period: periodLabelInfo(p, dp),
    names: namesOf(input),
    profiles,
    defaultInvestment: defInv,
    params,
    newMachine: { likeStoreId, estimate, errors: nmErrors },
    price: { titleId, deltaOre, elasticityHundredths: elasticity, scenario, errors: priceErrors },
    goals: { records: goals, progress },
    leads,
    pipeline,
    deck: salesDeck(input.current),
  };
}

/** Utfall och prognos per mål (laddar order för målens månader och 28 dagar bakåt). */
async function goalsProgress(
  goals: readonly GoalRecord[],
  today: IsoDate,
  stores: readonly { id: string; name: string }[],
  machines: readonly { id: string; name: string }[],
): Promise<GoalProgress[]> {
  if (goals.length === 0) return [];
  let start: IsoDate = addDays(today, -27);
  let end: IsoDate = today;
  for (const g of goals) {
    start = minDate(start, monthStart(g.month as IsoMonth));
    end = maxDate(end, monthEnd(g.month as IsoMonth));
  }
  const input = await loadDomainInput({ period: { start, end: minDate(end, today) } });
  return goalProgress({
    ...input.current,
    goals: goals.map((g) => ({
      id: g.id,
      month: g.month as IsoMonth,
      metric: g.metric,
      target: g.target,
      scope: g.scope,
      storeId: g.storeId,
      machineId: g.machineId,
    })),
    asOf: today,
    stores,
    machines,
  });
}

// ---------------------------------------------------------------------------
// Säljunderlag
// ---------------------------------------------------------------------------

export interface SalesDeckPageData {
  readonly organizationName: string;
  readonly period: Period;
  /** Första ordern, när skalets period började före den (perioden är då klippt dit). */
  readonly clippedFrom: IsoDate | null;
  readonly deck: SalesDeck;
  readonly generatedAt: string;
}

export async function loadSalesDeckPage(sp: SearchParamsInput): Promise<SalesDeckPageData> {
  const ctx = await requireRoute("expansion");
  const p = await loadPeriod(sp);
  const dp = dataPeriodOf(p);
  const input = await loadDomainInput({ period: dp.period });
  return {
    organizationName: ctx.organization.name,
    period: dp.period,
    clippedFrom: dp.clippedFrom,
    deck: salesDeck(input.current),
    generatedAt: ctx.now,
  };
}

// ---------------------------------------------------------------------------
// Effekt
// ---------------------------------------------------------------------------

/** Högst så många månader i effektvyn. */
export const EFFECT_MAX_MONTHS = 24;

export interface EffectPageData {
  readonly ctx: Pick<AppContext, "canEdit" | "today">;
  readonly period: PeriodInfo;
  readonly months: IsoMonth[];
  /**
   * Första ordern när den ligger mitt i en av månaderna: den månadens automatdagar räknas
   * från första ordern (sidan skriver det i en mono-rad). Annars null.
   */
  readonly dataStartInMonth: IsoDate | null;
  readonly baselines: BaselineRecord[];
  readonly measurements: MeasurementRecord[];
  readonly settings: EffectSettingsRecord;
  readonly series: EffectSeries[];
  readonly names: Names;
}

export async function loadEffectPage(sp: SearchParamsInput): Promise<EffectPageData> {
  const ctx = await requireRoute("effekt");
  const p = await loadPeriod(sp);
  const dp = dataPeriodOf(p);
  const viewer = await currentViewer();
  // Månader från första ordern; dagarna före den räknas inte som automatdagar.
  const months = monthsIn(dp.period).slice(-EFFECT_MAX_MONTHS);
  const span = wholeMonths({ start: monthStart(months[0]!), end: p.period.end });
  const [input, baselines, measurements, settings] = await Promise.all([
    loadDomainInput({ period: { start: span.start, end: minDate(span.end, ctx.today) } }),
    loadBaselinesFor(viewer),
    loadMeasurementsFor(viewer),
    loadEffectSettingsFor(viewer),
  ]);
  const series = binderlabEffect({
    ...input.current,
    placements: placementsFromData(input.current.placements, p.dataStart),
    baselines: baselines.map((b) => ({
      id: b.id,
      metric: b.metric,
      value: b.value,
      unit: b.unit,
      scope: b.scope,
      storeId: b.storeId,
      machineId: b.machineId,
      measuredPeriod:
        b.measuredFrom && b.measuredTo ? { start: b.measuredFrom, end: b.measuredTo } : null,
      source: b.source,
    })),
    observations: measurements.map((m) => ({
      metric: m.metric,
      month: m.month as IsoMonth,
      value: m.value,
      scope: m.scope,
      storeId: m.storeId,
      machineId: m.machineId,
    })),
    months,
    asOf: ctx.today,
    stores: input.stores,
    machines: input.machines,
    options: {
      hourlyCostOre: settings.hourlyCostOre,
      stockoutDayValueOre: settings.stockoutDayValueOre,
    },
  });
  return {
    ctx: { canEdit: ctx.canEdit, today: ctx.today },
    period: periodLabelInfo(p, dp),
    months,
    dataStartInMonth:
      p.dataStart !== null &&
      months.includes(monthOfDate(p.dataStart)) &&
      p.dataStart > monthStart(monthOfDate(p.dataStart))
        ? p.dataStart
        : null,
    baselines,
    measurements,
    settings,
    series,
    names: namesOf(input),
  };
}
