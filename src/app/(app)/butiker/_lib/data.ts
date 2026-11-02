/**
 * Laddarna för Butikers sidor: de gemensamma laddarna (RLS, rollkontroll, cache per
 * förfrågan) plus butiksregistret, avtalen och mottagarna ur ./service, sammansatta till
 * vymodeller med ./model. Alla belopp kommer ur @/domain (profitability, storeCompensation).
 */

import "server-only";

import { cache } from "react";

import {
  describePeriod,
  toURLSearchParams,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import { daysBetween, profitability, storeCompensation, type ProfitabilityInput } from "@/domain";
import { isUuid } from "@/server/access";
import {
  loadDomainInput,
  loadMasterData,
  loadPeriod,
  requireRoute,
  type AppContext,
  type AppPeriod,
} from "@/server/data/core";

import {
  agreementsOf,
  buildStoreRows,
  compensationHeadline,
  dailySeries,
  listHeadline,
  listKpis,
  machinesIn,
  monthCompensation,
  monthLabel,
  monthToDate,
  revenueOf,
  storeHeadline,
  storeIssues,
  storeKpis,
  toAgreementView,
} from "./model";
import { loadAgreementsFor, loadRecipientsFor, loadStoresFor } from "./service";
import { currentViewer } from "./session";
import type {
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
  readonly days: number;
  readonly rangeLabel: string;
  readonly comparisonLabel: string | null;
}

/** Dagar med data: från första ordern om perioden börjar före den. */
function dataDays(p: AppPeriod): number {
  return p.dataStart && p.dataStart > p.period.start && p.dataStart <= p.period.end
    ? daysBetween(p.dataStart, p.period.end) + 1
    : p.days;
}

function periodInfo(p: AppPeriod, hasComparison: boolean): PeriodInfo {
  const d = describePeriod(p.resolved);
  return {
    days: dataDays(p),
    rangeLabel: d.rangeLabel,
    comparisonLabel: hasComparison ? d.comparisonLabel : null,
  };
}

/** Bara periodens parametrar (inte butiks- och automatfiltret), för länkar mellan sidorna. */
export function periodQuery(sp: SearchParamsInput): string {
  const src = toURLSearchParams(sp);
  const out = new URLSearchParams();
  for (const key of ["period", "from", "to"]) {
    const v = src.get(key);
    if (v) out.set(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** Jämförelseperioden räknas bara om den har order (inte före första ordern). */
function comparable(previous: ProfitabilityInput | null): ProfitabilityInput | null {
  return previous && previous.orders.length > 0 ? previous : null;
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
  readonly flagged: number;
  readonly examples: number;
}

export async function loadStoreList(searchParams: SearchParamsInput): Promise<StoreListData> {
  const ctx = await requireRoute("butiker");
  const p = await loadPeriod(searchParams);
  const viewer = await currentViewer();
  const month = monthToDate(ctx.today);
  const [input, monthInput, master, stores, agreements] = await Promise.all([
    loadDomainInput({ period: p.period, compare: p.compare }),
    loadDomainInput({ period: month }),
    loadMasterData(),
    loadStores(),
    loadAgreementsFor(viewer),
  ]);
  const previousInput = comparable(input.previous);
  const current = profitability(input.current, "store");
  const previous = previousInput ? profitability(previousInput, "store") : null;
  const earned = new Map(
    storeCompensation(monthInput.current).stores.map((c) => [c.storeId, c.totalOre]),
  );
  const views = agreements.map((a) => toAgreementView(a, ctx.today));
  const filterId = p.scope.storeId;
  const shown = filterId ? stores.filter((s) => s.id === filterId) : stores;
  const rows = buildStoreRows({
    stores: shown,
    placements: master.placements,
    machineCodes: new Map(master.machines.map((m) => [m.id, m.code])),
    agreements: views,
    current,
    previous,
    earnedMonth: earned,
    today: ctx.today,
    query: periodQuery(searchParams),
  });
  const monthName = monthLabel(ctx.today);
  const info = periodInfo(p, previous !== null);
  return {
    ctx,
    period: info,
    rows,
    kpis: listKpis(rows, monthName, previous),
    headline: listHeadline(rows, info.days),
    monthLabel: monthName,
    scopeLabel: filterId ? (stores.find((s) => s.id === filterId)?.name ?? null) : null,
    flagged: rows.filter((r) => r.flag !== null).length,
    examples: rows.filter((r) => r.isExample && !r.archived).length,
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
  /** Periodens query-sträng för länkar. */
  readonly query: string;
}

export async function loadStoreDetail(
  storeId: string,
  searchParams: SearchParamsInput,
): Promise<StoreDetailData | null> {
  const ctx = await requireRoute("butiker");
  if (!isUuid(storeId)) return null;
  const viewer = await currentViewer();
  const stores = await loadStores();
  const store = stores.find((s) => s.id === storeId);
  if (!store) return null;

  const p = await loadPeriod(searchParams);
  const month = monthToDate(ctx.today);
  const [input, monthInput, master, agreements, recipients] = await Promise.all([
    loadDomainInput({ period: p.period, compare: p.compare, storeId }),
    loadDomainInput({ period: month, storeId }),
    loadMasterData(),
    loadAgreementsFor(viewer),
    loadRecipientsFor(viewer, storeId),
  ]);
  const previousInput = comparable(input.previous);
  const byStore = profitability(input.current, "store");
  const prevByStore = previousInput ? profitability(previousInput, "store") : null;
  const row = byStore.rows.find((r) => r.kind === "item" && r.key === storeId);
  const prevRow = prevByStore
    ? (prevByStore.rows.find((r) => r.kind === "item" && r.key === storeId) ?? undefined)
    : null;
  const daily = dailySeries(profitability(input.current, "day"));
  const dailyPrev = previousInput ? dailySeries(profitability(previousInput, "day")) : null;

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

  const info = periodInfo(p, prevByStore !== null);
  return {
    ctx,
    period: info,
    store,
    headline: storeHeadline({
      name: store.name,
      revenueOre: revenueOf(row),
      previousRevenueOre: prevByStore ? revenueOf(prevRow ?? undefined) : null,
      days: info.days,
      month: mc,
    }),
    kpis: storeKpis({ current: row, previous: prevRow, daily }),
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
    }),
    query,
  };
}
