"use client";

import { useMemo, useState } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { Panel } from "@/components/ui/frame";
import { Segmented } from "@/components/ui/segmented";
import { StatusTag } from "@/components/ui/status-tag";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";

import { dayText, periodShort } from "../_lib/dates";
import type { ForecastModel, ForecastRow } from "../_lib/model";
import { kr, packsMilli } from "../_lib/units";
import { EvidenceButton } from "./evidence-button";
import { ForecastChart, type ForecastMetric } from "./forecast-chart";

type Group = "title" | "machine" | "series";

const METRICS = [
  { value: "revenue", label: "Intäkt" },
  { value: "units", label: "Pack" },
] as const;

const GROUPS = [
  { value: "title", label: "Per titel" },
  { value: "machine", label: "Per automat" },
  { value: "series", label: "Titel × automat" },
] as const;

/** Datamängden bakom raden: "Lite data" eller "Tillräcklig". */
function DataStatus({ lowData }: { lowData: boolean }) {
  return lowData ? (
    <StatusTag status="neutral">Lite data</StatusTag>
  ) : (
    <StatusTag status="ok">Tillräcklig</StatusTag>
  );
}

function value(row: { revenueOre: number; unitsMilli: number }, metric: ForecastMetric): string {
  return metric === "revenue" ? kr(row.revenueOre) : packsMilli(row.unitsMilli);
}

function range(
  w: {
    revenueLowOre: number;
    revenueHighOre: number;
    unitsLowMilli: number;
    unitsHighMilli: number;
  },
  metric: ForecastMetric,
): string {
  return metric === "revenue"
    ? `${kr(w.revenueLowOre).replace(/\s?kr$/, "")}–${kr(w.revenueHighOre)}`
    : `${packsMilli(w.unitsLowMilli)}–${packsMilli(w.unitsHighMilli)}`;
}

