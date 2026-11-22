import Link from "next/link";
import type { ReactNode } from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { Badge } from "@/components/v2/badge";
import { Card } from "@/components/v2/card";
import { formatInt, NBSP } from "@/lib/format";

import { machineHref } from "../_lib/model";
import { rankingView } from "../_lib/ranking";
import { loadFleetRanking } from "../_lib/ranking-data";

/**
 * Automat-ranking: automaterna rangordnade efter vinst per dag (samma tal som
 * Enhetsekonomi), med försäljning per dag, slutsålt och ett omdöme per automat ("Bäst",
 * "Tjänar bra", "Tjänar dåligt: överväg att flytta"). Med en enda automat jämförs den med sin
 * egen förra period. Strömmas in under listan (egen Suspense på sidan). V2-kort med rader
 * (.v2-row) och märken; stilarna i (oversikt)/oversikt.css.
 */
export async function ProfitRanking({
  searchParams,
  query,
  down,
  toggle,
}: {
  searchParams: SearchParamsInput;
  query: string;
  /** Automater som är ur drift just nu (id → etikett): raden visar det i stället för omdömet. */
  down?: ReadonlyMap<string, string>;
  /** "Visa butikernas andel" i kortets rubrikrad. */
  toggle?: ReactNode;
}) {
  // Ett fel i rankingen ska aldrig stoppa listan ovanför.
  const data = await loadFleetRanking(searchParams).catch((error: unknown) => {
    console.error("[automater] Automat-rankingen kunde inte läsas:", error);
    return null;
  });
  if (!data) return null;
  const view = rankingView({
    ranking: data.ranking,
    machines: data.machines,
    hrefOf: (code) => machineHref(code, query),
    storeShareDeducted: data.storeShareDeducted,
    down,
  });
  if (view.rows.length === 0) return null;
  return (
    <div data-ranking={view.mode} className="ao-rank">
      <Card
        title={
          <>
            Rangordning
            <span className="ao-rank-per">{`vinst per dag · ${formatInt(data.days)}${NBSP}d`}</span>
          </>
        }
        actions={
          <span className="ao-rank-tools">
            {toggle ? <span className="v2-legacy">{toggle}</span> : null}
            <Link className="lk" href={`/automater/enhetsekonomi${query}`}>
              Enhetsekonomi <span aria-hidden="true">→</span>
            </Link>
          </span>
        }
      >
        <p className="ao-rank-sum">
          <b>{view.title}</b> {view.aside}
        </p>
        <ol className="ao-rank-list">
          {view.rows.map((r) => (
            <li key={r.machineId}>
              <Link href={r.href} data-verdict={r.verdict} className="v2-row">
                <div className="t">
                  <b>
                    <span className="v2-id ao-rank-nr">{formatInt(r.rank)}</span>
                    {r.code}
                    {NBSP}
                    <span className="ao-rank-name">{r.name}</span>
                  </b>
                  <small>{r.sales}</small>
                </div>
                <div className="m ao-rank-m">
                  <span className="v2-track" aria-hidden="true">
                    <i
                      className={r.warn ? "warning" : undefined}
                      style={{ transform: `scaleX(${Math.max(0, Math.min(1, r.bar))})` }}
                    />
                  </span>
                  <span className="ao-rank-why">
                    <Badge tone={r.warn ? "warning" : r.verdict === "best" ? "success" : "neutral"}>
                      {r.verdictText}
                    </Badge>
                    <span>{r.basis}</span>
                    {r.lost ? <span>{r.lost}</span> : null}
                  </span>
                </div>
                <div className="a">
                  <span className="ao-rank-profit">{r.profit}</span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
        <p className="ao-rank-note">{view.note}</p>
      </Card>
    </div>
  );
}
