import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import { Suspense, type CSSProperties } from "react";

import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { requireRoute } from "@/server/data/core";
import { NBSP, formatDecimal, formatInt, formatPeriodShort } from "@/lib/format";

import { DailyChart } from "./_hem/daily-chart";
import { GoalsRow } from "./_hem/goals-row";
import { HemHero } from "./_hem/hero";
import { HomeKpis } from "./_hem/home-kpis";
import { carriedParams } from "./_hem/links";
import { loadHome } from "./_hem/load";
import { HemSkeleton } from "./_hem/skeleton";
import { TodayPaceCard } from "./_hem/today-pace";
import type { HomeDaily, HomeModel } from "./_hem/model";
import { ArrowLink, InsightList, TodoList, TopTitles, WarningLine } from "./_hem/sections";
import { OnboardingChecklist } from "./kom-igang/_components/onboarding-checklist";
import { ShrinkageLine } from "./_hem/shrinkage-line";
import { MorningBrief } from "./_hem/morning-brief";
import { dateOf, kr, weekdayDayText } from "./_hem/text";

export const metadata: Metadata = { title: "Hem" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Hem: vinsten som en stor siffra med delningen, i dag hittills, målen och morgonbriefen
 * överst (i den ordningen); under dem det som behöver göras, nyckeltalen, intäkt per dag
 * och de mest sålda titlarna. Blocken glider upp i tur och ordning.
 *
 * Bara ägare, admin och läsare (requireRoute i loadHome skickar påfyllaren till Att
 * göra). Allt räknas i @/domain och @/analytics via modellen i _hem/model.ts.
 */
export default async function HemPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Rollen kontrolleras före strömningen, så att påfyllaren får en riktig omdirigering.
  await requireRoute("hem");
  // Skalet och skelettet går ut direkt; siffrorna strömmar in när de är räknade
  // (Att göra och förlorad försäljning tar längst tid med mycket data).
  return (
    <Suspense fallback={<HemSkeleton />}>
      <HemContent searchParams={searchParams} />
    </Suspense>
  );
}

