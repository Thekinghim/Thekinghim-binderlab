import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import { Suspense, type CSSProperties } from "react";
import { redirect, unstable_rethrow } from "next/navigation";

import { carriedQuery } from "@/components/shell/period-state";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { Panel } from "@/components/ui/frame";
import { MobileFold } from "@/components/ui/mobile-fold";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";
import { loadProfitAdjustments } from "@/server/data/adjustments";
import { requestPageLoaders } from "@/server/data/page-loaders";
import {
  loadLastOrderDate,
  loadPeriod,
  loadSyncInfo,
  requestStoreShareView,
  requireRoute,
} from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import { MobileMore } from "../_mobil/mobile-more";
import { homeStaleImport } from "../_hem/model";
import { StaleImportLine } from "../_hem/sections";

import { CompensationBreakdown, UnpricedSummary } from "./_components/breakdown";
import { LonsamhetBridge } from "./_components/bridge";
import { LonsamhetKpis } from "./_components/kpis";
import { PriceAdviceSection } from "./_components/price-advice";
import { ResultAfterProfitPanel } from "./_components/result";
import { AnalysisSection } from "./_components/sections";
import { RhythmSection } from "./_components/rhythm";
import { loadLonsamhetWith } from "./_lib/data";
import { periodText, type TrendKey, type ViewKey } from "./_lib/model";
import { buildMovers } from "./_lib/movers";
import { loadPriceAdviceFor } from "./_lib/price-advice";
import { salesHeatmap, machineHref } from "../automater/_lib/model";
import { resultAfterProfit } from "./_lib/result";
import {
  canonicalLonsamhetQuery,
  parseAnalysisTab,
  parseTitleParam,
  parseTrendParam,
  parseViewParam,
} from "./_lib/params";

export const metadata: Metadata = { title: "Lönsamhet" };

type SearchParams = Record<string, string | string[] | undefined>;

/** "Visa hela historiken" med samma filter (?butik=, ?automat=) och vy. */
function allHistoryHref(sp: SearchParams): string {
  const q = new URLSearchParams(carriedQuery(sp).replace(/^\?/, ""));
  q.delete("from");
  q.delete("to");
  q.set("period", "allt");
  for (const k of ["vy", "per", "titel"] as const) {
    const v = sp[k];
    if (typeof v === "string" && v) q.set(k, v);
  }
  return `/lonsamhet?${q.toString()}`;
}

/** Namnen för topplistan (aktiva och arkiverade, som tabellen). */
function moverNames(input: {
  machines: ReadonlyArray<{ id: string; name: string; code: string }>;
  stores: ReadonlyArray<{ id: string; name: string }>;
  titles: ReadonlyArray<{ id: string; name: string }>;
}) {
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const stores = new Map(input.stores.map((x) => [x.id, x.name]));
  const titles = new Map(input.titles.map((t) => [t.id, t.name]));
  return {
    machine: (id: string) => {
      const m = machines.get(id);
      return m ? { name: m.name, code: m.code || null } : null;
    },
    store: (id: string) => stores.get(id) ?? null,
    title: (id: string) => titles.get(id) ?? null,
  };
}

const SECTION =
  "flex scroll-mt-28 flex-col gap-10 border-t border-line py-12 max-md:gap-6 max-md:py-8 md:gap-12 md:py-16";

/**
 * Lönsamhet: vad tjänar vi, och var? Vattenfall från intäkt till vinst, och under det
 * återbetalningar och fasta kostnader som egna rader (resultat efter fasta kostnader),
 * tabell per titel, automat och butik, utveckling per vecka eller månad och order utan
 * inköpspris. Överst Prisråd: produkter under målet för marginalen, och vad priset bör vara.
 *
 * Ägare, admin och läsare. Påfyllaren skickas till sin startsida av requireRoute och
 * får aldrig någon ekonomi (loadDomainInput kontrollerar rollen igen mot databasen).
 */
