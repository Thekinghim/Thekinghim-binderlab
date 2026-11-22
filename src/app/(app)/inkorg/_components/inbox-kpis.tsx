import { formatAmountOre } from "@/components/v2/format";
import { KpiTile } from "@/components/v2/kpi-tile";
import { formatInt } from "@/lib/format";

/** Nyckeltalen i Inkorg (V2-bandet, som Hem). Öppna ärenden står först. */
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
    <section aria-label={`Ärenden · ${period}`} className="v2-band-wrap">
      <div className="v2-band" style={{ "--cols": 4 } as React.CSSProperties}>
        <KpiTile label="Öppna ärenden" value={formatInt(open)} />
        <KpiTile label="Nya i perioden" value={formatInt(created)} compare={period} />
        <KpiTile label="Lösta i perioden" value={formatInt(resolved)} />
        <KpiTile
          label={`Återbetalt · ${formatInt(refundCount)} st`}
          value={formatAmountOre(refundedOre)}
        />
      </div>
    </section>
  );
}
