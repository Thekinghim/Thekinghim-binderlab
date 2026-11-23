import Link from "next/link";
import type { CSSProperties } from "react";

import { MachineThumb } from "@/components/v2/machine-thumb";
import { StateMessage } from "@/components/ui/state-message";
import type { Period } from "@/domain";
import { cn } from "@/lib/cn";
import { formatSek, MISSING } from "@/lib/format";

import { paybackShort } from "../../../expansion/_lib/display";
import type { PerDayList } from "../_lib/per-day";

import "./per-day-list.css";

const kr = (ore: number) => formatSek(ore / 100);

function lonsamhetHref(period: Period, machineId: string) {
  return `/lonsamhet?from=${period.start}&to=${period.end}&automat=${machineId}&vy=titel`;
}

/**
 * Vinst per dag per automat: automatens bild och namn med butiken, en grön stapel (längd mot
 * den bästa) med beloppet efter, ett streckat lodrätt streck vid medianen, vinsten per månad
 * och hur länge den tar att betala sig (liten grå stapel mot den längsta). Telefon: namn och
 * butik på en rad, stapeln under och "Betalar sig på" sist.
 */
export function PerDayListView({ list, period }: { list: PerDayList; period: Period }) {
  if (list.rows.length === 0) {
    return (
      <div className="v2-card-body">
        <StateMessage
          kind="empty"
          compact
          message="Ingen automat var placerad i perioden."
          action={{ label: "Välj en längre period", href: "?period=allt" }}
        />
      </div>
    );
  }
  const mf = list.medianFraction;
  const style = (mf === null ? {} : { "--mf": mf }) as CSSProperties;
  return (
    <div className={cn("ue", mf === null && "no-med")} style={style}>
      <div className="ue-axis" aria-hidden="true">
        <span className="ue-medlab">
          {list.medianOre === null ? null : <b>{`Median ${kr(list.medianOre)}`}</b>}
        </span>
        <span className="ue-ax r">Vinst/mån</span>
        <span className="ue-ax r">Betalar sig</span>
      </div>
      <ol className="ue-list" aria-label="Vinst per dag per automat, mest först">
        {list.rows.map((r, i) => {
          const loss = r.profitPerDayOre < 0;
          const d = `${Math.min(i, 12) * 30}ms`;
          return (
            <li
              key={r.machineId}
              className="ue-row"
              style={{ "--f": r.fraction, "--d": d } as CSSProperties}
            >
              <span className="ue-vis">
                <MachineThumb machineId={r.machineId} look={r.look} size="sm" />
              </span>
              <span className="ue-name">
                <Link href={lonsamhetHref(period, r.machineId)} className="ue-t">
                  {r.name}
                </Link>
                <span className="ue-s">
                  {r.code && r.code !== r.name ? (
                    <span className="ue-code">
                      {r.code}
                      {r.storeName ? " · " : ""}
                    </span>
                  ) : null}
                  {r.storeName}
                </span>
              </span>
              <span className="ue-bar">
                <span className="ue-trk" aria-hidden="true">
                  <i />
                </span>
                <span className={cn("ue-val", loss && "loss")}>
                  {kr(r.profitPerDayOre)}
                  <span className="sr-only"> per dag</span>
                </span>
              </span>
              <span className="ue-month">
                {r.profitPerMonthOre === null ? MISSING : kr(r.profitPerMonthOre)}
                <span className="sr-only"> per månad</span>
              </span>
              <span className="ue-pay">
                <span className="ue-pay-l">Betalar sig på</span>
                <span className="ue-pbtrk" aria-hidden="true">
                  {r.paybackFraction === null ? null : (
                    <i style={{ width: `${Math.max(6, r.paybackFraction * 100)}%` }} />
                  )}
                </span>
                <span className="tnum">{paybackShort(r.paybackTenths)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
