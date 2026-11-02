"use client";

import { LineChart } from "@/components/charts/line-chart";
import { formatKronor } from "@/lib/format";

/** Inköpspris per pack över inköpen för en titel, med medianen som hjälplinje. */
export function PriceChart({
  points,
  medianOre,
  medianLabel,
  summary,
  marker,
}: {
  points: ReadonlyArray<{ date: string; ore: number }>;
  medianOre: number;
  medianLabel: string;
  summary: string;
  /** Ett inköp som avviker (index i points) och dess notering. */
  marker?: { index: number; note: string } | null;
}) {
  const data = points.map((p) => {
    const [y, m, d] = p.date.split("-").map(Number) as [number, number, number];
    return { date: new Date(y, m - 1, d, 12), value: p.ore / 100 };
  });
  return (
    <LineChart
      data={data}
      format={(v) => formatKronor(v)}
      unit="kr"
      area={false}
      height={240}
      reference={{ value: medianOre / 100, label: medianLabel }}
      alertIndex={marker?.index}
      alertNote={marker?.note}
      seriesName="Pris per pack"
      summary={summary}
    />
  );
}
