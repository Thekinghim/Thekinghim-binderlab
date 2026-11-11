import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import Link from "next/link";
import { redirect } from "next/navigation";
import type React from "react";
import { Suspense } from "react";

import { carriedQuery } from "@/components/shell/period-state";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { requestStoreShareView } from "@/server/data/core";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";

import { MobileFold } from "@/components/ui/mobile-fold";

import { MobileMore } from "../../_mobil/mobile-more";
import { MachineKpis } from "../_components/kpis";
import { AddMachineButton } from "../_components/machine-dialogs";
import { MachineTable } from "../_components/machine-table";
import { NeedList } from "../_components/need-list";
import { ProfitRanking } from "../_components/profit-ranking";
import { UnpricedNote } from "../_components/unpriced-note";
import { loadOverview } from "../_lib/data";
import {
  machineNeeds,
  needsHeadline,
  nextMachineCode,
  overviewKpis,
  spreadText,
} from "../_lib/model";

export const metadata: Metadata = { title: "Automater" };

/**
 * Automater: alla automater med periodens intäkt, vinst, status, butik och lager.
 * Ägare, admin och läsare (påfyllaren skickas vidare av requireRoute). Ägare och admin
 * lägger till automater här; redigering, flytt och avveckling görs på automatens sida.
 * Statusen är densamma som på Drift (loadMachineHealth: samma maskinhälsa och samma
 * täckning av försäljningen). Länken går till enhetsekonomin för alla automater.
 */
export default async function AutomaterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Underfliken Svinn (?vy=svinn) har en egen sida.
  if (sp.vy === "svinn") {
    redirect(`/automater/svinn${carriedQuery(sp)}`);
  }
  const [data, shareToggle] = await Promise.all([loadOverview(sp), requestStoreShareView()]);
  const { ctx, overview, period } = data;
  const { totals, rows, headline } = overview;
  const active = rows.filter((r) => r.lifecycle === "active");
  // Ur drift (hälsan offline) räknas inte som i drift, som på Drift.
  const offline = totals.offlineMachines ?? 0;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const daysLabel = `${formatInt(period.span.days)}${NBSP}d`;
  // Överst: vad som behöver göras (managerfrågan), pengarna som andra rad.
  const needs = machineNeeds(rows);
  // Rangordningen säger inte "Tjänar bra" om en automat som står still: den visar driftläget.
  const down = new Map(
    active.filter((r) => r.status.health === "offline").map((r) => [r.id, r.status.label]),
  );

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 max-md:gap-8 md:gap-16 md:px-8 md:pt-12">
      <div className="rise max-md:relative">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={data.scopeLabel ? `Automater · ${data.scopeLabel}` : "Automater"}
          title={needsHeadline(needs, rows.length)}
          aside={rows.length === 0 ? headline.aside : headline.title}
          actions={
            ctx.canEdit ? (
              // Mobil: sällan använd, bakom "⋯" (Fyll på i listan nedan är huvudknappen).
              // Under md uppe till höger, med AI-frågan (som från md står under rubriken).
              <MobileMore
                label="Fler val för automater"
                className="max-md:absolute max-md:-top-2 max-md:-right-2"
              >
                <AddMachineButton
                  stores={data.stores}
                  today={ctx.today}
                  suggestedCode={nextMachineCode(rows.map((r) => r.code))}
                />
                <AiPageLine
                  metric="automaternas resultat"
                  route="automater"
                  menuItem
                  className="md:hidden"
                />
              </MobileMore>
            ) : undefined
          }
          className="max-md:pr-10"
        />
        {ctx.canEdit ? null : (
          <div className="absolute -top-2 -right-2 md:hidden">
            <MobileMore label="Fler val för automater">
              <AiPageLine metric="automaternas resultat" route="automater" menuItem />
            </MobileMore>
          </div>
        )}
        <AiPageLine
          metric="automaternas resultat"
          route="automater"
          className="mt-4 max-md:hidden"
        />
        {needs.length > 0 ? (
          <div className="mt-8 max-md:mt-5">
            <NeedList needs={needs} />
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <StateMessage kind="empty" message="Det finns inga automater i organisationen ännu." />
      ) : (
        <>
          {period.pendingToday ? (
            <StateMessage kind="empty" message="Inga order i dag än." />
          ) : active.length > 0 || totals.orders > 0 ? (
            <div className="rise flex flex-col gap-4" style={{ "--i": 1 } as React.CSSProperties}>
              {/* Vår vinst före butikernas andel; med knappen efter den (vald butik: alltid). */}
              {data.scopeLabel ? null : (
                <Suspense fallback={null}>
                  <StoreShareToggle on={shareToggle} />
                </Suspense>
              )}
              <MobileFold summary="Fler siffror" meta={formatInt(overviewKpis(totals).length)}>
                <MachineKpis
                  items={overviewKpis(totals)}
                  label={`Nyckeltal · ${daysLabel}`}
                  comparison={comparison}
                />
              </MobileFold>
              {overview.unpriced ? (
                <UnpricedNote unpriced={overview.unpriced} canEdit={ctx.canEdit} />
              ) : null}
            </div>
          ) : null}

          <section
            aria-labelledby="alla-automater"
            className="rise flex flex-col gap-6"
            style={{ "--i": 2 } as React.CSSProperties}
          >
            <SectionHeader
              id="alla-automater"
              // Mobil: den grå meningen döljs (talen står i tabellen).
              className="max-md:[&_h2>span+span]:hidden"
              eyebrow={period.pendingToday ? "Per automat · nu" : `Per automat · ${daysLabel}`}
              title={
                active.length === 0
                  ? "Ingen automat i drift."
                  : offline > 0
                    ? `${formatInt(active.length - offline)} av ${formatInt(active.length)} automater i drift, ${formatInt(offline)} ur drift.`
                    : `${formatInt(active.length)} ${active.length === 1 ? "automat" : "automater"} i drift.`
              }
              aside={period.pendingToday ? "Status, lager och senaste order." : spreadText(rows)}
              actions={
                <Link
                  href="/automater/enhetsekonomi"
                  className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline max-md:tap max-md:min-h-11"
                >
                  <span>Enhetsekonomi</span>
                  <span aria-hidden className="text-subtle">
                    →
                  </span>
                </Link>
              }
            />
            <MachineTable
              rows={rows}
              others={overview.others}
              totals={rows.length > 1 || overview.others.length > 0 ? totals : null}
              pending={period.pendingToday}
              timeZone={ctx.timeZone}
              now={ctx.now}
              caption={`Automater, intäkt och vinst ${period.rangeLabel}`}
              shareDeducted={totals.storeShareDeducted === true}
            />
          </section>

          {/* Automat-ranking: vinst per dag och omdöme (en automat: mot sin förra period). */}
          {!period.pendingToday && active.length > 0 ? (
            <Suspense fallback={null}>
              <ProfitRanking searchParams={sp} query={carriedQuery(sp)} down={down} />
            </Suspense>
          ) : null}
        </>
      )}
    </div>
  );
}
