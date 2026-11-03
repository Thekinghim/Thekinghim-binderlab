import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import { Suspense, type CSSProperties } from "react";

import { Panel } from "@/components/ui/frame";
import { SectionHeader, type SectionMeta } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { requireRoute } from "@/server/data/core";
import { EN_DASH, NBSP, formatDecimal, formatInt, formatPeriodShort } from "@/lib/format";

import { DailyChart } from "./_hem/daily-chart";
import { GoalsRow } from "./_hem/goals-row";
import { HomeKpis } from "./_hem/home-kpis";
import { carriedParams } from "./_hem/links";
import { loadHome } from "./_hem/load";
import { HemSkeleton } from "./_hem/skeleton";
import { TodayPaceCard } from "./_hem/today-pace";
import type { HomeDaily, HomeModel } from "./_hem/model";
import { ArrowLink, InsightList, TodoList, TopTitles, WarningLine } from "./_hem/sections";
import { OnboardingChecklist } from "./kom-igang/_components/onboarding-checklist";
import { dateOf, kr, weekdayDayText } from "./_hem/text";

export const metadata: Metadata = { title: "Hem" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Hem: "Hur går det?", "Vad behöver jag göra?" och "Vad tjänar vi?" i fyra block:
 * rubriken, nyckeltalen med en varningsrad, [intäkt per dag | Att göra + Värt att veta]
 * och de fem mest sålda titlarna. Blocken glider upp i tur och ordning.
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
          aside="Filtret pekar på något som inte finns."
          className="rise"
        />
        <StateMessage
          className="rise mt-12"
          kind="empty"
          code="0 träffar"
          message={`${noun} i filtret finns inte, eller så har du inte tillgång till den.`}
          action={{ label: "Visa hela organisationen", href: `/${carriedParams(sp, {}, false)}` }}
        />
      </div>
    );
  }

  // Två metarader: perioden och jämförelsen (antal order står i remsan).
  const meta: SectionMeta[] = [
    { label: "Period", value: periodText(model.period) },
    { label: "Jämfört med", value: model.compare ? periodText(model.compare) : EN_DASH },
  ];

  const comparisonLabel = model.compare
    ? `Nyckeltal jämfört med ${periodText(model.compare)}`
    : "Nyckeltal utan jämförelse";

  const revenue = model.kpis.find((k) => k.id === "revenue")?.value ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="rise" style={rise(0)}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={scopeText ? `Hem · ${scopeText}` : "Hem"}
          title={headline.title}
          aside={headline.aside}
          meta={headline.state === "no-data" ? undefined : meta}
        />
        <AiPageLine metric="vinsten för perioden" route="hem" className="mt-4" />
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
            message="Inga order har importerats ännu."
            action={canEdit ? { label: "Lägg till datakälla", href: "/datakallor" } : undefined}
          />
        )
      ) : (
        <>
          {onboarding ? (
            <div className="rise mt-8 md:mt-10" style={rise(1)}>
              <OnboardingChecklist
                status={onboarding}
                canEdit={canEdit}
                timeZone={timeZone}
                variant="compact"
              />
            </div>
          ) : null}

          <div className="rise mt-8 flex flex-col gap-4 md:mt-10" style={rise(1)}>
            {pace ? <TodayPaceCard pace={pace} /> : null}
            <HomeKpis kpis={model.kpis} ariaLabel={comparisonLabel} />
            <WarningLine
              unpriced={model.unpriced}
              lost={lostSales}
              stale={staleImport}
              today={today}
              canEdit={canEdit}
            />
          </div>

          {goals ? (
            <div className="mt-6 empty:hidden md:mt-8">
              <GoalsRow
                goals={goals}
                today={today}
                canEdit={canEdit}
                href={`/expansion${carriedParams(sp, { vy: "mal" })}`}
                style={rise(1)}
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

          <DailyAndTodos model={model} today={today} sp={sp} revenue={revenue} />

          {model.topTitles.rows.length > 0 ? (
            <section
              aria-labelledby="titlar"
              className="rise mt-12 scroll-mt-28 border-t border-line pt-10 md:mt-14 md:pt-12"
              style={rise(4)}
            >
              <SectionHeader
                id="titlar"
                eyebrow={`Titlar · topp ${formatInt(Math.min(TOP_N, model.topTitles.rows.length))}`}
                title="Mest sålda titlar."
                size="md"
                actions={
                  <ArrowLink href={`/lonsamhet${carriedParams(sp, { vy: "titel" })}`}>
                    Alla titlar i Lönsamhet
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

function DailyAndTodos({
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
  const side = Boolean(model.todos) || showInsights;
  if (!model.daily && !side) return null;
  // Diagrammet och Att göra + Värt att veta står bredvid varandra på dator, så att
  // "Vad behöver jag göra?" syns på första skärmen; på mobil kommer de under diagrammet.
  return (
    <div
      className="rise mt-10 grid grid-cols-1 gap-x-10 gap-y-12 border-t border-line pt-10 md:mt-12 md:pt-12 lg:grid-cols-12"
      style={rise(2)}
    >
      {model.daily ? (
        <DailySection
          daily={model.daily}
          todayPending={model.todayPending}
          todayPartial={model.todayPartial}
          today={today}
          sp={sp}
          revenue={revenue}
          className={side ? "lg:col-span-8" : "lg:col-span-12"}
        />
      ) : null}
      {side ? (
        <div
          className={`flex min-w-0 flex-col gap-10 ${model.daily ? "lg:col-span-4" : "lg:col-span-6"}`}
        >
          {model.todos ? <TodoSection model={model} sp={sp} /> : null}
          {showInsights ? <Insights model={model} /> : null}
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
    `Snitt ${kr(daily.averageOre)}/dag${peakDate ? `, bäst ${weekdayDayText(peakDate, today)}` : ""}.`,
    todayPending || todayPartial ? "I dag ej med." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section aria-labelledby="intakt-per-dag" className={`min-w-0 scroll-mt-28 ${className ?? ""}`}>
      <SectionHeader
        id="intakt-per-dag"
        eyebrow={`Intäkt per dag · ${formatInt(days)} d`}
        title="Intäkt per dag."
        aside={aside}
        size="md"
        actions={
          <ArrowLink href={`/lonsamhet${carriedParams(sp, { per: "dag", visa: "utveckling" })}`}>
            Lönsamhet per dag
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
