"use client";

import { useMemo, useState } from "react";

import type { EffectSeries } from "@/analytics/effect";
import { signedKr, signedPct } from "@/analytics/expansion";
import { roundHalfUp } from "@/domain";
import { LineChart } from "@/components/charts/line-chart";
import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { formatDecimal, formatInt, formatSek, MISSING, NBSP } from "@/lib/format";

import { EvidenceDetails } from "../../expansion/_components/evidence";
import { DeleteButton, FormModal, type FieldSpec } from "../../expansion/_components/form-kit";
import type { Named } from "../../expansion/_lib/data";
import {
  kr,
  minutesText,
  minutesToHoursInput,
  monthLabel,
  oreToInput,
  tenths,
} from "../../expansion/_lib/display";
import type { EvidenceLink } from "../../expansion/_lib/model";
import type {
  BaselineRecord,
  EffectSettingsRecord,
  MeasurementRecord,
} from "../../expansion/_lib/service";
import {
  deleteBaseline,
  deleteMeasurement,
  saveBaseline,
  saveEffectSettings,
  saveMeasurement,
} from "../actions";

export const METRIC_LABEL: Record<BaselineRecord["metric"], string> = {
  profit_per_machine_month: "Vinst per automat och månad",
  stockout_days_month: "Slutsålda dagar per månad",
  refill_hours_month: "Tid för påfyllning per månad",
  admin_hours_month: "Tid för administration per månad",
};

const METRIC_OPTIONS = (Object.keys(METRIC_LABEL) as BaselineRecord["metric"][]).map((m) => ({
  value: m,
  label: METRIC_LABEL[m],
}));

/** Värde i måttets enhet som text. */
export function metricValue(metric: BaselineRecord["metric"], v: number | null): string {
  if (v === null) return MISSING;
  if (metric === "profit_per_machine_month") return kr(v);
  if (metric === "stockout_days_month") return `${formatInt(v)}${NBSP}${v === 1 ? "dag" : "dagar"}`;
  return minutesText(v);
}

function valueInput(metric: BaselineRecord["metric"], v: number): string {
  if (metric === "profit_per_machine_month") return oreToInput(v);
  if (metric === "stockout_days_month") return String(v);
  return minutesToHoursInput(v);
}

function scopeLabel(
  r: { scope: string; storeId: string | null; machineId: string | null },
  stores: ReadonlyArray<Named>,
  machines: ReadonlyArray<Named>,
): string {
  if (r.scope === "store") return stores.find((s) => s.id === r.storeId)?.name ?? "Butik";
  if (r.scope === "machine") {
    const m = machines.find((x) => x.id === r.machineId);
    return m ? `${m.code ?? ""} ${m.name}`.trim() : "Automat";
  }
  return "Hela flottan";
}

function scopeFields(stores: ReadonlyArray<Named>, machines: ReadonlyArray<Named>): FieldSpec[] {
  return [
    {
      name: "scope",
      label: "Gäller",
      type: "select",
      required: true,
      options: [
        { value: "organization", label: "Hela flottan" },
        { value: "store", label: "En butik" },
        { value: "machine", label: "En automat" },
      ],
    },
    {
      name: "storeId",
      label: "Butik",
      type: "select",
      required: true,
      options: stores.filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name })),
      when: (v) => v.scope === "store",
    },
    {
      name: "machineId",
      label: "Automat",
      type: "select",
      required: true,
      options: machines
        .filter((m) => !m.archived)
        .map((m) => ({ value: m.id, label: `${m.code ?? ""} ${m.name}`.trim() })),
      when: (v) => v.scope === "machine",
    },
  ];
}

