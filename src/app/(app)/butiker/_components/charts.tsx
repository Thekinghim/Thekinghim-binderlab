"use client";

import { LineChart } from "@/components/charts/line-chart";
import { parseIsoDate } from "@/components/shell/period-state";
import { formatDate, formatSek } from "@/lib/format";

import type { DailyPoint } from "../_lib/types";

/** Butikens intäkt per dag (kronor) med jämförelseperioden streckad. */
export function StoreRevenueChart({
  name,
  daily,
  compare,
  compareName,
}: {
  name: string;
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
      unit="kr"
      reference={{ value: mean, label: "Snitt" }}
      seriesName={name}
      summary={`Intäkt per dag i ${name}: totalt ${formatSek(total)}, snitt ${formatSek(mean)} per dag${
        peakDate
          ? `, högst ${formatDate(peakDate, { year: "never" })} med ${formatSek(daily[peak]?.value ?? 0)}`
          : ""
      }. Piltangenterna flyttar mellan dagarna.`}
    />
  );
}
