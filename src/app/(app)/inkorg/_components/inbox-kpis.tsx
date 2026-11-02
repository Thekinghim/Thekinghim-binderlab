"use client";

import { KpiStrip } from "@/components/ui/kpi-strip";
import { formatInt, formatKronor } from "@/lib/format";

/** Nyckeltalen i Inkorg. Öppna ärenden är huvudpersonen. */
export function InboxKpis({
  open,
  created,
  resolved,
  refundedOre,
  refundCount,
  period,
}: {
  open: number;
  created: number;
  resolved: number;
  refundedOre: number;
  refundCount: number;
  period: string;
}) {
  return (
    <KpiStrip
      label={`Ärenden · ${period}`}
      items={[
        { id: "open", label: "Öppna ärenden", value: open, format: formatInt, primary: true },
        { id: "created", label: "Nya i perioden", value: created, format: formatInt },
        { id: "resolved", label: "Lösta i perioden", value: resolved, format: formatInt },
        {
          id: "refunded",
          label: `Återbetalt · ${formatInt(refundCount)} st`,
          value: refundedOre,
          format: (v) => formatKronor(v / 100, { decimals: 0 }),
        },
      ]}
    />
  );
}
