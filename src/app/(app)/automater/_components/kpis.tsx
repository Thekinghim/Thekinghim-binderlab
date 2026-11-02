"use client";

import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { formatDecimal, formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

import type { KpiView } from "../_lib/types";

const FORMAT: Record<KpiView["kind"], (v: number) => string> = {
  // Belopp kommer i öre.
  sek: (v) => formatSek(v / 100),
  int: formatInt,
  percent: (v) => formatPercent(v, 1),
  months: (v) => `${formatDecimal(v)}${NBSP}mån`,
};

/** Nyckeltalsremsan ur serverns KpiView (formatering sker här, i klienten). */
export function MachineKpis({
  items,
  label,
  comparison,
  headingLevel = 2,
}: {
  items: readonly KpiView[];
  label: string;
  comparison?: string;
  /** h2 direkt under sidans h1 (standard), h3 inne i en sektion. */
  headingLevel?: 2 | 3;
}) {
  const strip: KpiItem[] = items.map((k) => ({
    id: k.id,
    label: k.label,
    value: k.value,
    format: FORMAT[k.kind],
    primary: k.primary,
    trend: k.trend && k.trend.length > 1 ? k.trend : undefined,
    delta: k.delta
      ? k.delta.kind === "absolute"
        ? { delta: k.delta.value, kind: "absolute", unit: "p.e." }
        : { delta: k.delta.value, kind: "relative" }
      : undefined,
  }));
  return (
    <KpiStrip items={strip} label={label} headingLevel={headingLevel} comparison={comparison} />
  );
}
