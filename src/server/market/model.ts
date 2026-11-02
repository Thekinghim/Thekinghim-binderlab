/**
 * Marknad: från inläst data (MarketData) till det sidan visar. Ren modul utan databas
 * och utan Next, så att den kan testas och anropas både från sidan och från server
 * actions (som räknar om förslaget innan något sparas).
 *
 * Alla siffror och texter kommer från @/analytics (releases, pricing, assortment) och
 * @/domain. Här väljs bara indata (vilka titlar som är släpp, vilka automater som har
 * fackfördelning) och resultaten sätts ihop per sektion.
 */

import {
  assortmentFollowUp,
  recommendAssortment,
  type AssortmentFollowUp,
  type MachineAssortmentRecommendation,
  type SlotAssignment,
} from "@/analytics/assortment";
import {
  detectPriceChanges,
  flagPurchaseAnomalies,
  priceChangeEffect,
  proposePriceTests,
  purchasePriceTrends,
  type NamedRef,
  type PriceChangeEffect,
  type PriceChangeEvent,
  type PriceTestProposal,
  type PurchaseAnomaly,
  type PurchaseRecord,
  type TitlePriceTrend,
} from "@/analytics/pricing";
import {
  releaseOutcome,
  suggestReleasePurchase,
  type ReleaseOutcome,
  type ReleaseRef,
  type ReleaseSuggestion,
} from "@/analytics/releases";
import type { MachineRef } from "@/analytics/todos";
import { addDays, daysBetween, maxDate, minDate, type IsoDate, type Period } from "@/domain";

import { dayText, packs, signedKronorWhole } from "./display";
import type {
  AllocationRow,
  AssortmentChangeRow,
  MarketData,
  PriceExperimentRow,
  QuoteRow,
  ReleaseRow,
} from "./types";

/** Fack per automat när fackfördelningen har färre (ordlistan: varje automat har sex fack). */
export const SLOTS_PER_MACHINE = 6;
/** Titlar som sålts redan första veckan med data räknas inte som släpp (släppdagen är okänd). */
export const RELEASE_EDGE_DAYS = 7;
/** Släpp närmare än så utan fastställt förslag kräver åtgärd. */
export const RELEASE_ACTION_DAYS = 14;
/** Så många prisändringar visas med effekt. */
export const PRICE_CHANGE_LIMIT = 8;
/** Minsta mätperiod för sortimentet (analysens minsta exponering). */
export const MIN_ASSORTMENT_DAYS = 14;

/** Resultat av en beräkning som kan stoppas av ogiltig indata. */
export type Computed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function compute<T>(fn: () => T): Computed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Beräkningen kunde inte göras.";
    return { ok: false, message };
  }
}

// ---------------------------------------------------------------------------
// Namn
// ---------------------------------------------------------------------------

/** Titlar som NamedRef (alla, även arkiverade, så att gamla underlag får namn). */
export function titleRefs(data: MarketData): NamedRef[] {
  return data.titles.map((t) => ({ id: t.id, name: t.name }));
}

/** Automater med koden som namn ("BL-001"), som i diagram och tabeller. */
export function machineRefs(data: MarketData): MachineRef[] {
  return data.machines.map((m) => ({
    id: m.id,
    name: m.code,
    code: m.code,
    activeFrom: m.activeFrom,
    activeTo: m.activeTo,
    archived: m.archived,
  }));
}

export function supplierRefs(data: MarketData): NamedRef[] {
  return data.suppliers.map((s) => ({ id: s.id, name: s.name }));
}

// ---------------------------------------------------------------------------
// 1. Releaser
// ---------------------------------------------------------------------------

export type ReleaseStatus = "upcoming" | "running" | "done";

export interface ReleaseView {
  readonly row: ReleaseRow;
  readonly status: ReleaseStatus;
  /** Dagar från i dag till släppdagen (negativt efter släppet). */
  readonly daysUntil: number;
  readonly titleName: string | null;
  readonly supplierName: string | null;
  /** Förslaget (som det ser ut i dag, eller dagen före släppet om det passerats). */
  readonly suggestion: Computed<ReleaseSuggestion> | null;
  /** Dagen förslaget räknades per. */
  readonly suggestionAsOf: IsoDate;
  /** Fastställd fördelning (null om förslaget inte fastställts). */
  readonly plan: readonly AllocationRow[] | null;
  /** Utfall mot fastställt förslag, annars mot förslaget. null före släppet. */
  readonly outcome: Computed<ReleaseOutcome> | null;
  readonly outcomeBasis: "plan" | "suggestion" | null;
  /** Varför utfallet inte kan mätas. */
  readonly outcomeMissing: string | null;
  /** Släppet är nära och förslaget är inte fastställt. */
  readonly needsAction: boolean;
}

