import type { Metadata } from "next";

import { Badge } from "@/components/v2/badge";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { ListRow } from "@/components/v2/list-row";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { FleetStatusBadge } from "@/components/v2/status-dot";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";
import { loadDayRoute } from "@/server/data/v2/route";

export const metadata: Metadata = { title: "Rutt" };

/**
 * Rutt (/rutt), första versionen från grunden (F0): dagens stopp ur besöksplanen med status
 * och pack, och dagens gräns ur inställningarna. Rutt-gruppen (G3) bygger sidan som i
 * prototypen (karta, packlista, hoppa över, kommande dagar). Alla fyra roller; inga belopp här.
 */
export default async function RoutePage() {
  const ctx = await requireRoute("rutt");
  const route = await loadDayRoute();
  const stops = route.stops.length;
  return (
    <V2Page
      title="Rutt"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      sub={
        stops > 0 ? (
          <span>
            <b>{formatInt(stops)}</b> {stops === 1 ? "stopp" : "stopp"} ·{" "}
            <b>{formatInt(route.totalPacks)}</b> pack
            {route.cities.length > 0 ? ` · ${route.cities.join(" → ")}` : ""}
          </span>
        ) : (
          <span>Inga besök behövs i dag.</span>
        )
      }
    >
      <Card
        title="Dagens rutt"
        count={stops || null}
        actions={
          <span className="text-v2-xs text-v2-mute">
            Max {route.limits.maxStops} stopp och {formatInt(route.limits.maxPacks)} pack per dag
          </span>
        }
      >
        {stops === 0 ? (
          <Empty title="Ingen rutt i dag">
            Besöksplanen har inga automater som behöver fyllas på i dag.
          </Empty>
        ) : (
          route.stops.map((s) => (
            <ListRow
              key={s.machineId}
              title={`${s.sequence}. ${s.name}`}
              sub={[s.store?.name, s.store?.city, s.code].filter(Boolean).join(" · ")}
              actions={
                s.done ? (
                  <Badge tone="success">Påfylld i dag</Badge>
                ) : (
                  <span className="text-v2-sm font-[550]">{formatInt(s.packs)} pack</span>
                )
              }
            >
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {s.status ? <FleetStatusBadge status={s.status} /> : null}
                <span>{s.reasons[0]}</span>
              </span>
            </ListRow>
          ))
        )}
      </Card>
    </V2Page>
  );
}
