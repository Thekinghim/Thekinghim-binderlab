"use client";

import { useMemo } from "react";

import { LineChart, type Annotation } from "@/components/charts/line-chart";
import { formatSek } from "@/lib/format";

import { dateOf } from "./text";

/**
 * Huvuddiagrammet: intäkt per dag (kr), toppen annoterad, jämförelseperioden streckad
 * och snittet som hjälplinje. Talen kommer färdiga från modellen (öre → kr här).
 */
export function DailyChart({
  dates,
  revenueOre,
  compareOre,
  peakIndex,
  peakNote,
  averageOre,
  averageLabel,
  compareName,
  summary,
}: {
  dates: string[];
  revenueOre: number[];
  compareOre: number[] | null;
  peakIndex: number | null;
  /** Andra raden vid toppen, t.ex. "2,1 × snittdagen". */
  peakNote: string | null;
  averageOre: number;
  averageLabel: string;
  compareName: string;
  summary: string;
}) {
  const data = useMemo(
    () => dates.map((d, i) => ({ date: dateOf(d), value: (revenueOre[i] ?? 0) / 100 })),
    [dates, revenueOre],
  );
  const compare = useMemo(() => compareOre?.map((v) => v / 100), [compareOre]);
  const annotations: Annotation[] =
    peakIndex !== null && peakNote
      ? [{ index: peakIndex, text: "Bästa dagen", sub: peakNote }]
      : [];

  return (
    <LineChart
      data={data}
      compare={compare}
      format={formatSek}
      unit="kr"
      peakIndex={peakIndex ?? undefined}
      annotations={annotations}
      reference={{ value: averageOre / 100, label: averageLabel }}
      area={false}
      height={320}
      summary={summary}
      seriesName="Intäkt"
      compareName={compareName}
    />
  );
}