/**
 * Titlarna som släpp i historiken: en per titel (inte sammanslagen). Släppdag = registrerad
 * släppdag, annars första order (analysens regel). Titlar utan registrerat släpp vars första
 * order ligger i första veckan med data hoppas över: de såldes troligen redan före
 * historiken, så första ordern är inte släppdagen.
 */
export function historicalReleases(data: MarketData): ReleaseRef[] {
  const registered = new Map<string, ReleaseRow>();
  for (const r of data.releases) if (r.titleId) registered.set(r.titleId, r);
  const firstSale = new Map<string, IsoDate>();
  for (const o of data.orders) {
    const prev = firstSale.get(o.titleId);
    if (!prev || o.businessDate < prev) firstSale.set(o.titleId, o.businessDate);
  }
  const edge = addDays(
    data.dataStart ? maxDate(data.dataStart, data.historyStart) : data.historyStart,
    RELEASE_EDGE_DAYS,
  );
  const refs: ReleaseRef[] = [];
  for (const t of data.titles) {
    if (t.mergedIntoId) continue;
    const release = registered.get(t.id);
    if (release) {
      refs.push({
        titleId: t.id,
        series: release.series ?? t.series,
        releaseDate: release.releaseDate,
      });
      continue;
    }
    const first = firstSale.get(t.id);
    if (!first || first < edge) continue;
    refs.push({ titleId: t.id, series: t.series, releaseDate: null });
  }
  return refs;
}

/** Id som analysen använder för ett släpp utan kopplad titel. */
export function releaseKey(row: ReleaseRow): string {
  return row.titleId ?? `release:${row.id}`;
}

/** Förslaget för ett släpp per en viss dag (se `suggestionAsOf`). */
export function releaseSuggestionFor(
  data: MarketData,
  row: ReleaseRow,
  asOf: IsoDate,
): ReleaseSuggestion {
  const titles = [...titleRefs(data), { id: releaseKey(row), name: row.name }];
  const onHand = row.titleId ? Math.max(0, data.warehouseUnits.get(row.titleId) ?? 0) : 0;
  return suggestReleasePurchase({
    orders: data.orders,
    releases: historicalReleases(data),
    machines: machineRefs(data),
    asOf,
    horizonDays: row.horizonDays,
    titles,
    newRelease: {
      titleId: releaseKey(row),
      series: row.series,
      releaseDate: row.releaseDate,
    },
    scaleBp: row.scaleBp,
    boxSize: row.boxSize,
    minOrderQty: row.minOrderQty,
    onHandUnits: onHand,
  });
}

/** Förslaget räknas per i dag före släppet och per dagen före släppet efteråt. */
export function suggestionDay(row: ReleaseRow, today: IsoDate): IsoDate {
  return minDate(today, addDays(row.releaseDate, -1));
}