/** Prognosdiagrammet, veckodagarna och tabellen per titel, automat eller serie. */
export function ForecastView({ model }: { model: ForecastModel }) {
  const [metric, setMetric] = useState<ForecastMetric>("revenue");
  const [group, setGroup] = useState<Group>("title");

  const rows =
    group === "title" ? model.byTitle : group === "machine" ? model.byMachine : model.bySeries;

  const columns = useMemo<Column<ForecastRow>[]>(() => {
    const amount = (w: { revenueOre: number; unitsMilli: number } | undefined) =>
      metric === "revenue" ? (w?.revenueOre ?? 0) : (w?.unitsMilli ?? 0);
    // Samma värde varje vecka på alla rader (ingen trend eller släppkurva i perioden):
    // en kolumn "Per vecka" i stället för fyra likadana.
    const flat = rows.every((r) => r.weeks.every((w) => amount(w) === amount(r.weeks[0])));
    const perWeek: Column<ForecastRow> = {
      key: "w0",
      header: "Per vecka",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => amount(r.weeks[0]),
      render: (r) => (r.weeks[0] ? value(r.weeks[0], metric) : "–"),
      csv: (r) => amount(r.weeks[0]) / (metric === "revenue" ? 100 : 1000),
    };
    const weekCols: Column<ForecastRow>[] = flat
      ? [perWeek]
      : model.weeks.map((w, i) => ({
          key: `w${i}`,
          header: `Från ${dayText(w.start)}`,
          numeric: true,
          hideOnMobile: true,
          sortValue: (r) =>
            metric === "revenue" ? (r.weeks[i]?.revenueOre ?? 0) : (r.weeks[i]?.unitsMilli ?? 0),
          render: (r) => (r.weeks[i] ? value(r.weeks[i]!, metric) : "–"),
          csv: (r) =>
            metric === "revenue"
              ? (r.weeks[i]?.revenueOre ?? 0) / 100
              : (r.weeks[i]?.unitsMilli ?? 0) / 1000,
        }));
    return [
      {
        key: "name",
        header: group === "machine" ? "Automat" : "Titel",
        sortValue: (r) => r.name,
        render: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{r.name}</span>
            {r.sub ? <span className="text-xs text-subtle">{r.sub}</span> : null}
            {/* Under md står dataläget här; kolumnen Data är dold (design.md §5.1). */}
            <span className="mt-1 md:hidden">
              <DataStatus lowData={r.lowData} />
            </span>
          </span>
        ),
        csv: (r) => (r.sub && group === "series" ? `${r.name} – ${r.sub}` : r.name),
      },
      ...weekCols,
      {
        key: "total",
        header: "4 veckor",
        numeric: true,
        sortValue: (r) => (metric === "revenue" ? r.total.revenueOre : r.total.unitsMilli),
        render: (r) => <span className="text-fg">{value(r.total, metric)}</span>,
        csv: (r) => (metric === "revenue" ? r.total.revenueOre / 100 : r.total.unitsMilli / 1000),
      },
      {
        key: "range",
        header: `Intervall ${model.coverage}`,
        numeric: true,
        // Intervallet för hela prognosen står i rubriken; under md ryms tabellen utan scroll.
        hideOnMobile: true,
        sortValue: (r) => (metric === "revenue" ? r.total.revenueHighOre : r.total.unitsHighMilli),
        render: (r) => <span className="text-muted">{range(r.total, metric)}</span>,
        csv: (r) => range(r.total, metric),
      },
      {
        key: "status",
        header: "Data",
        hideable: false,
        hideOnMobile: true,
        render: (r) => <DataStatus lowData={r.lowData} />,
        csv: (r) => (r.lowData ? "Lite data" : "Tillräcklig"),
      },
      {
        key: "evidence",
        header: "Underlag",
        hideable: false,
        render: (r) => (
          <EvidenceButton
            evidence={r.evidence}
            title={r.sub && group === "series" ? `${r.name} i ${r.sub}` : r.name}
            text={r.explanation ? `${r.text} ${r.explanation}` : r.text}
          />
        ),
      },
    ];
  }, [model.weeks, model.coverage, metric, group, rows]);

  if (model.bySeries.length === 0) {
    return (
      <StateMessage
        kind="empty"
        message="Ingen försäljning de senaste 8 veckorna."
        action={{ label: "Öppna Datakällor", href: "/datakallor" }}
      />
    );
  }

  const maxWeekday = Math.max(
    1,
    ...model.weekdays.map((d) => (metric === "revenue" ? d.revenueOre : d.unitsMilli)),
  );
  const strongest = [...model.weekdays].sort((a, b) => b.revenueOre - a.revenueOre)[0];
  const summary =
    `${model.totalText} Utfall per vecka de senaste ${model.history.length} veckorna och prognos ` +
    `per vecka med ${model.coverage}-intervall.`;

  return (
    <div className="flex flex-col gap-10">
      <Panel grid marks>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="label text-subtle">
              {metric === "revenue" ? "Intäkt per vecka" : "Sålda pack per vecka"}
              {NBSP}· utfall och prognos
            </p>
            <Segmented
              label="Mått i diagram och tabell"
              options={METRICS}
              value={metric}
              onChange={setMetric}
              size="sm"
            />
          </div>
          <ForecastChart
            history={model.history}
            weeks={model.weeks}
            metric={metric}
            coverage={model.coverage}
            summary={summary}
          />
        </div>
      </Panel>

      <section aria-labelledby="veckodagar" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 id="veckodagar" className="label text-subtle">
            Veckodagar · {periodShort(model.horizon)}
          </h3>
          {strongest ? (
            <p className="text-md text-fg">
              {strongest.plural} väntas ge mest, {kr(strongest.revenueOre)} på fyra veckor.
            </p>
          ) : null}
        </div>
        <ol className="grid grid-cols-4 gap-x-2 gap-y-4 sm:grid-cols-7">
          {model.weekdays.map((d) => {
            const v = metric === "revenue" ? d.revenueOre : d.unitsMilli;
            return (
              <li key={d.weekday} className="flex min-w-0 flex-col gap-1.5">
                <span className="label text-subtle">{d.label}</span>
                <span className="h-1 w-full bg-hover" aria-hidden>
                  <span
                    className="block h-1 bg-data-2"
                    style={{ width: `${Math.round((v / maxWeekday) * 100)}%` }}
                  />
                </span>
                <span className="meta tnum truncate text-fg">
                  {metric === "revenue" ? kr(d.revenueOre) : packsMilli(d.unitsMilli)}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {group === "series"
              ? `${model.bySeries.length} serier`
              : group === "title"
                ? `${model.byTitle.length} titlar`
                : `${model.byMachine.length} automater`}
            {model.lowDataSeries > 0
              ? `; ${model.lowDataSeries} av ${model.bySeries.length} serier har under 14 dagar med data.`
              : "."}
          </p>
          <Segmented
            label="Gruppering"
            options={GROUPS}
            value={group}
            onChange={setGroup}
            size="sm"
          />
        </div>
        <DataTable
          surface="bg"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          caption={`Prognos kommande 4 veckor ${group === "title" ? "per titel" : group === "machine" ? "per automat" : "per titel och automat"}`}
          defaultSort={{ key: "total", dir: "desc" }}
          dense
          exportFileName={`prognos-${model.horizon.start}`}
        />
        {model.ordersWithoutMachine > 0 ? (
          <p className="text-xs text-subtle">
            {formatInt(model.ordersWithoutMachine)} order saknar automat och ingår inte. Koppla
            automaterna i Datakällor.
          </p>
        ) : null}
      </div>
    </div>
  );
}
