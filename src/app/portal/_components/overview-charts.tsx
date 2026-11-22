"use client";

import { BarChart, type BarDatum } from "@/components/charts/bar-chart";
import { Badge, DeltaBadge } from "@/components/v2/badge";
import { BarChart as V2BarChart } from "@/components/v2/bars";
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

/**
 * Försäljning per månad som V2:s staplar (som Pengar): vald månad mörk, de andra ljusa, en
 * etikett per månad och tooltip. Skärmläsaren får talen som tabell.
 */
export function TrendChart({
  data,
  summary,
  selectedIndex,
}: {
  data: BarDatum[];
  summary: string;
  selectedIndex: number;
  /** Snitt för hela månader i kronor (står i texten under, inte som linje). */
  mean?: number;
}) {
  return (
    <V2BarChart
      data={data.map((d, i) => ({ key: `${i}-${d.label}`, label: d.label, value: d.value }))}
      format={(v) => formatSek(v)}
      valueLabel="Försäljning"
      height={200}
      selectedIndex={selectedIndex}
      ariaLabel={summary}
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
