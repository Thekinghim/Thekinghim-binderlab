import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { carriedQuery } from "@/components/shell/period-state";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { formatInt } from "@/lib/format";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { requestStoreShareView, requireRoute } from "@/server/data/core";

import { AddMachineButton } from "../_components/machine-dialogs";
import { ProfitRanking } from "../_components/profit-ranking";
import { AutomaterView } from "../_components/v2/automater-view";
import { loadOverview } from "../_lib/data";
import { nextMachineCode } from "../_lib/model";
import { loadAutomaterV2 } from "../_lib/v2-data";
import { filterOf, needsFill } from "../_lib/v2-model";

export const metadata: Metadata = { title: "Automater" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Automater (V2, byggplanen 2.3): alla automater i en tät lista med sök, filter, gruppering och
 * sortering, och den valda automaten med front, fack, historik och butik. Statusen, fyllnaden
 * och takten kommer från flottans läge (samma som Hem och Rutt). Vinst per dag och mot snittet
 * bara för roller som ser ekonomi: påfyllarens svar innehåller inga belopp (servern tar bort dem).
 * ?f=offline väljer filtret, ?valj=<kod> automaten. ?vy=svinn har en egen sida.
 */
export default async function AutomaterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  if (sp.vy === "svinn") {
    redirect(`/automater/svinn${carriedQuery(sp)}`);
  }
  const ctx = await requireRoute("automater");
  const [data, overview] = await Promise.all([
    loadAutomaterV2(ctx, sp),
    ctx.canEdit ? loadOverview(sp) : Promise.resolve(null),
  ]);
  const need = data.machines.filter(needsFill).length;
  const offline = data.machines.filter((m) => m.status === "offline").length;
  const n = data.machines.length;

  return (
    <V2Page
      title="Automater"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period={data.economy}
      tools={
        overview ? (
          <span className="max-[900px]:hidden">
            <AddMachineButton
              stores={overview.stores}
              today={ctx.today}
              suggestedCode={nextMachineCode(overview.overview.rows.map((r) => r.code))}
            />
          </span>
        ) : undefined
      }
      sub={
        n === 0 ? (
          <span>Det finns inga automater ännu.</span>
        ) : (
          <span>
            <b>{formatInt(n)}</b> {n === 1 ? "automat" : "automater"}
            {need > 0 ? (
              <>
                {" · "}
                <b>{formatInt(need)}</b> behöver påfyllning
              </>
            ) : null}
            {offline > 0 ? (
              <>
                {" · "}
                <b>{formatInt(offline)}</b> offline
              </>
            ) : null}
          </span>
        )
      }
    >
      {n === 0 ? null : (
        <AutomaterView
          data={data}
          initialFilter={filterOf(first(sp.f), data.economy)}
          initialSelected={first(sp.valj)}
        />
      )}
      {data.economy ? (
        <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-v2-xs text-v2-mute">
          <Link className="hover:text-v2-ink" href="/automater/enhetsekonomi">
            Enhetsekonomi →
          </Link>
          <Link className="hover:text-v2-ink" href="/automater/svinn">
            Svinn →
          </Link>
          <Link className="hover:text-v2-ink" href="#rangordning">
            Rangordning →
          </Link>
        </p>
      ) : null}
      {/* Automat-ranking: vinst per dag och omdöme (en automat: mot sin förra period), under
          listan för roller som ser ekonomi. Står still: driftläget i stället för omdömet. */}
      {data.economy && n > 0 ? (
        <div id="rangordning" className="v2-legacy mt-8 scroll-mt-24">
          {/* "Visa butikernas andel": rangordningen efter andelen (som förut på Automater). */}
          <div className="mb-3">
            <Suspense fallback={null}>
              <StoreShareToggle on={await requestStoreShareView()} />
            </Suspense>
          </div>
          <Suspense fallback={null}>
            <ProfitRanking
              searchParams={sp}
              query={carriedQuery(sp)}
              down={
                new Map(
                  data.machines.filter((m) => m.status === "offline").map((m) => [m.id, "Offline"]),
                )
              }
            />
          </Suspense>
        </div>
      ) : null}
    </V2Page>
  );
}
