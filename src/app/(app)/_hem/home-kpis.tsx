"use client";

import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { formatInt, formatPercent, formatSek } from "@/lib/format";

import type { HomeKpi } from "./model";

const formats: Record<HomeKpi["unit"], (v: number) => string> = {
  ore: (v) => formatSek(v / 100),
  bp: (v) => formatPercent(v / 10_000, 1),
  count: (v) => formatInt(v),
};

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
          ? { delta: k.delta, kind: "absolute", unit: "p.e." }
          : { delta: k.delta, kind: "relative" },
    trend: k.trend.length > 1 ? k.trend : undefined,
    reference: k.reference ?? undefined,
    primary: k.id === "profit",
    alert: k.alertText !== null,
    alertText: k.alertText ?? undefined,
  }));
  return <KpiStrip items={items} comparison={comparison} />;
}
