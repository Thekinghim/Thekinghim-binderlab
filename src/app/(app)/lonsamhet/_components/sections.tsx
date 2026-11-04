"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { Segmented } from "@/components/ui/segmented";
import { StateMessage } from "@/components/ui/state-message";
import { formatPercent, formatSek, NBSP } from "@/lib/format";

import { sentence, type SectionTitle } from "../_lib/headline";
import type { ProfitLine, TrendKey, TrendSeries, ViewKey } from "../_lib/model";
import { ANALYSIS_PARAM, TREND_PARAM, VIEW_PARAM, type AnalysisTab } from "../_lib/params";
import { DEFAULT_SORT, ExportButton, ProfitTable, VIEW_NOUN } from "./profit-table";
import type { SortKey } from "@/components/ui/data-table";
import { ProfitTrendChart, type TrendDatum } from "./profit-trend-chart";

/** Byter en parameter i adressen utan ny serverförfrågan, så att länken går att dela. */
function replaceParam(name: string, value: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, "", url);
}

// ---------------------------------------------------------------------------
// 02 / Per titel, automat, butik
// ---------------------------------------------------------------------------

export function TableSection({
  tabs,
  initialView,
  views,
  titles,
  totals,
  periodLabel,
  days,
  fileStem,
  selectedTitle,
  showStoreShare = false,
  storeShareLabel,
}: {
  tabs?: ReactNode;
  initialView: ViewKey;
  views: Record<ViewKey, ProfitLine[]>;
  titles: Record<ViewKey, SectionTitle>;
  totals: ProfitLine;
  periodLabel: string;
  days: number;
  fileStem: string;
  /** Titel från ?titel= som markeras i vyn per titel. */
  selectedTitle: string | null;
  /** Kolumnen med butikernas andel (vyknappen eller vald butik). */
  showStoreShare?: boolean;
  storeShareLabel?: string;
}) {
  const [view, setView] = useState<ViewKey>(initialView);
  const [sort, setSort] = useState<readonly SortKey[]>(DEFAULT_SORT);
  const change = (v: ViewKey) => {
    setView(v);
    setSort(DEFAULT_SORT);
    replaceParam("vy", VIEW_PARAM[v]);
  };
  const heading = titles[view];
  const rows = views[view];
  const selected =
    view === "title" && selectedTitle
      ? (rows.find((r) => r.kind === "item" && r.key === selectedTitle) ?? null)
      : null;

  // Kom man hit med ?titel= rullas tabellen fram en gång.
  const ref = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!selectedTitle || scrolled.current) return;
    scrolled.current = true;
    ref.current?.scrollIntoView({ block: "start" });
  }, [selectedTitle]);

  return (
    <section
      ref={ref}
      aria-labelledby="per-post"
      className="flex scroll-mt-28 flex-col gap-10 md:gap-12"
    >
      <SectionHeader
        id="per-post"
        eyebrow={`Lönsamhet per ${VIEW_NOUN[view]} · ${days}${NBSP}d`}
        title={heading.title}
        aside={heading.aside}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {tabs}
            <ExportButton
              view={view}
              rows={rows}
              totals={totals}
              sort={sort}
              fileName={`${fileStem}-per-${VIEW_PARAM[view]}`}
            />
          </div>
        }
      />
      {view === "title" && selectedTitle ? (
        <p className="-mt-4 text-sm text-muted md:-mt-6" role="status">
          {selected
            ? sentence(
                `Vald titel: ${selected.name}${
                  selected.orders === selected.unpricedOrders
                    ? ", saknar inköpspris"
                    : `, ${formatSek(selected.profitOre / 100)} i vår vinst${
                        selected.marginBp === null
                          ? ""
                          : ` och ${formatPercent(selected.marginBp / 10_000)} marginal`
                      }`
                }`,
              )
            : sentence(`Den valda titeln har inga order under ${periodLabel}`)}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <StateMessage kind="empty" message={sentence(`Inga order under ${periodLabel}`)} />
      ) : (
        <ProfitTable
          view={view}
          onViewChange={change}
          rows={rows}
          totals={totals}
          caption={`Lönsamhet per ${VIEW_NOUN[view]}, ${periodLabel}`}
          sort={sort}
          onSortChange={setSort}
          selectedKey={selected?.key ?? null}
          showStoreShare={showStoreShare}
          storeShareLabel={storeShareLabel}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 03 / Utveckling
// ---------------------------------------------------------------------------

const TREND_OPTIONS: ReadonlyArray<{ value: TrendKey; label: string }> = [
  { value: "day", label: "Dag" },
  { value: "week", label: "Vecka" },
  { value: "month", label: "Månad" },
];

function trendData(series: TrendSeries): TrendDatum[] {
  return series.buckets.map((b) => ({
    axis: b.partial ? `${b.axis}*` : b.axis,
    name: b.partial ? `${b.name} (delvis)` : b.name,
    partial: b.partial,
    profit: b.profitOre / 100,
    margin: b.marginBp === null ? null : b.marginBp / 10_000,
    revenue: (b.revenueOre + b.unpricedRevenueOre) / 100,
    orders: b.orders,
  }));
}

function trendSummary(series: TrendSeries, unit: string): string {
  const parts = series.buckets.map(
    (b) =>
      `${b.shortName} ${formatSek(b.profitOre / 100)}${
        b.marginBp === null ? "" : ` (${formatPercent(b.marginBp / 10_000)})`
      }`,
  );
  return `Vinst och marginal per ${unit}: ${parts.join(", ")}.`;
}

const UNIT: Record<TrendKey, { noun: string; one: string; plural: string }> = {
  day: { noun: "dag", one: "en dag", plural: "dagar" },
  week: { noun: "vecka", one: "en vecka", plural: "veckor" },
  month: { noun: "månad", one: "en månad", plural: "månader" },
};

export function TrendSection({
  tabs,
  initialTrend,
  trend,
  days,
}: {
  tabs?: ReactNode;
  initialTrend: TrendKey;
  trend: Record<TrendKey, TrendSeries>;
  days: number;
}) {
  const [key, setKey] = useState<TrendKey>(initialTrend);
  const change = (k: TrendKey) => {
    setKey(k);
    replaceParam("per", TREND_PARAM[k]);
  };
  const series = trend[key];
  const unit = UNIT[key];
  const partial = series.buckets.filter((b) => b.partial).length;
  const notes: string[] = [];
  if (partial > 0) {
    notes.push(
      partial === 1
        ? `* ${unit.one[0]?.toUpperCase()}${unit.one.slice(1)} ligger bara delvis i perioden.`
        : `* ${partial} ${unit.plural} ligger bara delvis i perioden.`,
    );
  }
  if (series.unallocatedProfitOre !== 0) {
    notes.push(
      `* Ej fördelad hyra ${formatSek(Math.abs(series.unallocatedProfitOre) / 100)} ingår bara i totalen.`,
    );
  }

  return (
    <section aria-labelledby="utveckling" className="flex scroll-mt-28 flex-col gap-10 md:gap-12">
      <SectionHeader
        id="utveckling"
        eyebrow={`Utveckling · ${days}${NBSP}d`}
        title={series.heading.title}
        aside={series.heading.aside}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {tabs}
            <Segmented
              options={TREND_OPTIONS}
              value={key}
              onChange={change}
              label="Upplösning"
              size="sm"
            />
          </div>
        }
      />
      <Panel>
        {series.buckets.length === 0 ? (
          <StateMessage kind="empty" compact message="Ingen försäljning i perioden." />
        ) : (
          <ProfitTrendChart
            data={trendData(series)}
            format={formatSek}
            summary={trendSummary(series, unit.noun)}
          />
        )}
        {notes.length > 0 ? <p className="mt-4 text-xs text-subtle">{notes.join(" ")}</p> : null}
      </Panel>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tabell · Utveckling i en sektion
// ---------------------------------------------------------------------------

const ANALYSIS_OPTIONS: ReadonlyArray<{ value: AnalysisTab; label: string }> = [
  { value: "table", label: "Tabell" },
  { value: "trend", label: "Utveckling" },
  { value: "rhythm", label: "Rytm" },
];

/**
 * Tabellen per titel/automat/butik, utvecklingen och försäljningsrytmen med topplistan,
 * bakom en växlare (?visa=). Rytmen ritas på servern och kommer in som färdigt innehåll.
 */
export function AnalysisSection({
  table,
  trend,
  rhythm,
  initialTab,
}: {
  table: Omit<ComponentProps<typeof TableSection>, "tabs">;
  trend: Omit<ComponentProps<typeof TrendSection>, "tabs">;
  rhythm: ReactNode;
  initialTab: AnalysisTab;
}) {
  // Kom man in med ?titel= gäller tabellen.
  const [tab, setTab] = useState<AnalysisTab>(table.selectedTitle ? "table" : initialTab);
  const change = (t: AnalysisTab) => {
    setTab(t);
    replaceParam("visa", ANALYSIS_PARAM[t]);
  };
  const tabs = (
    <Segmented options={ANALYSIS_OPTIONS} value={tab} onChange={change} label="Visa" size="sm" />
  );
  return (
    <div key={tab} className="fade-in">
      {tab === "table" ? (
        <TableSection {...table} tabs={tabs} />
      ) : tab === "trend" ? (
        <TrendSection {...trend} tabs={tabs} />
      ) : (
        <div id="rytm-och-topplista" className="flex scroll-mt-28 flex-col gap-8">
          <div className="flex justify-end">{tabs}</div>
          {rhythm}
        </div>
      )}
    </div>
  );
}