export function releaseViews(data: MarketData): ReleaseView[] {
  const titleName = new Map(data.titles.map((t) => [t.id, t.name]));
  const supplierName = new Map(data.suppliers.map((s) => [s.id, s.name]));
  const allocations = new Map<string, AllocationRow[]>();
  for (const a of data.allocations) {
    const list = allocations.get(a.releaseId);
    if (list) list.push(a);
    else allocations.set(a.releaseId, [a]);
  }
  const titles = titleRefs(data);
  const machines = machineRefs(data);

  return data.releases.map((row) => {
    const daysUntil = daysBetween(data.today, row.releaseDate);
    const status: ReleaseStatus =
      daysUntil > 0 ? "upcoming" : -daysUntil < row.horizonDays ? "running" : "done";
    const locked = row.planLockedAt !== null;
    const plan = locked ? (allocations.get(row.id) ?? []) : null;
    const asOf = suggestionDay(row, data.today);
    const suggestion = compute(() => releaseSuggestionFor(data, row, asOf));

    let outcome: Computed<ReleaseOutcome> | null = null;
    let outcomeBasis: ReleaseView["outcomeBasis"] = null;
    let outcomeMissing: string | null = null;
    if (status !== "upcoming") {
      if (!row.titleId) {
        outcomeMissing =
          "Släppet är inte kopplat till en titel, så försäljningen kan inte mätas. Koppla titeln när den finns i orderna.";
      } else if (plan) {
        outcomeBasis = "plan";
        const curve = row.planCurveBp ?? undefined;
        outcome = compute(() =>
          releaseOutcome({
            orders: data.orders,
            titleId: row.titleId!,
            releaseDate: row.releaseDate,
            asOf: data.today,
            horizonDays: row.horizonDays,
            allocations: plan.map((a) => ({ machineId: a.machineId, units: a.units })),
            curveCumulativeBp: curve && curve.length >= row.horizonDays ? curve : undefined,
            titles,
            machines,
          }),
        );
      } else if (suggestion.ok && suggestion.value.status === "ok") {
        outcomeBasis = "suggestion";
        const s = suggestion.value;
        outcome = compute(() =>
          releaseOutcome({
            orders: data.orders,
            titleId: row.titleId!,
            releaseDate: row.releaseDate,
            asOf: data.today,
            horizonDays: row.horizonDays,
            allocations: s.allocations.map((a) => ({ machineId: a.machineId, units: a.units })),
            curveCumulativeBp: s.curve?.cumulativeBp,
            titles,
            machines,
          }),
        );
      } else {
        outcomeMissing =
          "Det fanns inget förslag att jämföra med före släppet (inga tidigare släpp med hel horisont).";
      }
    }

    const needsAction =
      status === "upcoming" &&
      !locked &&
      daysUntil <= RELEASE_ACTION_DAYS &&
      suggestion.ok &&
      suggestion.value.status === "ok";

    return {
      row,
      status,
      daysUntil,
      titleName: row.titleId ? (titleName.get(row.titleId) ?? null) : null,
      supplierName: row.supplierId ? (supplierName.get(row.supplierId) ?? null) : null,
      suggestion,
      suggestionAsOf: asOf,
      plan,
      outcome,
      outcomeBasis,
      outcomeMissing,
      needsAction,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. Marknadspriser
// ---------------------------------------------------------------------------

/** Var ett inköpspris kommer ifrån (för underlaget). */
export interface PurchaseSource {
  readonly id: string;
  readonly origin: "quote" | "purchase-order";
  readonly kind: QuoteRow["kind"] | "order-line";
  readonly titleId: string;
  readonly supplierId: string;
  readonly date: IsoDate;
  readonly unitCostOre: number;
  readonly quantity: number;
}

export interface PricesView {
  readonly purchases: readonly PurchaseSource[];
  readonly trends: Computed<TitlePriceTrend[]>;
  readonly anomalies: Computed<PurchaseAnomaly[]>;
  readonly quoteCount: number;
  readonly orderLineCount: number;
}

/** Offerter och inköpsorderrader som inköp (PurchaseRecord) för prisanalysen. */
export function purchaseSources(data: MarketData): PurchaseSource[] {
  return [
    ...data.quotes.map(
      (q): PurchaseSource => ({
        id: q.id,
        origin: "quote",
        kind: q.kind,
        titleId: q.titleId,
        supplierId: q.supplierId,
        date: q.quotedOn,
        unitCostOre: q.unitCostOre,
        quantity: q.quantity,
      }),
    ),
    ...data.purchaseLines.map(
      (l): PurchaseSource => ({
        id: l.id,
        origin: "purchase-order",
        kind: "order-line",
        titleId: l.titleId,
        supplierId: l.supplierId,
        date: l.date,
        unitCostOre: l.unitCostOre,
        quantity: l.quantity,
      }),
    ),
  ];
}

export function pricesView(data: MarketData, period: Period): PricesView {
  const purchases = purchaseSources(data);
  const records: PurchaseRecord[] = purchases.map((p) => ({
    id: p.id,
    titleId: p.titleId,
    supplierId: p.supplierId,
    date: p.date,
    unitCostOre: p.unitCostOre,
    quantity: p.quantity,
  }));
  const input = { purchases: records, titles: titleRefs(data), suppliers: supplierRefs(data) };
  return {
    purchases,
    trends: compute(() => purchasePriceTrends(input)),
    anomalies: compute(() =>
      flagPurchaseAnomalies(input, { from: period.start, to: period.end }),
    ),
    quoteCount: data.quotes.length,
    orderLineCount: data.purchaseLines.length,
  };
}

// ---------------------------------------------------------------------------
// 3. Sortiment
// ---------------------------------------------------------------------------

export interface AssortmentMachineView {
  readonly machineId: string;
  readonly code: string;
  /** Fack enligt fackfördelningen periodens sista dag. */
  readonly currentSlots: number;
  readonly capacity: number;
  readonly recommendation: MachineAssortmentRecommendation | null;
  /** Senaste genomförda ändring med samma fördelning som rådet (rådet är då genomfört). */
  readonly implemented: AssortmentChangeRow | null;
}

export interface AssortmentFollowUpView {
  readonly change: AssortmentChangeRow;
  readonly followUp: Computed<AssortmentFollowUp>;
}

export interface AssortmentView {
  readonly period: Period;
  /** Perioden är för kort för att efterfrågan ska räknas. */
  readonly tooShort: boolean;
  readonly machines: Computed<AssortmentMachineView[]>;
  /** Automater i drift utan fackfördelning. */
  readonly withoutSlots: readonly { id: string; code: string }[];
  readonly followUps: readonly AssortmentFollowUpView[];
}

export function slotAssignments(data: MarketData): SlotAssignment[] {
  return data.slots.map((s) => ({
    machineId: s.machineId,
    titleId: s.titleId,
    slots: s.slots,
    from: s.validFrom,
    to: s.validTo,
  }));
}

/** Fack per automat en viss dag. */
export function slotsOn(data: MarketData, day: IsoDate): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of data.slots) {
    if (s.validFrom > day || (s.validTo !== null && s.validTo < day)) continue;
    out.set(s.machineId, (out.get(s.machineId) ?? 0) + s.slots);
  }
  return out;
}

/** Fackfördelningen för en automat en viss dag, flest fack först. */
export function slotLinesOn(
  data: MarketData,
  machineId: string,
  day: IsoDate,
): { titleId: string; slots: number }[] {
  return data.slots
    .filter(
      (s) =>
        s.machineId === machineId &&
        s.validFrom <= day &&
        (s.validTo === null || s.validTo >= day),
    )
    .map((s) => ({ titleId: s.titleId, slots: s.slots }))
    .sort((a, b) => b.slots - a.slots || a.titleId.localeCompare(b.titleId));
}

/**
 * Förifyllning när en automat saknar fackfördelning: titlarna som sålt flest pack i
 * automaten under perioden, ett fack var, högst SLOTS_PER_MACHINE. Användaren
 * kontrollerar och sparar; inget sparas utan bekräftelse.
 */
export function slotPrefill(
  data: MarketData,
  machineId: string,
  period: Period,
): { titleId: string; slots: number }[] {
  const units = new Map<string, number>();
  for (const o of data.orders) {
    if (o.machineId !== machineId || o.businessDate < period.start || o.businessDate > period.end) {
      continue;
    }
    units.set(o.titleId, (units.get(o.titleId) ?? 0) + 1);
  }
  return [...units.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SLOTS_PER_MACHINE)
    .map(([titleId]) => ({ titleId, slots: 1 }));
}

/** Rekommendationerna för perioden, för automater med fackfördelning periodens sista dag. */
export function assortmentRecommendations(
  data: MarketData,
  period: Period,
): MachineAssortmentRecommendation[] {
  const current = slotsOn(data, period.end);
  const machineIds = [...current.keys()].sort();
  if (machineIds.length === 0) return [];
  const capacityByMachine: Record<string, number> = {};
  for (const [id, n] of current) capacityByMachine[id] = Math.max(SLOTS_PER_MACHINE, n);
  return recommendAssortment({
    ...data.sources,
    orders: data.orders,
    machines: machineRefs(data),
    titles: titleRefs(data),
    assignments: slotAssignments(data),
    period,
    capacityByMachine,
    machineIds,
  });
}

export function assortmentView(data: MarketData, period: Period): AssortmentView {
  const tooShort = daysBetween(period.start, period.end) + 1 < MIN_ASSORTMENT_DAYS;
  const current = slotsOn(data, period.end);
  const code = new Map(data.machines.map((m) => [m.id, m.code]));
  const machines = compute((): AssortmentMachineView[] => {
    const recs = tooShort ? [] : assortmentRecommendations(data, period);
    const byMachine = new Map(recs.map((r) => [r.machineId, r]));
    return [...current.keys()]
      .sort((a, b) => (code.get(a) ?? a).localeCompare(code.get(b) ?? b, "sv"))
      .map((machineId) => {
        const recommendation = byMachine.get(machineId) ?? null;
        const implemented =
          recommendation === null
            ? null
            : ([...data.assortmentChanges]
                .reverse()
                .find(
                  (c) =>
                    c.machineId === machineId && c.fingerprint === recommendation.fingerprint,
                ) ?? null);
        const slots = current.get(machineId) ?? 0;
        return {
          machineId,
          code: code.get(machineId) ?? machineId,
          currentSlots: slots,
          capacity: Math.max(SLOTS_PER_MACHINE, slots),
          recommendation,
          implemented,
        };
      });
  });
  const withoutSlots = data.machines
    .filter(
      (m) =>
        !m.archived &&
        !current.has(m.id) &&
        (m.activeTo === null || m.activeTo >= period.end) &&
        (m.activeFrom === null || m.activeFrom <= period.end),
    )
    .map((m) => ({ id: m.id, code: m.code }))
    .sort((a, b) => a.code.localeCompare(b.code, "sv"));
  const followUps = [...data.assortmentChanges]
    .sort((a, b) => (a.implementedOn < b.implementedOn ? 1 : -1))
    .map((change) => ({
      change,
      followUp: compute(() =>
        assortmentFollowUp({
          ...data.sources,
          orders: data.orders,
          machineId: change.machineId,
          implementedOn: change.implementedOn,
          asOf: data.today,
          expectedEffectPerWeekOre: change.expectedEffectPerWeekOre,
          changedTitleIds: change.changedTitleIds,
          machines: machineRefs(data),
          titles: titleRefs(data),
        }),
      ),
    }));
  return { period, tooShort, machines, withoutSlots, followUps };
}

// ---------------------------------------------------------------------------
// 4. Prissättning
// ---------------------------------------------------------------------------

export interface PriceChangeView {
  readonly change: PriceChangeEvent;
  readonly effect: Computed<PriceChangeEffect>;
}

export type ExperimentStatus = "planned" | "running" | "done" | "stopped";

export interface ExperimentView {
  readonly row: PriceExperimentRow;
  readonly status: ExperimentStatus;
  readonly endsOn: IsoDate;
  readonly evaluation: Computed<PriceChangeEffect> | null;
}

export interface PricingView {
  readonly changes: Computed<PriceChangeView[]>;
  /** Prisändringar i perioden utöver de som visas. */
  readonly moreChanges: number;
  readonly proposals: Computed<PriceTestProposal[]>;
  readonly experiments: readonly ExperimentView[];
}

/** Pristester som pågår eller är planerade (inte avslutade eller stoppade). */
export function activeExperimentTitles(data: MarketData): Set<string> {
  const out = new Set<string>();
  for (const e of data.experiments) {
    const end = addDays(e.startedOn, e.testDays - 1);
    if (e.stoppedOn === null && end >= data.today) out.add(e.titleId);
  }
  return out;
}

/** Förslag på pristester per i dag, utan titlar som redan testas. */
export function priceTestProposals(data: MarketData): PriceTestProposal[] {
  const active = activeExperimentTitles(data);
  return proposePriceTests({
    ...data.sources,
    orders: data.orders,
    asOf: data.today,
    titles: titleRefs(data),
    machines: machineRefs(data),
  }).filter((p) => !active.has(p.titleId));
}

export function pricingView(data: MarketData, period: Period): PricingView {
  const titles = titleRefs(data);
  const machines = machineRefs(data);
  let moreChanges = 0;
  const changes = compute((): PriceChangeView[] => {
    const all = detectPriceChanges(data.orders, { titles }).filter(
      (c) => c.date >= period.start && c.date <= period.end,
    );
    const shown = all.slice(-PRICE_CHANGE_LIMIT).reverse();
    moreChanges = all.length - shown.length;
    return shown.map((change) => ({
      change,
      effect: compute(() =>
        priceChangeEffect({
          ...data.sources,
          orders: data.orders,
          titleId: change.titleId,
          changeDate: change.date,
          asOf: data.today,
          titles,
          machines,
        }),
      ),
    }));
  });
  const experiments = [...data.experiments]
    .sort((a, b) => (a.startedOn < b.startedOn ? 1 : -1))
    .map((row): ExperimentView => {
      const endsOn = addDays(row.startedOn, row.testDays - 1);
      const status: ExperimentStatus =
        row.stoppedOn !== null
          ? "stopped"
          : row.startedOn > data.today
            ? "planned"
            : endsOn < data.today
              ? "done"
              : "running";
      const last = minDate(data.today, row.stoppedOn ?? endsOn);
      const evaluation =
        row.startedOn > data.today
          ? null
          : compute(() =>
              priceChangeEffect({
                ...data.sources,
                orders: data.orders,
                titleId: row.titleId,
                changeDate: row.startedOn,
                asOf: last,
                windowDays: row.testDays,
                testMachineIds: row.testMachineIds,
                controlMachineIds: row.controlMachineIds,
                titles,
                machines,
              }),
            );
      return { row, status, endsOn, evaluation };
    });
  return {
    changes,
    moreChanges,
    proposals: compute(() => priceTestProposals(data)),
    experiments,
  };
}

// ---------------------------------------------------------------------------
// Rubriken
// ---------------------------------------------------------------------------

export interface MarketHeadline {
  readonly title: string;
  readonly aside: string;
}

/**
 * Sidans svar högst upp: nästa släpp och förslaget (eller att inget släpp finns), och i den
 * grå delen de viktigaste sakerna i övriga sektioner, med siffror ur samma beräkningar.
 */
export function marketHeadline(
  data: MarketData,
  releases: readonly ReleaseView[],
  prices: PricesView,
  assortment: AssortmentView,
  pricing: PricingView,
): MarketHeadline {
  const next = releases.find((r) => r.status === "upcoming");
  let title: string;
  const facts: string[] = [];
  if (next) {
    const when = dayText(next.row.releaseDate, data.today);
    title = `Nästa släpp: ${next.row.name} ${when}${when.endsWith(".") ? "" : "."}`;
    if (next.plan) {
      facts.push(`Förslaget är fastställt: ${packs(next.row.planPurchaseUnits ?? 0)} att köpa.`);
    } else if (next.suggestion?.ok && next.suggestion.value.status === "ok") {
      facts.push(
        `Förslaget: köp ${packs(next.suggestion.value.purchaseUnits)} till ${next.suggestion.value.allocations.length} automater.`,
      );
    } else {
      facts.push("Inget tidigare släpp att räkna förslaget från.");
    }
  } else {
    title = releases.length === 0 ? "Inget släpp inlagt." : "Inget kommande släpp.";
  }
  if (prices.anomalies.ok && prices.anomalies.value.length > 0) {
    const n = prices.anomalies.value.length;
    facts.push(`${n} ${n === 1 ? "inköp avviker" : "inköp avviker"} från medianpriset.`);
  }
  if (assortment.machines.ok) {
    const changes = assortment.machines.value.filter(
      (m) => m.recommendation?.action === "change" && m.implemented === null,
    );
    if (changes.length > 0) {
      const effect = changes.reduce((s, m) => s + (m.recommendation?.effectPerWeekOre ?? 0), 0);
      facts.push(
        `Sortimentet i ${changes.length} ${changes.length === 1 ? "automat" : "automater"} kan ge ${signedKronorWhole(effect)}/vecka.`,
      );
    }
  }
  if (pricing.proposals.ok && pricing.proposals.value.length > 0) {
    const n = pricing.proposals.value.length;
    facts.push(`${n} ${n === 1 ? "pristest föreslås" : "pristester föreslås"}.`);
  }
  if (facts.length === 0) {
    facts.push(
      data.quotes.length === 0 && data.purchaseLines.length === 0
        ? "Inga inköpspriser registrerade ännu."
        : "Inga avvikelser i inköpspriserna.",
    );
  }
  return { title, aside: facts.slice(0, 3).join(" ") };
}

// ---------------------------------------------------------------------------
// Hela sidan
// ---------------------------------------------------------------------------

export interface MarketModel {
  readonly period: Period;
  readonly headline: MarketHeadline;
  readonly releases: readonly ReleaseView[];
  readonly prices: PricesView;
  readonly assortment: AssortmentView;
  readonly pricing: PricingView;
}

export function buildMarketModel(data: MarketData, period: Period): MarketModel {
  const releases = releaseViews(data);
  const prices = pricesView(data, period);
  const assortment = assortmentView(data, period);
  const pricing = pricingView(data, period);
  return {
    period,
    headline: marketHeadline(data, releases, prices, assortment, pricing),
    releases,
    prices,
    assortment,
    pricing,
  };
}