export default async function LonsamhetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [ctx, sp] = await Promise.all([requireRoute("lonsamhet"), searchParams]);
  // Länkar med äldre namn (?grupp=, ?fran=, ?till=) skrivs om till sidans och skalets.
  const canonical = canonicalLonsamhetQuery(sp);
  if (canonical !== null) redirect(`/lonsamhet${canonical}`);

  // Allt läses parallellt. Efter vinsten: återbetalningar och fasta kostnader. Indata och
  // modellen med samma kod som Daglig kontroll (./_lib/data).
  const periodP = loadPeriod(sp);
  const [{ p, input, organization, model }, adjustments, sync, shareToggle, advice] =
    await Promise.all([
      loadLonsamhetWith(requestPageLoaders(), sp, {
        carry: carriedQuery(sp).replace(/^\?/, ""),
        lastOrderDate: loadLastOrderDate,
      }),
      periodP.then((x) => loadProfitAdjustments(x.period)),
      loadSyncInfo(),
      requestStoreShareView(),
      // Prisråd: hela organisationen i dag (samma som punkten i Att göra), oavsett period.
      // Ett fel i Prisråd ska aldrig stoppa Lönsamhet: avsnittet visas då inte.
      currentViewer()
        .then((viewer) => loadPriceAdviceFor(viewer, new Date(ctx.now)))
        .catch((error: unknown) => {
          unstable_rethrow(error);
          console.error("[lonsamhet] Prisråd kunde inte läsas:", error);
          return null;
        }),
    ]);

  const stale = homeStaleImport(sync, p.period.end, ctx.now, ctx.timeZone);
  const result = resultAfterProfit({
    current: input.current,
    organization: organization.current,
    refunds: adjustments.refunds,
    fixedCosts: adjustments.fixedCosts,
    freePacks: adjustments.freePacks,
    scope: p.scope,
    machines: input.machines.map((m) => ({ id: m.id, name: m.code || m.name })),
  });

  const selectedTitle = parseTitleParam(sp.titel);
  const initialView: ViewKey = parseViewParam(sp.vy) ?? "title";
  const initialTrend: TrendKey = parseTrendParam(sp.per) ?? model.defaultTrend;
  const fileStem = `lonsamhet-${model.period.start}-${model.period.end}`;
  const b = model.bridge;

  const meta = [
    { label: "Period", value: model.periodLabel },
    ...(model.scopeLabel ? [{ label: "Filter", value: model.scopeLabel }] : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 md:px-8 md:pt-12">
      <div className="rise flex flex-col gap-10 pb-12 max-md:relative max-md:gap-5 max-md:pb-8 md:gap-12 md:pb-16">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Lönsamhet · ${model.days}${NBSP}d`}
          title={model.headline.title}
          aside={model.headline.aside}
          meta={meta}
          // Mobil: perioden och filtret står i raden överst. En varning (en produkt ger
          // mer än halva vinsten) skrivs i varningsfärg.
          className={cn(
            "max-md:pr-10 max-md:[&_dl]:hidden",
            model.headline.warning && "[&_h1>span:last-child]:text-signal-fg",
          )}
        />
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 max-md:contents">
          {/* Mobil: AI-frågan och butikernas andel bakom "⋯" uppe till höger. */}
          <MobileMore
            label="Fler val för lönsamhet"
            className="max-md:absolute max-md:-top-2 max-md:-right-2"
          >
            <AiPageLine metric="vinsten" route="lonsamhet" menuItem />
            {/* Med vald butik dras butikens andel alltid; knappen behövs bara utan butik. */}
            {(p.scope.storeId && !p.scope.machineId) ||
            model.bridge.compensationOre === 0 ? null : (
              <Suspense fallback={null}>
                <StoreShareToggle on={shareToggle} menuItem />
              </Suspense>
            )}
          </MobileMore>
        </div>
        {model.orders > 0 ? (
          <MobileFold summary="Fler siffror" meta={String(model.kpis.length)}>
            <LonsamhetKpis
              kpis={model.kpis}
              label={`Nyckeltal · ${model.periodLabel}`}
              comparison={model.comparisonLabel}
            />
          </MobileFold>
        ) : null}
        {stale ? <StaleImportLine stale={stale} today={ctx.today} canEdit={ctx.canEdit} /> : null}
      </div>

      {advice ? <PriceAdviceSection advice={advice} canEdit={ctx.canEdit} /> : null}

      {model.orders === 0 ? (
        <section className={SECTION} aria-label="Ingen försäljning">
          <StateMessage
            kind="empty"
            message={
              model.scopeLabel
                ? `Ingen försäljning för ${model.scopeLabel} i perioden.`
                : "Ingen försäljning i perioden."
            }
            action={
              p.dataStart
                ? { label: "Visa hela historiken", href: allHistoryHref(sp) }
                : { label: "Gå till datakällor", href: "/datakallor" }
            }
          />
        </section>
      ) : (
        <>
          <section
            aria-labelledby="till-vinst"
            className={`rise ${SECTION}`}
            style={{ "--i": 1 } as CSSProperties}
          >
            <SectionHeader
              id="till-vinst"
              eyebrow={`Intäkt till vinst · ${model.days}${NBSP}d`}
              title="Från intäkt till vinst."
            />
            <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
              <Panel grid marks className="lg:col-span-7 lg:self-start">
                <LonsamhetBridge bridge={b} />
              </Panel>
              <Panel className="flex flex-col lg:col-span-5">
                <ResultAfterProfitPanel
                  result={result}
                  costLines={input.costLines}
                  profitLabel={b.profitLabel}
                />
                {model.showStoreShare ? (
                  <CompensationBreakdown bridge={b} costLines={input.costLines} />
                ) : null}
                <UnpricedSummary unpriced={model.unpriced} />
              </Panel>
            </div>
          </section>

          <div
            className="rise border-t border-line py-12 max-md:py-8 md:py-16"
            style={{ "--i": 2 } as CSSProperties}
          >
            <AnalysisSection
              table={{
                initialView,
                views: model.views,
                titles: model.viewTitles,
                totals: model.totals,
                periodLabel: model.periodLabel,
                days: model.days,
                fileStem,
                selectedTitle,
                showStoreShare: model.showStoreShare,
                storeShareLabel: b.storeShareLabel,
              }}
              trend={{
                initialTrend,
                trend: model.trend,
                days: model.days,
                showStoreShare: model.showStoreShare,
                total: { profitOre: b.profitOre, marginBp: b.marginBp },
              }}
              initialTab={parseAnalysisTab(sp.visa)}
              rhythm={
                // Managerpaket 6: försäljningsrytm och topplista med förändring (samma order).
                <RhythmSection
                  heat={salesHeatmap(input.current.orders, ctx.timeZone)}
                  days={model.days}
                  movers={buildMovers({
                    current: input.current,
                    previous: input.previous,
                    names: moverNames(input),
                    hrefs: {
                      machine: (code) => machineHref(code, carriedQuery(sp)),
                      store: (id) => `/butiker/${encodeURIComponent(id)}${carriedQuery(sp)}`,
                    },
                  })}
                  compareLabel={
                    input.previous && input.previous.orders.length > 0
                      ? `mot ${periodText(input.previous.period, ctx.today)}`
                      : null
                  }
                />
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