function valueField(metricKey = "metric"): FieldSpec[] {
  return [
    {
      name: "value",
      label: "Värde",
      type: "decimal",
      suffix: "kr",
      required: true,
      when: (v) => v[metricKey] === "profit_per_machine_month",
    },
    {
      name: "value",
      label: "Värde",
      type: "integer",
      suffix: "dagar",
      required: true,
      when: (v) => v[metricKey] === "stockout_days_month",
    },
    {
      name: "value",
      label: "Värde",
      type: "decimal",
      suffix: "h",
      required: true,
      hint: "Timmar per månad, t.ex. 12,5.",
      when: (v) => v[metricKey] === "refill_hours_month" || v[metricKey] === "admin_hours_month",
    },
  ];
}

/** En serie: svaret, diagram mot utgångsläget och månaderna i tabell. */
export function SeriesView({
  series,
  links,
  scope,
}: {
  series: EffectSeries;
  links: EvidenceLink[];
  scope: string;
}) {
  const points = series.points.filter((p) => p.value !== null);
  const toChart = (v: number) =>
    series.metric === "profit_per_machine_month"
      ? v / 100
      : series.metric === "stockout_days_month"
        ? v
        : v / 60;
  const unit =
    series.metric === "profit_per_machine_month"
      ? ("kr" as const)
      : series.metric === "stockout_days_month"
        ? { label: "dagar" }
        : { label: "h" };
  const fmt = (v: number) =>
    series.metric === "profit_per_machine_month"
      ? formatSek(v)
      : series.metric === "stockout_days_month"
        ? `${formatDecimal(v)}${NBSP}d`
        : `${formatDecimal(v)}${NBSP}h`;
  const [y0, m0] = (series.points[0]?.month ?? "2026-01").split("-").map(Number) as [
    number,
    number,
  ];
  return (
    <article className="flex flex-col gap-6 border-t border-line pt-6">
      <div className="flex flex-col gap-2">
        <p className="label text-subtle">
          {METRIC_LABEL[series.metric]} · {scope}
        </p>
        <p className="max-w-3xl text-md text-fg">{series.text}</p>
        {series.detail ? <p className="max-w-3xl text-sm text-muted">{series.detail}</p> : null}
      </div>
      {points.length >= 2 ? (
        <LineChart
          data={series.points.map((p, i) => ({
            date: new Date(y0, m0 - 1 + i, 1),
            value: p.value === null ? 0 : toChart(p.value),
          }))}
          format={fmt}
          unit={unit}
          reference={{ value: toChart(series.baseline), label: "Före Binderlab" }}
          height={200}
          seriesName={METRIC_LABEL[series.metric]}
          summary={`${METRIC_LABEL[series.metric]} per månad jämfört med utgångsläget.`}
        />
      ) : null}
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-base">
          <caption className="sr-only">{METRIC_LABEL[series.metric]} per månad</caption>
          <thead>
            <tr className="border-b border-line-strong">
              {["Månad", "Värde", "Före Binderlab", "Förbättring", "I kronor"].map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  className={cn(
                    "label h-9 font-normal text-subtle",
                    i === 0 ? "text-left" : "text-right",
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.points.map((p) => (
              <tr key={p.month} className="h-11 border-b border-line">
                <td className="pr-4">
                  {monthLabel(p.month)}
                  {p.partial ? <span className="meta text-subtle"> · hittills</span> : null}
                </td>
                <td className="tnum text-right">{metricValue(series.metric, p.value)}</td>
                <td className="tnum text-right text-muted">
                  {series.metric === "profit_per_machine_month"
                    ? kr(series.baseline)
                    : series.metric === "stockout_days_month"
                      ? `${tenths(p.baselineForPeriodTenths)}${NBSP}dagar`
                      : minutesText(roundHalfUp(p.baselineForPeriodTenths, 10))}
                </td>
                <td className="tnum text-right">
                  {p.improvementBp === null ? MISSING : signedPct(p.improvementBp)}
                </td>
                <td className="tnum text-right">
                  {p.improvementOre === null ? MISSING : signedKr(p.improvementOre)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <EvidenceDetails evidence={series.evidence} links={links} />
    </article>
  );
}

/** Utgångsläget: lista och formulär. */
export function BaselinesSection({
  baselines,
  stores,
  machines,
  canEdit,
}: {
  baselines: ReadonlyArray<BaselineRecord>;
  stores: ReadonlyArray<Named>;
  machines: ReadonlyArray<Named>;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<BaselineRecord | "new" | null>(null);
  const fields = useMemo<FieldSpec[]>(
    () => [
      {
        name: "metric",
        label: "Mått",
        type: "select",
        required: true,
        options: METRIC_OPTIONS,
        span: 2,
      },
      ...valueField(),
      ...scopeFields(stores, machines),
      { name: "measuredFrom", label: "Mätt från", type: "date" },
      { name: "measuredTo", label: "Mätt till", type: "date" },
      {
        name: "source",
        label: "Källa",
        type: "text",
        span: 2,
        placeholder: "t.ex. tidrapport sommaren 2026",
      },
    ],
    [stores, machines],
  );
  const b = editing && editing !== "new" ? editing : null;
  const initial = {
    metric: b?.metric ?? "profit_per_machine_month",
    value: b ? valueInput(b.metric, b.value) : "",
    scope: b?.scope ?? "organization",
    storeId: b?.storeId ?? stores[0]?.id ?? "",
    machineId: b?.machineId ?? machines[0]?.id ?? "",
    measuredFrom: b?.measuredFrom ?? "",
    measuredTo: b?.measuredTo ?? "",
    source: b?.source ?? "",
  };
  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" iconLeft="plus" onClick={() => setEditing("new")}>
            Nytt utgångsläge
          </Button>
        </div>
      ) : null}
      {baselines.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Utgångsläget är inte registrerat."
          detail="Ange hur det var före Binderlab: vinst per automat och månad, slutsålda dagar och tid för påfyllning och administration per månad."
        />
      ) : (
        <ul className="flex flex-col">
          {baselines.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 last:border-b"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-base text-fg">
                  {METRIC_LABEL[r.metric]}:{" "}
                  <span className="tnum">{metricValue(r.metric, r.value)}</span>
                </p>
                <p className="meta text-subtle">
                  {scopeLabel(r, stores, machines)}
                  {r.measuredFrom && r.measuredTo
                    ? ` · mätt ${r.measuredFrom} – ${r.measuredTo}`
                    : ""}
                  {r.source ? ` · ${r.source}` : ""}
                </p>
              </div>
              {canEdit ? (
                <span className="flex gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    Ändra
                  </Button>
                  <DeleteButton
                    action={deleteBaseline}
                    id={r.id}
                    what="utgångsläget"
                    success="Utgångsläget är borttaget"
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nytt utgångsläge" : "Ändra utgångsläge"}
        eyebrow="Före Binderlab"
        description="Ett värde per mått och omfattning. Tid anges i timmar per månad."
        fields={fields}
        initial={initial}
        fixed={{ id: b?.id ?? null }}
        action={saveBaseline}
        success="Utgångsläget är sparat"
      />
    </div>
  );
}

/** Mätvärden per månad (slutsålda dagar, tid) och timkostnaden. */
export function MeasurementsSection({
  measurements,
  settings,
  stores,
  machines,
  canEdit,
  defaultMonth,
}: {
  measurements: ReadonlyArray<MeasurementRecord>;
  settings: EffectSettingsRecord;
  stores: ReadonlyArray<Named>;
  machines: ReadonlyArray<Named>;
  canEdit: boolean;
  defaultMonth: string;
}) {
  const [editing, setEditing] = useState<MeasurementRecord | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fields = useMemo<FieldSpec[]>(
    () => [
      {
        name: "metric",
        label: "Mått",
        type: "select",
        required: true,
        options: METRIC_OPTIONS.filter((o) => o.value !== "profit_per_machine_month"),
        span: 2,
      },
      { name: "month", label: "Månad", type: "month", required: true, placeholder: "ÅÅÅÅ-MM" },
      ...valueField(),
      ...scopeFields(stores, machines),
      { name: "note", label: "Anteckning", type: "text", span: 2 },
    ],
    [stores, machines],
  );
  const m = editing && editing !== "new" ? editing : null;
  const initial = {
    metric: m?.metric ?? "refill_hours_month",
    month: m?.month ?? defaultMonth,
    value: m ? valueInput(m.metric, m.value) : "",
    scope: m?.scope ?? "organization",
    storeId: m?.storeId ?? stores[0]?.id ?? "",
    machineId: m?.machineId ?? machines[0]?.id ?? "",
    note: m?.note ?? "",
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="meta text-muted">
          Timkostnad{" "}
          {settings.hourlyCostOre === null ? "ej angiven" : `${kr(settings.hourlyCostOre)}/h`}
          {" · "}
          Värde per slutsåld dag{" "}
          {settings.stockoutDayValueOre === null
            ? "= vinst per automat och dag"
            : kr(settings.stockoutDayValueOre)}
        </p>
        {canEdit ? (
          <span className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={() => setSettingsOpen(true)}>
              Timkostnad
            </Button>
            <Button type="button" iconLeft="plus" onClick={() => setEditing("new")}>
              Nytt mätvärde
            </Button>
          </span>
        ) : null}
      </div>
      {measurements.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Inga mätvärden ännu. Slutsålda dagar och tid för påfyllning och administration läggs in per månad."
        />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-base">
            <caption className="sr-only">Mätvärden per månad</caption>
            <thead>
              <tr className="border-b border-line-strong">
                {["Månad", "Mått", "Gäller", "Värde", ""].map((h, i) => (
                  <th
                    key={h || "x"}
                    scope="col"
                    className={cn(
                      "label h-9 font-normal text-subtle",
                      i === 3 ? "text-right" : "text-left",
                    )}
                  >
                    {h || <span className="sr-only">Åtgärd</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {measurements.map((r) => (
                <tr key={r.id} className="h-11 border-b border-line">
                  <td className="pr-4">{monthLabel(r.month)}</td>
                  <td className="pr-4 text-muted">{METRIC_LABEL[r.metric]}</td>
                  <td className="pr-4 text-muted">{scopeLabel(r, stores, machines)}</td>
                  <td className="tnum text-right">{metricValue(r.metric, r.value)}</td>
                  <td className="text-right">
                    {canEdit ? (
                      <span className="inline-flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(r)}
                        >
                          Ändra
                        </Button>
                        <DeleteButton
                          action={deleteMeasurement}
                          id={r.id}
                          what="mätvärdet"
                          success="Mätvärdet är borttaget"
                        />
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nytt mätvärde" : "Ändra mätvärde"}
        eyebrow="Effekt"
        description="Ett värde per månad, mått och omfattning. Tid i timmar."
        fields={fields}
        initial={initial}
        fixed={{ id: m?.id ?? null }}
        action={saveMeasurement}
        success="Mätvärdet är sparat"
      />
      <FormModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Timkostnad och värde per slutsåld dag"
        eyebrow="Effekt"
        description="Används för att räkna tid och slutsålda dagar i kronor. Tomt = visas bara i tid, respektive värderas med vinst per automat och dag."
        fields={[
          { name: "hourlyCostOre", label: "Timkostnad", type: "decimal", suffix: "kr/h" },
          {
            name: "stockoutDayValueOre",
            label: "Värde per slutsåld dag",
            type: "decimal",
            suffix: "kr",
          },
        ]}
        initial={{
          hourlyCostOre: oreToInput(settings.hourlyCostOre),
          stockoutDayValueOre: oreToInput(settings.stockoutDayValueOre),
        }}
        action={saveEffectSettings}
        success="Inställningarna är sparade"
      />
    </div>
  );
}
