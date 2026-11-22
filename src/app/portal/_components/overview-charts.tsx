"use client";

import { BarChart, type BarDatum } from "@/components/charts/bar-chart";
import { Badge, DeltaBadge } from "@/components/v2/badge";
import { Sparkline } from "@/components/v2/sparkline";
import { formatInt, formatSek, NBSP } from "@/lib/format";

import { kr } from "./text";

export type PortalKpi = {
  id: "revenue" | "orders" | "average" | "compensation";
  label: string;
  /** Öre, eller antal för orders. */
  value: number | null;
  /** Relativ förändring som andel (0,08 = +8 %), eller absolut för antal. */
  delta: number | null;
  trend: number[];
};

const formats: Record<PortalKpi["id"], (v: number) => string> = {
  revenue: (v) => kr(v),
  orders: (v) => `${formatInt(v)} st`,
  average: (v) => kr(v),
  compensation: (v) => kr(v),
};

/**
 * Nyckeltalen för månaden som V2:s KPI-band (som Hem): etikett, tal, förändringen mot
 * jämförelsemånaden och en liten linje per månad. Modellen är serialiserbar; formateringen
 * väljs här. På telefon rullar rutorna i sidled.
 */
export function PortalKpis({ kpis, comparison }: { kpis: PortalKpi[]; comparison: string }) {
  return (
    <div className="v2-band-wrap">
      <div
        className="v2-band"
        style={{ "--cols": kpis.length } as React.CSSProperties}
        role="group"
        aria-label={`Månaden. ${comparison}`}
      >
        {kpis.map((k) => (
          <div key={k.id} className="v2-kt">
            <span className="kl">{k.label}</span>
            <span className="kn">{k.value === null ? "–" : formats[k.id](k.value)}</span>
            {k.delta !== null ? (
              <span className="kd">
                {k.id === "orders" ? (
                  <Badge tone={k.delta > 0 ? "success" : k.delta < 0 ? "critical" : "neutral"}>
                    {`${k.delta > 0 ? `↑${NBSP}` : k.delta < 0 ? `↓${NBSP}` : ""}${formatInt(Math.abs(k.delta))}${NBSP}st`}
                  </Badge>
                ) : (
                  <DeltaBadge bp={Math.round(k.delta * 10_000)} />
                )}
              </span>
            ) : null}
            {k.trend.length > 1 ? (
              <span className="ks">
                <Sparkline values={k.trend} />
              </span>
            ) : (
              <span className="ks-empty" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Försäljning per månad (staplar, värden i kronor). Vald månad annoteras, aldrig signal. */
export function TrendChart({
  data,
  summary,
  selectedIndex,
  mean,
}: {
  data: BarDatum[];
  summary: string;
  selectedIndex: number;
  /** Snitt för hela månader i kronor; utan värde ritas ingen snittlinje. */
  mean?: number;
}) {
  return (
    <BarChart
      data={data}
      orientation="vertical"
      format={(v) => formatSek(v)}
      unit="kr"
      height={240}
      peakIndex={selectedIndex}
      highlightNote="Vald månad"
      showMean={mean !== undefined}
      meanValue={mean}
      summary={summary}
    />
  );
}

/** Titlar som liggande staplar med värde till höger (värden i kronor). */
export function RankChart({
  data,
  summary,
  labelHeading,
  valueHeading,
}: {
  data: BarDatum[];
  summary: string;
  labelHeading: string;
  valueHeading: string;
}) {
  return (
    <BarChart
      data={data}
      format={(v) => formatSek(v)}
      unit="kr"
      labelHeading={labelHeading}
      valueHeading={valueHeading}
      summary={summary}
    />
  );
}
