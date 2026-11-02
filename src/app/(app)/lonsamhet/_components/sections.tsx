"use client";

import { useEffect, useRef, useState } from "react";

import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { Segmented } from "@/components/ui/segmented";
import { StateMessage } from "@/components/ui/state-message";
import { formatPercent, formatSek, NBSP } from "@/lib/format";

import { sentence, type SectionTitle } from "../_lib/headline";
import type { ProfitLine, TrendKey, TrendSeries, ViewKey } from "../_lib/model";
import { TREND_PARAM, VIEW_PARAM } from "../_lib/params";
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
  index,
  initialView,
  views,
  titles,
  totals,
  periodLabel,
  days,
  fileStem,
  selectedTitle,
}: {
  index: number;
  initialView: ViewKey;
  views: Record<ViewKey, ProfitLine[]>;
  titles: Record<ViewKey, SectionTitle>;
  totals: ProfitLine;
  periodLabel: string;
  days: number;
  fileStem: string;
  /** Titel från ?titel= som markeras i vyn per titel. */
  selectedTitle: string | null;
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
        index={index}
        eyebrow={`Lönsamhet per ${VIEW_NOUN[view]} · ${days}${NBSP}d`}
        title={heading.title}
        aside={heading.aside}
        actions={
          <ExportButton
            view={view}
            rows={rows}
            totals={totals}
            sort={sort}
            fileName={`${fileStem}-per-${VIEW_PARAM[view]}`}
          />
        }
      />
      {view === "title" && selectedTitle ? (
        <p className="-mt-4 text-sm text-muted md:-mt-6" role="status">
          {selected
            ? sentence(
                `Vald titel: ${selected.name}${
                  selected.orders === selected.unpricedOrders
                    ? ", saknar inköpspris"
                    : `, ${formatSek(selected.profitOre / 100)} i vinst${
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
  index,
  initialTrend,
  trend,
  days,
}: {
  index: number;
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
      `Ej fördelad hyra ${formatSek(Math.abs(series.unallocatedProfitOre) / 100)} ingår i totalen men inte i någon ${unit.noun}.`,
    );
  }

  return (
    <section aria-labelledby="utveckling" className="flex scroll-mt-28 flex-col gap-10 md:gap-12">
      <SectionHeader
        id="utveckling"
        index={index}
        eyebrow={`Utveckling · ${days}${NBSP}d`}
        title={series.heading.title}
        aside={series.heading.aside}
        actions={
          <Segmented
            options={TREND_OPTIONS}
            value={key}
            onChange={change}
            label="Upplösning"
            size="sm"
          />
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
        {notes.length > 0 ? <p className="meta mt-4 text-subtle">{notes.join(" ")}</p> : null}
      </Panel>
    </section>
  );
}
