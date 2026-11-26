import Link from "next/link";
import type { CSSProperties } from "react";

import { PackImage } from "@/components/v2/pack-image";
import { formatAmountOre } from "@/components/v2/format";
import { cn } from "@/lib/cn";
import { formatInt, MISSING, NBSP } from "@/lib/format";

import { shelfPriceOrder, shelfPriceState } from "../_lib/price-shelf";
import { PRICE_EDITOR_ID, priceGap, type TitleRow } from "../_lib/model";

/*
 * Inköpspriser som hylla (visuellt): en ruta per titel med packbilden och en prislapp (vårt
 * pris och pris mot kund) och vad som blir kvar per pack. Titlar utan pris står först, med
 * streckad ram och "+ Sätt pris", som öppnar samma redigerare som tabellen (ett ark på
 * telefon). Sidan visas bara för ägare, admin och läsare (requireRoute).
 */

function money(ore: number | null | undefined): string {
  return ore === null || ore === undefined ? MISSING : formatAmountOre(ore);
}

export function PriceShelf({
  rows,
  baseQuery,
  selectedId,
}: {
  rows: readonly TitleRow[];
  /** searchParams utan titel (period och filter följer med i länkarna). */
  baseQuery: string;
  selectedId: string | null;
}) {
  const href = (id: string) => {
    const q = new URLSearchParams(baseQuery);
    q.set("titel", id);
    return `/inkopspriser?${q.toString()}#${PRICE_EDITOR_ID}`;
  };
  return (
    <ul className="ip-shelf" aria-label="Inköpspris per titel">
      {shelfPriceOrder(rows).map((r, i) => {
        const state = shelfPriceState(r);
        const gap = priceGap(r.currentCostOre, r.customerPriceOre);
        return (
          <li
            key={r.id}
            className={cn("ip-tile", state.missing && "miss", r.id === selectedId && "on")}
            style={{ "--i": Math.min(i, 14) } as CSSProperties}
          >
            <Link prefetch={false} href={href(r.id)} className="ip-hit" scroll={false}>
              <span className="ip-stage">
                <PackImage title={r.name} size="l" />
              </span>
              <b className="ip-nm">{r.name}</b>
              {state.missing ? (
                <>
                  <span className="ip-lost">
                    {r.unpricedOrders > 0 ? (
                      <>
                        {formatInt(r.unpricedOrders)}
                        {NBSP}order<span className="dl"> utan vinst</span>
                      </>
                    ) : (
                      state.note
                    )}
                  </span>
                  <span className="ip-set">+ Sätt {r.own ? "kostnad" : "pris"}</span>
                </>
              ) : (
                <>
                  <span className="ip-tag">
                    <span>
                      <small>{r.own ? "Kostnad" : "Vårt"}</small>
                      <b>{money(r.currentCostOre)}</b>
                    </span>
                    {/* Utan kundpris: ingen "Kund –"-ruta (raden under säger "Inget kundpris"). */}
                    {typeof r.customerPriceOre === "number" ? (
                      <span>
                        <small>Kund</small>
                        <b>{money(r.customerPriceOre)}</b>
                      </span>
                    ) : null}
                  </span>
                  {gap ? (
                    <span className={cn("ip-kvar", gap.ore < 0 && "neg")}>
                      {gap.ore < 0 ? "Förlust" : "Kvar"} {formatAmountOre(Math.abs(gap.ore))}
                      /pack
                    </span>
                  ) : (
                    <span className="ip-kvar no">
                      {r.orders > 0 ? "Inget kundpris" : "Ingen försäljning"}
                    </span>
                  )}
                </>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
