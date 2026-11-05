"use client";

import { BarChart } from "@/components/charts/bar-chart";
import { formatSek } from "@/lib/format";

/** MRR i kronor per månad (SEK). Den pågående månaden mäts i dag. */
export function MrrChart({
  data,
  summary,
}: {
  data: ReadonlyArray<{ label: string; value: number; note?: string }>;
  summary: string;
}) {
  return (
    <BarChart
      data={data}
      orientation="vertical"
      format={(v) => formatSek(v)}
      unit="kr"
      height={220}
      summary={summary}
    />
  );
}
