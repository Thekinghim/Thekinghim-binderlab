import Link from "next/link";

import { DeltaBadge } from "@/components/v2/badge";
import { PackFan } from "@/components/v2/pack-visuals";
import { ProfitBar } from "@/components/v2/profit-bar";
import { formatInt, formatSek, NBSP } from "@/lib/format";

import type { Bridge, Kpi, UnpricedBlock } from "../_lib/model";

import "./profit-hero.css";

const kr = (ore: number) => formatSek(ore / 100);

/** Förändringen i baspunkter för märket (relativ: andel; marginalen: procentenheter). */
function deltaBp(k: Kpi | undefined): number | null {
  if (!k || k.delta === null) return null;
  return k.deltaKind === "absolute" ? k.delta * 100 : k.delta * 10_000;
}

/**
 * Lönsamhetens hjältekort (skissen 05): vår vinst stort med intäkten delad i inköp och vinst,
 * intäkt och order bredvid och, när titlar saknar inköpspris, ett kort med packen och "Sätt
 * pris". Samma tal som nyckeltalen (modellens kpis och bryggan); inget räknas här.
 * Regionen heter "Nyckeltal · period" som remsan den ersätter.
 */
export function ProfitHero({
  kpis,
  bridge,
  unpriced,
  label,
  periodLabel,
  comparison,
}: {
  kpis: readonly Kpi[];
  bridge: Bridge;
  unpriced: UnpricedBlock;
  label: string;
  periodLabel: string;
  comparison: string | null;
}) {
  const by = (id: Kpi["id"]) => kpis.find((k) => k.id === id);
  const profit = by("profit");
  const margin = by("margin");
  const side = (["revenue", "compensation", "orders"] as const)
    .map((id) => by(id))
    .filter((k): k is Kpi => k !== undefined);
  // Stapeln: intäkten med pris, delad i allt som dras (inköp, avgifter …) och vinsten.
  const costs = bridge.revenueOre - bridge.profitOre;
  const missing = unpriced.titles.length;
  const first = unpriced.titles[0];

  return (
    <section className="v2-card lh" aria-label={label}>
      <div className="lh-main">
        <span className="lh-lab">
          {bridge.profitLabel} · {periodLabel}
        </span>
        <div className="lh-big">
          <span className="lh-v tnum">
            {formatInt(Math.round((profit?.value ?? 0) / 100))}
            <small>{NBSP}kr</small>
          </span>
          <DeltaBadge bp={deltaBp(profit)} />
        </div>
        {bridge.revenueOre > 0 ? (
          <ProfitBar
            wide
            revenue={bridge.revenueOre}
            cost={costs}
            max={bridge.revenueOre}
            className="lh-bar"
            title={`Intäkt med pris ${kr(bridge.revenueOre)} · ${bridge.profitLabel} ${kr(bridge.profitOre)}`}
          />
        ) : null}
        <p className="lh-legend">
          <span>
            {bridge.feesOre > 0 || bridge.compensationOre > 0 ? "Inköp och avgifter" : "Inköp"}{" "}
            {kr(costs)}
          </span>
          <b>
            {bridge.profitLabel} {kr(bridge.profitOre)}
          </b>
          {margin && margin.value !== null ? (
            <span className="lh-margin">
              {margin.label}{" "}
              {(margin.value / 100).toLocaleString("sv-SE", {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })}
              {NBSP}%
            </span>
          ) : null}
        </p>
        {comparison ? <p className="lh-cmp">{comparison}</p> : null}
      </div>
      <dl className="lh-side">
        {side.map((k) => (
          <div key={k.id}>
            <dt>{k.label}</dt>
            <dd>
              <span className="tnum">
                {k.unit === "ore" ? kr(k.value ?? 0) : formatInt(k.value ?? 0)}
              </span>
              <DeltaBadge bp={deltaBp(k)} goodWhenDown={k.invert} />
            </dd>
          </div>
        ))}
      </dl>
      {missing > 0 && first ? (
        <div className="lh-miss">
          <PackFan titles={unpriced.titles.slice(0, 3).map((t) => t.name)} size="s" />
          <div>
            <b>
              {formatInt(missing)} {missing === 1 ? "titel saknar" : "titlar saknar"} inköpspris
            </b>
            <span>{kr(unpriced.revenueOre)} intäkt räknas inte in i vinsten.</span>
            <Link className="lh-setp" href={first.href}>
              + Sätt pris<span className="sr-only"> för {first.name}</span>
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
