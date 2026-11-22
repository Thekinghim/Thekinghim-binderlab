import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ButtonLink } from "@/components/v2/button";
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

import "./oversikt.css";

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
      {/* Dator: listan och rangordningen i vänsterspalten, den valda automaten till höger
          (klistrad och högst en skärm hög), så att ingen tom yta blir kvar under listan.
          Rutnätet i oversikt.css; telefon och smal skärm som förut. */}
      <div className="ao-page">
        {n === 0 ? null : (
          <AutomaterView
            data={data}
            initialFilter={filterOf(first(sp.f), data.economy)}
            initialSelected={first(sp.valj)}
          />
        )}
        {data.economy ? (
          <div className="ao-more">
            <nav className="ao-links" aria-label="Mer om automaterna">
              <ButtonLink size="sm" touch href="/automater/enhetsekonomi">
                Enhetsekonomi <span aria-hidden="true">→</span>
              </ButtonLink>
              <ButtonLink size="sm" touch href="/automater/svinn">
                Svinn <span aria-hidden="true">→</span>
              </ButtonLink>
              <ButtonLink size="sm" touch href="#rangordning">
                Rangordning <span aria-hidden="true">↓</span>
              </ButtonLink>
            </nav>
            {/* Automat-ranking: vinst per dag och omdöme (en automat: mot sin förra period),
                under listan för roller som ser ekonomi. Står still: driftläget i stället för
                omdömet. "Visa butikernas andel" rangordnar efter andelen (som förut). */}
            {n > 0 ? (
              <div id="rangordning" className="scroll-mt-24">
                <Suspense fallback={null}>
                  <ProfitRanking
                    searchParams={sp}
                    query={carriedQuery(sp)}
                    toggle={
                      <Suspense fallback={null}>
                        <StoreShareToggle on={await requestStoreShareView()} />
                      </Suspense>
                    }
                    down={
                      new Map(
                        data.machines
                          .filter((m) => m.status === "offline")
                          .map((m) => [m.id, "Offline"]),
                      )
                    }
                  />
                </Suspense>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </V2Page>
  );
}
