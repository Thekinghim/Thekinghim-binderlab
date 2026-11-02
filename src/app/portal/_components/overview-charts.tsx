"use client";

import { BarChart, type BarDatum } from "@/components/charts/bar-chart";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { formatInt, formatSek } from "@/lib/format";

import { kr } from "./text";

export type PortalKpi = {
  id: "revenue" | "orders" | "average" | "compensation";
  label: string;
  /** Öre, eller antal för orders. */
  value: number | null;
  /** Relativ förändring som andel (0,08 = +8 %), eller absolut för antal. */
  delta: number | null;
  trend: number[];
};

const formats: Record<PortalKpi["id"], (v: number) => string> = {
  revenue: (v) => kr(v),
  orders: (v) => `${formatInt(v)} st`,
  average: (v) => kr(v),
  compensation: (v) => kr(v),
};

/** Nyckeltalen för månaden. Modellen är serialiserbar; formateringen väljs här. */
export function PortalKpis({ kpis, comparison }: { kpis: PortalKpi[]; comparison: string }) {
  const items: KpiItem[] = kpis.map((k) => ({
    id: k.id,
    label: k.label,
    value: k.value ?? Number.NaN,
    format: formats[k.id],
    delta:
      k.delta === null
        ? undefined
        : k.id === "orders"
          ? { delta: k.delta, kind: "absolute", unit: "st" }
          : { delta: k.delta, kind: "relative" },
    trend: k.trend.length > 1 ? k.trend : undefined,
    primary: k.id === "revenue",
  }));
  return <KpiStrip items={items} comparison={comparison} label="Månaden" />;
}

/** Försäljning per månad (staplar, värden i kronor). Vald månad annoteras, aldrig signal. */
export function TrendChart({
  data,
  summary,
  selectedIndex,
}: {
  data: BarDatum[];
  summary: string;
  selectedIndex: number;
}) {
  return (
    <BarChart
      data={data}
      orientation="vertical"
      format={(v) => formatSek(v)}
      unit="kr"
      height={240}
      peakIndex={selectedIndex}
      highlightNote="Vald månad"
      summary={summary}
    />
  );
}

/** Titlar som liggande staplar med värde till höger (värden i kronor). */
export function RankChart({
  data,
  summary,
  labelHeading,
  valueHeading,
}: {
  data: BarDatum[];
  summary: string;
  labelHeading: string;
  valueHeading: string;
}) {
  return (
    <BarChart
      data={data}
      format={(v) => formatSek(v)}
      unit="kr"
      labelHeading={labelHeading}
      valueHeading={valueHeading}
      summary={summary}
    />
  );
}
