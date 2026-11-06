"use client";

import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { formatInt, formatMarginBp, formatSek } from "@/lib/format";

import type { Kpi } from "../_lib/model";

export const KPI_FORMAT: Record<Kpi["unit"], (v: number) => string> = {
  // Öre in, hela kronor ut.
  ore: (v) => formatSek(v / 100),
  // Samma funktion som vattenfallets marginal (bridge.tsx), så att talen alltid är lika.
  bp: (v) => formatMarginBp(v),
  count: (v) => formatInt(v),
};

/** Nyckeltalsremsan: vinst som huvudperson, marginal, intäkt, butiksersättning och order. */
export function LonsamhetKpis({
  kpis,
  label,
  comparison,
}: {
  kpis: readonly Kpi[];
  label: string;
  comparison: string | null;
}) {
  const items: KpiItem[] = kpis.map((k) => ({
    id: k.id,
    label: k.label,
    value: k.value ?? Number.NaN,
    format: KPI_FORMAT[k.unit],
    primary: k.primary,
    delta:
      k.delta === null
        ? undefined
        : k.deltaKind === "absolute"
          ? { delta: k.delta, kind: "absolute", unit: "p.e.", invert: k.invert }
          : { delta: k.delta, kind: "relative", invert: k.invert },
  }));
  // Remsan står direkt under sidans h1: etiketten blir h2.
  return (
    <KpiStrip items={items} label={label} headingLevel={2} comparison={comparison ?? undefined} />
  );
}
