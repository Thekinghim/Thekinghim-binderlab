"use client";

import { BarChart, type BarDatum } from "@/components/charts/bar-chart";
import { Heatmap } from "@/components/charts/heatmap";
import { LineChart } from "@/components/charts/line-chart";
import { parseIsoDate } from "@/components/shell/period-state";
import { formatDate, formatInt, formatSek, NBSP } from "@/lib/format";

import type { DailyPoint, HeatmapView, TitleShare } from "../_lib/types";

const WEEKDAYS_LONG = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

function hourRange(hour: number): string {
  return `${String(hour).padStart(2, "0")}–${String((hour + 1) % 24).padStart(2, "0")}`;
}

/** Intäkt per dag (kronor) med jämförelseperioden streckad. */
export function RevenueChart({
  code,
  daily,
  compare,
  compareName,
}: {
  code: string;
  daily: readonly DailyPoint[];
  compare: readonly number[] | null;
  compareName?: string;
}) {
  const data = daily.flatMap((d) => {
    const date = parseIsoDate(d.date);
    return date ? [{ date, value: d.value }] : [];
  });
  const total = daily.reduce((s, d) => s + d.value, 0);
  const mean = daily.length > 0 ? total / daily.length : 0;
  const peak = daily.reduce((b, d, i) => (d.value > (daily[b]?.value ?? 0) ? i : b), 0);
  const peakDate = data[peak]?.date;
  const sameLength = compare && compare.length === data.length ? compare : undefined;
  return (
    <LineChart
      data={data}
      compare={sameLength}
      compareName={sameLength ? compareName : undefined}
      format={formatSek}
      reference={{ value: mean, label: "Snitt" }}
      seriesName={code}
      summary={`Intäkt per dag för ${code}: totalt ${formatSek(total)}, snitt ${formatSek(mean)} per dag${
        peakDate
          ? `, högst ${formatDate(peakDate, { year: "never" })} med ${formatSek(daily[peak]?.value ?? 0)}`
          : ""
      }. Piltangenterna flyttar mellan dagarna.`}
    />
  );
}

/** Titlarna i automaten som liggande staplar (intäkt, kronor). */
export function TitleBars({ titles }: { titles: readonly TitleShare[] }) {
  const data: BarDatum[] = titles.map((t) => ({
    label: t.name,
    name: t.name,
    value: t.revenueOre / 100,
  }));
  return (
    <BarChart
      data={data}
      format={formatSek}
      labelHeading="Titel"
      valueHeading="Intäkt"
      summary={`Intäkt per titel: ${titles
        .map((t) => `${t.name} ${formatSek(t.revenueOre / 100)} (${formatInt(t.orders)} st)`)
        .join(", ")}.`}
    />
  );
}

/** Köp per veckodag och timme. */
export function SalesHeatmap({ heat, days }: { heat: HeatmapView; days: number }) {
  const peak = heat.peak;
  return (
    <Heatmap
      values={heat.values}
      rowLabels={heat.rowLabels}
      colLabels={heat.colLabels}
      format={(v) => `${formatInt(v)}${NBSP}köp`}
      unit="köp"
      cellLabel={(r, c) => `${heat.rowLabels[r] ?? ""} ${hourRange(heat.firstHour + c)}`}
      summary={`Antal köp per veckodag och timme, summerat över ${formatInt(days)} dagar: ${formatInt(heat.total)} köp.${
        peak
          ? ` Flest på ${WEEKDAYS_LONG[peak.weekday] ?? ""} ${hourRange(peak.hour)} med ${formatInt(peak.count)} köp.`
          : ""
      } Piltangenterna flyttar mellan timmar och dagar.`}
    />
  );
}
