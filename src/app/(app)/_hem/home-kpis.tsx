"use client";

import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import {
  MINUS,
  NBSP,
  formatDelta,
  formatInt,
  formatNumber,
  formatPercent,
  formatSek,
} from "@/lib/format";

import type { HomeKpi } from "./model";

const formats: Record<HomeKpi["unit"], (v: number) => string> = {
  ore: (v) => formatSek(v / 100),
  bp: (v) => formatPercent(v / 10_000, 1),
  count: (v) => formatInt(v),
};

/** Alla förändringar i remsan med en decimal, så att de går att läsa bredvid varandra. */
const relativeDelta = (d: number) => formatDelta(d, 1);

/** Procentenheter med en decimal: "+1,2 p.e.", "−0,9 p.e.", "±0,0 p.e.". */
function pointsDelta(d: number): string {
  const rounded = Number(Math.abs(d).toFixed(1));
  const sign = rounded === 0 ? "±" : d > 0 ? "+" : MINUS;
  return `${sign}${formatNumber(rounded, 1)}${NBSP}p.e.`;
}

/**
 * Nyckeltalsremsan på Hem. Modellen är serialiserbar (tal och strängar); formateringen
 * väljs här efter enheten, eftersom funktioner inte kan skickas från servern.
 */
export function HomeKpis({ kpis, comparison }: { kpis: HomeKpi[]; comparison: string }) {
  const items: KpiItem[] = kpis.map((k) => ({
    id: k.id,
    label: k.label,
    value: k.value ?? Number.NaN,
    format: formats[k.unit],
    delta:
      k.delta === null
        ? undefined
        : k.deltaKind === "absolute"
          ? { delta: k.delta, kind: "absolute", unit: "p.e.", format: pointsDelta }
          : { delta: k.delta, kind: "relative", format: relativeDelta },
    trend: k.trend.length > 1 ? k.trend : undefined,
    reference: k.reference ?? undefined,
    primary: k.id === "profit",
    alert: k.alertText !== null,
    alertText: k.alertText ?? undefined,
  }));
  // Under 640 px står huvudtalet i en halv kolumn: låt etiketten brytas i stället för att kapas.
  return (
    <KpiStrip
      items={items}
      comparison={comparison}
      className="max-sm:[&_dt]:text-balance max-sm:[&_dt]:whitespace-normal"
    />
  );
}
