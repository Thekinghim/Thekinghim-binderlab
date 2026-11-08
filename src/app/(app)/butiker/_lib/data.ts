/**
 * Laddarna för Butikers sidor: de gemensamma laddarna (RLS, rollkontroll, cache per
 * förfrågan) plus butiksregistret, avtalen och mottagarna ur ./service, sammansatta till
 * vymodeller med ./model. Alla belopp kommer ur @/domain (profitability, storeCompensation).
 */

import "server-only";

import { storeShareTerms } from "@/lib/store-share";
import { cache } from "react";

import {
  describePeriod,
  toURLSearchParams,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import {
  agreementGaps,
  buildLedger,
  minDate,
  profitability,
  storeCompensation,
  type AgreementGap,
  type IsoDate,
  type Period,
  type ProfitabilityInput,
} from "@/domain";
import { storeContractState, storeContractStates } from "@/analytics/contracts/signed";
import { routeById } from "@/components/shell/nav";
import { isUuid } from "@/server/access";
import { loadSignableContractsFor } from "@/server/contracts";
import {
  loadDomainInput,
  loadLastOrderDate,
  loadMasterData,
  loadPeriod,
  requireRoute,
  type AppContext,
  type AppPeriod,
} from "@/server/data/core";

import {
  activeStores,
  agreementGapView,
  agreementsOf,
  blockedByUnpriced,
  buildStoreRows,
  compensationHeadline,
  dailySeries,
  dataCoverage,
  listHeadline,
  listKpis,
  machinesIn,
  monthCompensation,
  monthLabel,
  monthToDate,
  revenueOf,
  spanText,
  storeHeadline,
  storeIssues,
  storeKpis,
  toAgreementView,
  unpricedProfitNote,
} from "./model";
import {
  loadAgreementsFor,
  loadAllRecipientsFor,
  loadRecipientsFor,
  loadStoresFor,
} from "./service";
import { currentViewer } from "./session";
import { requestPageLoaders, type PageLoaders } from "@/server/data/page-loaders";
import type {
  AgreementGapView,
  AgreementView,
  DailyPoint,
  KpiView,
  MonthCompensation,
  RecipientView,
  StoreDetail,
  StoreIssue,
  StoreMachineRow,
  StoreRow,
} from "./types";

export interface PeriodInfo {
  /** Dagar med data (se dataCoverage): rubrikernas antal dagar. */
  readonly days: number;
  /** "på 20 dagar". */
  readonly span: string;
  /** Hela perioden ("4 okt. – 2 nov."). */
  readonly rangeLabel: string;
  readonly comparisonLabel: string | null;
  /** Dagarna med data, eller null. */
  readonly coverage: Period | null;
  /** Perioden börjar före första ordern eller slutar med en dag utan data. */
  readonly partial: boolean;
}

function hasOrdersOn(orders: readonly { businessDate: IsoDate }[], day: IsoDate): boolean {
  return orders.some((o) => o.businessDate === day);
}

function periodInfo(
  p: AppPeriod,
  today: IsoDate,
  /** Organisationen har order i dag (dagarna med data räknas då med i dag). */
  ordersToday: boolean,
  hasComparison: boolean,
): PeriodInfo {
  const d = describePeriod(p.resolved);
  // Dagarna med data räknas på organisationens order (som Hem och Automater), inte
  // butikens, så att alla sidor anger samma antal dagar för samma period.
  const coverage = dataCoverage(p.period, p.dataStart, today, ordersToday);
  const span = spanText(coverage, today);
  return {
    days: span.days,
    span: span.text,
    rangeLabel: d.rangeLabel,
    comparisonLabel: hasComparison ? d.comparisonLabel : null,
    coverage,
    partial:
      coverage !== null && (coverage.start !== p.period.start || coverage.end !== p.period.end),
  };
}

/**
 * Periodens parametrar och vyknapparna (?vmb, ?andel), inte butiks- och automatfiltret, för
 * länkar mellan sidorna.
 */
export function periodQuery(sp: SearchParamsInput): string {
  const src = toURLSearchParams(sp);
  const out = new URLSearchParams();
  // Vyknapparna följer med (som skalets länkar), filtret inte.
  for (const key of ["period", "from", "to", "vmb", "andel"]) {
    const v = src.get(key);
    if (v) out.set(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/**
 * Jämförelsen gäller bara när jämförelseperioden har order och ligger helt inom datan
 * (som på Hem och Automater): en halv jämförelseperiod ger skenbara ökningar.
 */
function comparable(p: AppPeriod, previous: ProfitabilityInput | null): ProfitabilityInput | null {
  return previous &&
    previous.orders.length > 0 &&
    p.compare !== null &&
    p.dataStart !== null &&
    p.compare.start >= p.dataStart
    ? previous
    : null;
}

/**
 * Dagar i perioden (t.o.m. i dag) med automat men utan avtal, per butik: samma placeringar
 * och avtal som beräkningen använder (agreementGaps i @/domain).
 */
function gapsFor(
  current: Pick<ProfitabilityInput, "placements" | "agreements">,
  period: Period,
  today: IsoDate,
  storeIds?: readonly string[],
): Map<string, AgreementGap> {
  const end = minDate(period.end, today);
  if (end < period.start) return new Map();
  return new Map(
    agreementGaps({
      placements: current.placements,
      agreements: current.agreements,
      period: { start: period.start, end },
      ...(storeIds ? { storeIds } : {}),
    }).map((g) => [g.storeId, g]),
  );
}

/** Butiksregistret, en gång per förfrågan (sidan och metadata delar det). */
const loadStores = cache(async () => loadStoresFor(await currentViewer()));

/** Butikens namn för sidans titel, eller null. */
export async function storeNameOf(storeId: string): Promise<string | null> {
  if (!isUuid(storeId)) return null;
  await requireRoute("butiker");
  return (await loadStores()).find((s) => s.id === storeId)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Listan
// ---------------------------------------------------------------------------

export interface StoreListData {
  readonly ctx: AppContext;
  readonly period: PeriodInfo;
  readonly rows: StoreRow[];
  readonly kpis: KpiView[];
  readonly headline: { readonly title: string; readonly aside: string | undefined };
  readonly monthLabel: string;
  /** Butiksfiltrets namn, om filtret är satt. */
  readonly scopeLabel: string | null;
  /** Automatfiltrets kod om det är satt (det gäller inte listan, som visar butiker). */
  readonly ignoredMachine: string | null;
  readonly flagged: number;
  readonly examples: number;
  /** Butiker i drift (activeStores) med signerat kontrakt. */
  readonly signed: number;
  /**
   * Butikernas andel är dragen från vår vinst och visas (vyknappen "Visa butikernas andel"
   * eller vald butik). Av: vår vinst före andelen.
   */
  readonly showStoreShare: boolean;
}

export async function loadStoreList(searchParams: SearchParamsInput): Promise<StoreListData> {
  await requireRoute("butiker");
  return loadStoreListWith(requestPageLoaders(), searchParams);
}

/**
 * Listan med givna laddare: sidan med förfrågans (loadStoreList), Daglig kontroll med en
 * given användare och vyknappens läge (src/server/self-check). Rollen kontrolleras av
 * laddarna (loadDomainInputFor, loadStoresFor m.fl.).
 */
export async function loadStoreListWith(
  loaders: PageLoaders,
  searchParams: SearchParamsInput,
): Promise<StoreListData> {
  const [ctx, viewer] = await Promise.all([loaders.context(), loaders.viewer()]);
  const month = monthToDate(ctx.today);
  // Perioden och det som inte beror på den hämtas samtidigt (förut perioden först).
  const periodP = loaders.period(searchParams);
  const [p, input, monthInput, master, stores, agreements, recipients, contracts] =
    await Promise.all([
      periodP,
      // Hela organisationen (hyran per butik); med vald butik dras butikens andel (som
      // loadDomainInput med storeId), annars följer vinsten vyknappen.
      periodP.then((x) =>
        loaders.domainInput({
          period: x.period,
          compare: x.compare,
          ...(x.scope.storeId ? { storeShare: true } : {}),
        }),
      ),
      loaders.domainInput({ period: month }),
      loaders.masterData(),
      loadStoresFor(viewer),
      loadAgreementsFor(viewer),
      loadAllRecipientsFor(viewer),
      loadSignableContractsFor(viewer),
    ]);
  const previousInput = comparable(p, input.previous);
  const current = profitability(input.current, "store");
  const previous = previousInput ? profitability(previousInput, "store") : null;
  const earned = new Map(
    storeCompensation(monthInput.current).stores.map((c) => [c.storeId, c.totalOre]),
  );
  const views = agreements.map((a) => toAgreementView(a, ctx.today));
  const filterId = p.scope.storeId;
  const shown = filterId ? stores.filter((s) => s.id === filterId) : stores;
  // Till butiken i perioden: samma motor och samma indata som avräkningen (alla order,
  // butikens eget avtal). Dras inte från vår vinst; det gör bara vyknappen.
  const toStore = new Map(
    storeCompensation(input.current).stores.map((c) => [c.storeId, c.totalOre]),
  );
  const terms = new Map(
    shown.map((s) => [s.id, storeShareTerms(input.current.agreements, s.id, p.period)]),
  );
  const gaps = gapsFor(input.current, p.period, ctx.today);
  // Vinstdelning med order utan inköpspris: avräkningen spärras (samma regel).
  const blocked = blockedByUnpriced(buildLedger(input.current).profitSplits);
  const rows = buildStoreRows({
    stores: shown,
    placements: master.placements,
    machineCodes: new Map(master.machines.map((m) => [m.id, m.code])),
    agreements: views,
    current,
    previous,
    earnedMonth: earned,
    recipients,
    contracts: storeContractStates(
      contracts,
      shown.map((s) => s.id),
      ctx.today,
    ),
    toStore,
    terms,
    gaps,
    blocked,
    canOpenPrices: routeById("inkopspriser").roles.includes(ctx.role),
    today: ctx.today,
    query: periodQuery(searchParams),
  });
  const monthName = monthLabel(ctx.today);
  const info = periodInfo(
    p,
    ctx.today,
    hasOrdersOn(input.current.orders, ctx.today),
    previous !== null,
  );
  const machineId = p.scope.machineId;
  // Butikernas andel dras (och visas) med vyknappen eller vald butik: samma flagga som talen.
  const showShare = current.storeShareDeducted;
  return {
    ctx,
    period: info,
    rows,
    kpis: listKpis(rows, monthName, showShare),
    headline: listHeadline(rows, info.span, showShare),
    monthLabel: monthName,
    scopeLabel: filterId ? (stores.find((s) => s.id === filterId)?.name ?? null) : null,
    ignoredMachine: machineId
      ? (master.machines.find((m) => m.id === machineId)?.code ?? "vald automat")
      : null,
    flagged: rows.filter((r) => r.issue !== null).length,
    examples: rows.filter((r) => r.isExample && !r.archived).length,
    signed: activeStores(rows).filter((r) => r.contract === "signed").length,
    showStoreShare: showShare,
  };
}

// ---------------------------------------------------------------------------
// En butik
// ---------------------------------------------------------------------------

export interface StoreDetailData {
  readonly ctx: AppContext;
  readonly period: PeriodInfo;
  readonly store: StoreDetail;
  readonly headline: { readonly title: string; readonly aside: string };
  readonly kpis: KpiView[];
  readonly daily: DailyPoint[];
  readonly dailyCompare: number[] | null;
  readonly month: MonthCompensation;
  readonly compensation: { readonly title: string; readonly aside: string };
  readonly agreements: AgreementView[];
  readonly current: AgreementView | null;
  readonly machines: StoreMachineRow[];
  readonly recipients: RecipientView[];
  readonly issues: StoreIssue[];
  /**
   * Dagar i perioden med automat men utan avtal (butiken räknas som 0 %), eller null. Med
   * automat i dag och inget avtal i dag gäller det också (`issues` har "no-agreement").
   */
  readonly agreementGap: AgreementGapView | null;
  /** Kontraktet: signerat, osignerat eller saknas. */
  readonly contract: "signed" | "unsigned" | "missing";
  /**
   * "3 sålda saknar inköpspris – vinsten är inte helt rätt." vid nyckeltalen, eller null:
   * Till butiken + Vår del blir då inte vinsten (unpricedProfitNote).
   */
  readonly unpricedNote: string | null;
  /** Periodens query-sträng för länkar. */
  readonly query: string;
}

/**
 * Till butiken i perioden för en butik: storeCompensation (alla order, butikens eget
 * avtal), samma tal som listan och avräkningen.
 */
function toStoreOf(input: ProfitabilityInput, storeId: string): number {
  return storeCompensation(input).stores.find((c) => c.storeId === storeId)?.totalOre ?? 0;
}

export async function loadStoreDetail(
  storeId: string,
  searchParams: SearchParamsInput,
): Promise<StoreDetailData | null> {
  const ctx = await requireRoute("butiker");
  if (!isUuid(storeId)) return null;
  const viewer = await currentViewer();
  const month = monthToDate(ctx.today);
  // Allt som inte beror på perioden hämtas samtidigt med perioden och butiksregistret (förut
  // i tre steg efter varandra). Organisationens order i perioden behövs inte: bara om det
  // finns order i dag (en fråga), för dagarna med data.
  const periodP = loadPeriod(searchParams);
  const inputP = periodP.then((p) =>
    loadDomainInput({ period: p.period, compare: p.compare, storeId }),
  );
  const [stores, p, input, ordersToday, monthInput, master, agreements, recipients, contracts] =
    await Promise.all([
      loadStores(),
      periodP,
      inputP,
      loadLastOrderDate({ period: { start: ctx.today, end: ctx.today } }).then(
        (d) => d === ctx.today,
      ),
      loadDomainInput({ period: month, storeId }),
      loadMasterData(),
      loadAgreementsFor(viewer),
      loadRecipientsFor(viewer, storeId),
      loadSignableContractsFor(viewer),
    ]);
  const store = stores.find((s) => s.id === storeId);
  if (!store) return null;
  const contract = storeContractState(contracts, storeId, ctx.today);
  const previousInput = comparable(p, input.previous);
  const byStore = profitability(input.current, "store");
  const prevByStore = previousInput ? profitability(previousInput, "store") : null;
  const row = byStore.rows.find((r) => r.kind === "item" && r.key === storeId);
  const prevRow = prevByStore
    ? (prevByStore.rows.find((r) => r.kind === "item" && r.key === storeId) ?? undefined)
    : null;
  const info = periodInfo(p, ctx.today, ordersToday, prevByStore !== null);
  // Dagsserien klipps till dagarna med data (inga nolldagar före första ordern eller
  // för en dag som ännu inte har data); jämförelsen klipps på samma ställen.
  const cov = info.coverage;
  const fullDaily = dailySeries(profitability(input.current, "day"));
  const skip = cov ? fullDaily.filter((d) => d.date < cov.start).length : 0;
  const daily = cov ? fullDaily.filter((d) => d.date >= cov.start && d.date <= cov.end) : [];
  const dailyPrev = previousInput
    ? dailySeries(profitability(previousInput, "day")).slice(skip, skip + daily.length)
    : null;

  const mc = monthCompensation({
    today: ctx.today,
    storeId,
    result: profitability(monthInput.current, "store"),
    compensation: new Map(storeCompensation(monthInput.current).stores.map((c) => [c.storeId, c])),
  });

  const views = agreementsOf(
    agreements.map((a) => toAgreementView(a, ctx.today)),
    storeId,
  );
  const current = views.find((a) => a.state === "current") ?? null;

  const query = periodQuery(searchParams);
  const byMachine = new Map(
    profitability(input.current, "machine")
      .rows.filter((r) => r.kind === "item")
      .map((r) => [r.key, r]),
  );
  const machineById = new Map(master.machines.map((m) => [m.id, m]));
  const machines: StoreMachineRow[] = master.placements
    .filter((pl) => pl.storeId === storeId)
    .map((pl) => {
      const m = machineById.get(pl.machineId);
      const r = byMachine.get(pl.machineId);
      const code = m?.code ?? "";
      return {
        placementId: pl.id,
        machineId: pl.machineId,
        code,
        name: m?.name ?? "",
        from: pl.from,
        to: pl.to,
        current: pl.from <= ctx.today && (pl.to === null || pl.to >= ctx.today),
        orders: r?.orders ?? 0,
        revenueOre: revenueOf(r),
        href: `/automater/${encodeURIComponent(code.toLowerCase())}${query}`,
      };
    })
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (a.from < b.from ? 1 : a.from > b.from ? -1 : 0) ||
        a.code.localeCompare(b.code, "sv"),
    );
  const codes = machinesIn(
    storeId,
    master.placements,
    new Map(master.machines.map((m) => [m.id, m.code])),
    ctx.today,
  );
  const rawGap = gapsFor(input.current, p.period, ctx.today, [storeId]).get(storeId);
  const agreementGap = rawGap && !store.archived ? agreementGapView(rawGap, ctx.today) : null;

  return {
    ctx,
    period: info,
    store,
    headline: storeHeadline({
      name: store.name,
      revenueOre: revenueOf(row),
      previousRevenueOre: prevByStore ? revenueOf(prevRow ?? undefined) : null,
      profitOre: row?.profitOre ?? 0,
      span: info.span,
      month: mc,
      vmb: input.settings.vmb === true,
      storeShareDeducted: byStore.storeShareDeducted,
    }),
    kpis: storeKpis({
      current: row,
      previous: prevRow,
      daily,
      terms: storeShareTerms(input.current.agreements, storeId, p.period),
      storeShareDeducted: byStore.storeShareDeducted,
      toStoreOre: toStoreOf(input.current, storeId),
      previousToStoreOre: previousInput ? toStoreOf(previousInput, storeId) : null,
    }),
    unpricedNote: unpricedProfitNote(row),
    daily,
    dailyCompare: dailyPrev ? dailyPrev.map((d) => d.value) : null,
    month: mc,
    compensation: compensationHeadline(mc, current),
    agreements: views,
    current,
    machines,
    recipients,
    issues: storeIssues({
      agreements: views,
      machineCodes: codes,
      recipients,
      archived: store.archived,
      today: ctx.today,
      contract,
      gap: agreementGap,
    }),
    agreementGap,
    contract,
    query,
  };
}
