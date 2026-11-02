"use client";

import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { formatInt, formatPercent, formatSek, MISSING } from "@/lib/format";

import type { KpiView } from "../_lib/types";

const FORMAT: Record<KpiView["kind"], (v: number) => string> = {
  // Belopp kommer i öre.
  sek: (v) => formatSek(v / 100),
  int: formatInt,
  percent: (v) => formatPercent(v, 1),
};

/** Nyckeltalsremsan ur serverns KpiView (formatering sker här, i klienten). */
export function StoreKpis({
  items,
  label,
  comparison,
}: {
  items: readonly KpiView[];
  label: string;
  comparison?: string;
}) {
  const strip: KpiItem[] = items.map((k) => ({
    id: k.id,
    label: k.label,
    // null = går inte att räkna (t.ex. andel av en intäkt på 0 kr): "–".
    value: k.value ?? 0,
    format: k.value === null ? () => MISSING : FORMAT[k.kind],
    primary: k.primary,
    trend: k.trend && k.trend.length > 1 ? k.trend : undefined,
    delta: k.delta
      ? k.delta.kind === "absolute"
        ? { delta: k.delta.value, kind: "absolute", unit: "p.e.", invert: k.invert }
        : { delta: k.delta.value, kind: "relative", invert: k.invert }
      : undefined,
  }));
  return <KpiStrip items={strip} label={label} comparison={comparison} />;
}