async function HemContent({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const {
    model,
    today,
    scope,
    canEdit,
    lostSales,
    onboarding,
    staleImport,
    goals,
    pace,
    timeZone,
  } = await loadHome(sp);
  const { headline } = model;

  const periodText = (p: { start: string; end: string }) =>
    formatPeriodShort({ start: dateOf(p.start), end: dateOf(p.end) }, dateOf(today));
  const scopeText = scope
    ? scope.kind === "machine"
      ? `${scope.code ? `${scope.code.replace("-", "‑")} ` : ""}${scope.name}`
      : scope.name
    : null;

  // Filtret pekar på en automat eller butik som inte finns (eller inte syns för rollen).
  if (scope?.missing) {
    const noun = scope.kind === "machine" ? "Automaten" : "Butiken";
    return (
      <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Hem"
          title={`${noun} finns inte.`}
          className="rise"
        />
        <StateMessage
          className="rise mt-12"
          kind="empty"
          code="0 träffar"
          message={`${noun} finns inte eller är dold för dig.`}
          action={{ label: "Visa allt", href: `/${carriedParams(sp, {}, false)}` }}
        />
      </div>
    );
  }

  const revenue = model.kpis.find((k) => k.id === "revenue")?.value ?? 0;
  const comparisonLabel = model.compare
    ? `Nyckeltal jämfört med ${periodText(model.compare)}`
    : "Nyckeltal";
  const eyebrow = scopeText ? `Hem · ${scopeText}` : "Hem";

  // Ordning efter vikt: vinsten (stort tal + delning), i dag, målen, morgonbriefen. Allt
  // annat (att göra, nyckeltal, diagram, titlar) står under.
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="rise" style={rise(0)}>
        <HemHero headline={headline} eyebrow={eyebrow}>
          <AiPageLine metric="vinsten för perioden" route="hem" className="mt-1" />
        </HemHero>
      </div>

      {headline.state === "no-data" ? (
        // Ett enda kort när inget är importerat: checklistan om den finns, annars en rad.
        onboarding ? (
          <div className="rise mt-8 md:mt-10" style={rise(1)}>
            <OnboardingChecklist
              status={onboarding}
              canEdit={canEdit}
              timeZone={timeZone}
              variant="compact"
            />
          </div>
        ) : (
          <StateMessage
            className="rise mt-12"
            kind="not-configured"
            message="Inga order än."
            action={canEdit ? { label: "Koppla Awish", href: "/datakallor" } : undefined}
          />
        )
      ) : (
        <>
          {pace ? (
            <div className="rise mt-8 md:mt-10" style={rise(1)}>
              <TodayPaceCard pace={pace} />
            </div>
          ) : null}

          {goals ? (
            <div className="mt-6 empty:hidden">
              <GoalsRow
                goals={goals}
                today={today}
                canEdit={canEdit}
                href={`/expansion${carriedParams(sp, { vy: "mal" })}`}
                style={rise(2)}
              />
            </div>
          ) : null}

          {/* Morgonbriefen (AI, en gång per dag): bara utan filter, inget alls utan AI. */}
          {scope ? null : (
            <Suspense fallback={null}>
              <MorningBrief todoHref={`/att-gora${carriedParams(sp)}`} className="mt-6" />
            </Suspense>
          )}

          {onboarding ? (
            <div className="rise mt-8 md:mt-10" style={rise(3)}>
              <OnboardingChecklist
                status={onboarding}
                canEdit={canEdit}
                timeZone={timeZone}
                variant="compact"
              />
            </div>
          ) : null}

          {headline.state === "no-orders" ? (
            <StateMessage
              className="rise mt-12"
              kind="empty"
              code="0 order"
              message="Inga order i perioden."
              action={{ label: "Visa allt", href: `/${carriedParams(sp, { period: "allt" })}` }}
            />
          ) : null}

          {/* Det som behöver göras: punkterna, varningarna och svinnet. */}
          <div
            className="rise mt-10 flex flex-col gap-4 border-t border-line pt-8 empty:hidden md:mt-12"
            style={rise(4)}
          >
            {model.todos ? <TodoSection model={model} sp={sp} /> : null}
            <WarningLine
              unpriced={model.unpriced}
              lost={lostSales}
              stale={staleImport}
              today={today}
              canEdit={canEdit}
            />
            {/* Svinn: en rad bara när pack saknas. */}
            <Suspense fallback={null}>
              <ShrinkageLine />
            </Suspense>
          </div>

          {headline.state === "ok" ? (
            <div className="rise mt-10 md:mt-12" style={rise(5)}>
              <HomeKpis kpis={model.kpis} ariaLabel={comparisonLabel} />
            </div>
          ) : null}

          <DailyAndInsights model={model} today={today} sp={sp} revenue={revenue} />

          {model.topTitles.rows.length > 0 ? (
            <section
              aria-labelledby="titlar"
              className="rise mt-12 scroll-mt-28 border-t border-line pt-10 md:mt-14 md:pt-12"
              style={rise(7)}
            >
              <SectionHeader
                id="titlar"
                title="Mest sålda."
                size="md"
                actions={
                  <ArrowLink href={`/lonsamhet${carriedParams(sp, { vy: "titel" })}`}>
                    Alla titlar
                  </ArrowLink>
                }
              />
              <div className="mt-6 lg:max-w-[66%]">
                <TopTitles
                  top={{
                    ...model.topTitles,
                    rows: model.topTitles.rows.slice(0, TOP_N),
                    rest: null,
                  }}
                  caption={`De ${formatInt(TOP_N)} titlarna med högst intäkt ${periodText(model.period)}, med andel av intäkten.`}
                />
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Topplistan på Hem: de fem största; resten finns i Lönsamhet per titel. */
const TOP_N = 5;

/** Fördröjning för blockens uppglidning (globals.css .rise). */
function rise(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

// ---------------------------------------------------------------------------

function DailyAndInsights({
  model,
  today,
  sp,
  revenue,
}: {
  model: HomeModel;
  today: string;
  sp: SearchParams;
  revenue: number;
}) {
  const showInsights = model.headline.state === "ok" && model.insights.length > 0;
  if (!model.daily && !showInsights) return null;
  return (
    <div
      className="rise mt-10 grid grid-cols-1 gap-x-10 gap-y-12 border-t border-line pt-10 md:mt-12 md:pt-12 lg:grid-cols-12"
      style={rise(6)}
    >
      {model.daily ? (
        <DailySection
          daily={model.daily}
          todayPending={model.todayPending}
          todayPartial={model.todayPartial}
          today={today}
          sp={sp}
          revenue={revenue}
          className={showInsights ? "lg:col-span-8" : "lg:col-span-12"}
        />
      ) : null}
      {showInsights ? (
        <div className={`min-w-0 ${model.daily ? "lg:col-span-4" : "lg:col-span-6"}`}>
          <Insights model={model} />
        </div>
      ) : null}
    </div>
  );
}

function DailySection({
  daily,
  todayPending,
  todayPartial,
  today,
  sp,
  revenue,
  className,
}: {
  daily: HomeDaily;
  todayPending: boolean;
  todayPartial: boolean;
  today: string;
  sp: SearchParams;
  revenue: number;
  className?: string;
}) {
  const peakDate = daily.peakIndex !== null ? daily.dates[daily.peakIndex] : undefined;
  const peakValue = daily.peakIndex !== null ? (daily.revenueOre[daily.peakIndex] ?? 0) : 0;
  const ratio =
    daily.peakRatioTenths !== null
      ? `${formatDecimal(daily.peakRatioTenths / 10)}${NBSP}× snittet`
      : null;
  const peakText = peakDate
    ? `bästa dagen ${weekdayDayText(peakDate, today)} med ${kr(peakValue)}`
    : null;
  const days = daily.dates.length;
  const compareName = `Föreg. ${formatInt(days)}${NBSP}d`;
  const shownTotal = daily.revenueOre.reduce((a, b) => a + b, 0);
  const summary = [
    `Intäkt per dag, ${formatInt(days)} dagar: totalt ${kr(shownTotal || revenue)}, snitt ${kr(daily.averageOre)} per dag`,
    peakText ? `, ${peakText}` : "",
    daily.compareOre
      ? `. Streckad linje: perioden innan, dag för dag, totalt ${kr(daily.compareOre.reduce((a, b) => a + b, 0))}.`
      : ".",
  ].join("");
  const aside = [
    `Snitt ${kr(daily.averageOre)}/dag.`,
    todayPending || todayPartial ? "I dag ej med." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section aria-labelledby="intakt-per-dag" className={`min-w-0 scroll-mt-28 ${className ?? ""}`}>
      <SectionHeader
        id="intakt-per-dag"
        title="Intäkt per dag."
        aside={aside}
        size="md"
        actions={
          <ArrowLink href={`/lonsamhet${carriedParams(sp, { per: "dag", visa: "utveckling" })}`}>
            Mer
          </ArrowLink>
        }
      />
      <Panel grid marks className="fade-in mt-6">
        <DailyChart
          dates={daily.dates}
          revenueOre={daily.revenueOre}
          compareOre={daily.compareOre}
          peakIndex={daily.peakIndex}
          peakNote={ratio}
          averageOre={daily.averageOre}
          averageLabel="Snitt"
          compareName={compareName}
          summary={summary}
        />
      </Panel>
    </section>
  );
}

function TodoSection({ model, sp }: { model: HomeModel; sp: SearchParams }) {
  if (!model.todos) return null;
  const href = `/att-gora${carriedParams(sp)}`;
  return (
    <section aria-labelledby="att-gora" className="min-w-0 scroll-mt-28">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="att-gora" className="label text-muted">
          {`Att göra · ${formatInt(model.todoCount)}`}
          {model.todoNowCount > 0 ? (
            <span className="text-signal-fg">{` · ${formatInt(model.todoNowCount)} nu`}</span>
          ) : null}
        </h2>
        {model.todoCount > 0 ? (
          <ArrowLink href={href}>
            {model.todoCount > model.todos.length ? `Alla ${formatInt(model.todoCount)}` : "Öppna"}
          </ArrowLink>
        ) : null}
      </div>
      <div className="mt-3">
        {model.todos.length > 0 ? (
          <TodoList todos={model.todos} />
        ) : (
          <StateMessage compact kind="empty" code="0 punkter" message="Inget att göra just nu." />
        )}
      </div>
    </section>
  );
}

function Insights({ model }: { model: HomeModel }) {
  return (
    <section aria-labelledby="vart-att-veta" className="min-w-0 scroll-mt-28">
      <h2 id="vart-att-veta" className="label text-muted">
        {`Värt att veta · ${formatInt(model.insights.length)}`}
      </h2>
      <div className="mt-3">
        <InsightList insights={model.insights} />
      </div>
    </section>
  );
}
