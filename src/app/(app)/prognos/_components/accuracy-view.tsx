"use client";

import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { StateMessage } from "@/components/ui/state-message";
import { formatDelta, MISSING } from "@/lib/format";

import { periodShort } from "../_lib/dates";
import type { AccuracyModel, AccuracyOrigin } from "../_lib/model";
import { packsMilli, percentBp } from "../_lib/units";
import { EvidenceButton } from "./evidence-button";

/** Träffsäkerheten: backtest med rullande ursprung, per vecka och sammanfattat. */
export function AccuracyView({ model }: { model: AccuracyModel }) {
  const columns = useMemo<Column<AccuracyOrigin>[]>(
    () => [
      {
        key: "period",
        header: "Vecka",
        sortValue: (r) => r.period.start,
        render: (r) => <span className="tnum">{periodShort(r.period)}</span>,
        csv: (r) => `${r.period.start}–${r.period.end}`,
      },
      {
        key: "actual",
        header: "Utfall i testade serier, pack",
        numeric: true,
        sortValue: (r) => r.actualMilli,
        render: (r) => packsMilli(r.actualMilli),
        csv: (r) => r.actualMilli / 1000,
      },
      {
        key: "forecast",
        header: "Prognos, pack",
        numeric: true,
        sortValue: (r) => r.forecastMilli,
        render: (r) => <span className="text-fg">{packsMilli(r.forecastMilli)}</span>,
        csv: (r) => r.forecastMilli / 1000,
      },
      {
        key: "error",
        header: "Avvikelse",
        numeric: true,
        sortValue: (r) => (r.errorBp === null ? Number.NaN : r.errorBp),
        render: (r) => (r.errorBp === null ? MISSING : formatDelta(r.errorBp / 10_000)),
        csv: (r) => (r.errorBp === null ? null : r.errorBp / 100),
      },
      {
        key: "naive",
        header: "Förra veckans snitt",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.naiveMilli,
        render: (r) => <span className="text-muted">{packsMilli(r.naiveMilli)}</span>,
        csv: (r) => r.naiveMilli / 1000,
      },
    ],
    [],
  );

  if (model.origins.length === 0) {
    return (
      <StateMessage
        kind="empty"
        message="Det finns ännu ingen vecka att jämföra: backtesten behöver minst två veckor historik före en testvecka."
        detail={model.text}
      />
    );
  }

  const t = model.total;
  const items: KpiItem[] = [
    {
      id: "wape",
      label: "Fel per dag (WAPE)",
      value: t.wapeBp ?? Number.NaN,
      format: (v) => percentBp(Number.isFinite(v) ? v : null, 0),
      primary: true,
    },
    {
      id: "mape",
      label: "Fel per vecka (MAPE)",
      value: t.mapeBp ?? Number.NaN,
      format: (v) => percentBp(Number.isFinite(v) ? v : null, 0),
    },
    {
      id: "bias",
      label: "Bias",
      value: t.biasBp ?? Number.NaN,
      format: (v) => (Number.isFinite(v) ? formatDelta(v / 10_000) : MISSING),
    },
    {
      id: "naive",
      label: "Förra veckans snitt",
      value: t.naiveWapeBp ?? Number.NaN,
      format: (v) => percentBp(Number.isFinite(v) ? v : null, 0),
    },
    {
      id: "series",
      label: "Per titel och automat",
      value: model.series.wapeBp ?? Number.NaN,
      format: (v) => percentBp(Number.isFinite(v) ? v : null, 0),
    },
  ];

  return (
    <div className="flex flex-col gap-10">
      <KpiStrip label={`Backtest · ${model.origins.length} veckor`} items={items} />
      <div className="flex flex-col gap-3">
        <DataTable
          columns={columns}
          rows={model.origins}
          rowKey={(r) => r.origin}
          caption="Prognos mot utfall per testvecka, summan av de testade titlarna och automaterna"
          defaultSort={{ key: "period", dir: "desc" }}
          dense
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <p className="max-w-[68ch] text-sm text-muted">{model.note}</p>
          <EvidenceButton evidence={model.evidence} title="Träffsäkerhet" text={model.text} />
        </div>
      </div>
    </div>
  );
}
