import type { Metadata } from "next";

import { Panel } from "@/components/ui/frame";
import { SectionHeader, type SectionMeta } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { EN_DASH, NBSP, formatDecimal, formatInt, formatPeriodShort } from "@/lib/format";

import { DailyChart } from "./_hem/daily-chart";
import { HomeKpis } from "./_hem/home-kpis";
import { carriedParams } from "./_hem/links";
import { loadHome } from "./_hem/load";
import { shareText, type HomeDaily, type HomeModel } from "./_hem/model";
import { ArrowLink, InsightList, TodoList, TopTitles, UnpricedNote } from "./_hem/sections";
import { dateOf, kr, sentence, weekdayDayText } from "./_hem/text";

export const metadata: Metadata = { title: "Hem" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Hem: "Hur går det?", "Vad behöver jag göra?" och "Vad tjänar vi?" på en sida.
 * Rubriken sammanfattar läget med siffror, sedan nyckeltalen, intäkt per dag, de
 * viktigaste punkterna i Att göra, Värt att veta och topplistan över titlar.
 *
 * Bara ägare, admin och läsare (requireRoute i loadHome skickar påfyllaren till Att
 * göra). Allt räknas i @/domain och @/analytics via modellen i _hem/model.ts.
 */
export default async function HemPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { model, today, scope, canEdit } = await loadHome(sp);
  const { headline, coverage } = model;

  const periodText = (p: { start: string; end: string }) =>
    formatPeriodShort({ start: dateOf(p.start), end: dateOf(p.end) }, dateOf(today));
  const shown = coverage ?? model.period;
  const scopeText = scope
    ? scope.kind === "machine"
      ? `${scope.code ? `${scope.code.replace("-", "‑")} ` : ""}${scope.name}`
      : scope.name
    : null;

  const meta: SectionMeta[] = [
    { label: "Period", value: periodText(shown) },
    {
      label: "Jämfört med",
      value: model.compare ? periodText(model.compare) : EN_DASH,
    },
    { label: "Order", value: formatInt(model.kpis.find((k) => k.id === "orders")?.value ?? 0) },
  ];
  if (scopeText)
    meta.unshift({ label: scope?.kind === "machine" ? "Automat" : "Butik", value: scopeText });

  const comparison = model.compare
    ? `${periodText(shown)} · jämfört med ${periodText(model.compare)}`
    : model.dataStart && coverage
      ? `${periodText(shown)} · ingen jämförelse, datan börjar ${periodText({ start: model.dataStart, end: model.dataStart })}`
      : periodText(shown);

  const revenue = model.kpis.find((k) => k.id === "revenue")?.value ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={scopeText ? `Hem · ${scopeText}` : "Hem"}
        title={headline.title}
        aside={headline.aside}
        description={headline.lead.join(" ") || undefined}
        meta={meta}
      />

      {headline.state === "no-data" ? (
        <StateMessage
          className="mt-12"
          kind="not-configured"
          message="Inga order har importerats ännu."
          detail="Nyckeltal, intäkt per dag och topplistan räknas fram ur orderna."
          action={canEdit ? { label: "Lägg till datakälla →", href: "/datakallor" } : undefined}
        />
      ) : (
        <>
          <div className="mt-10 flex flex-col gap-4 md:mt-12">
            <HomeKpis kpis={model.kpis} comparison={comparison} />
            {model.unpriced ? <UnpricedNote unpriced={model.unpriced} canEdit={canEdit} /> : null}
          </div>

          {headline.state === "no-orders" ? (
            <StateMessage
              className="mt-12"
              kind="empty"
              code="0 order"
              message={`Inga betalda order ${periodText(model.period)}.`}
              detail={
                model.dataStart
                  ? `Första ordern i datan är från ${periodText({ start: model.dataStart, end: model.dataStart })}.`
                  : undefined
              }
              action={{ label: "Visa allt →", href: `/${carriedParams(sp, { period: "allt" })}` }}
            />
          ) : null}

          {model.daily ? (
            <DailySection daily={model.daily} today={today} sp={sp} revenue={revenue} />
          ) : null}

          <TodoAndInsights model={model} sp={sp} />

          {model.topTitles.rows.length > 0 ? (
            <section
              aria-labelledby="titlar"
              className="mt-12 scroll-mt-28 border-t border-line pt-12 md:mt-16 md:pt-16"
            >
              <SectionHeader
                id="titlar"
                index={model.todos ? 4 : 3}
                eyebrow={`Titlar · ${formatInt(model.topTitles.totalTitles)} st`}
                title="Mest sålda titlar."
                aside={topTitlesAside(model)}
                actions={
                  <ArrowLink href={`/lonsamhet${carriedParams(sp, { grupp: "titel" })}`}>
                    Lönsamhet per titel
                  </ArrowLink>
                }
              />
              <div className="mt-10 grid grid-cols-1 gap-x-8 gap-y-8 md:mt-12 lg:grid-cols-12">
                <div className="min-w-0 lg:col-span-8">
                  <TopTitles
                    top={model.topTitles}
                    totalRevenueOre={revenue}
                    caption={`Titlar efter intäkt ${periodText(shown)}, med andel av intäkten.`}
                  />
                </div>
                <TitlesAside model={model} />
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DailySection({
  daily,
  today,
  sp,
  revenue,
}: {
  daily: HomeDaily;
  today: string;
  sp: SearchParams;
  revenue: number;
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
  const summary = [
    `Intäkt per dag, ${formatInt(days)} dagar: totalt ${kr(revenue)}, snitt ${kr(daily.averageOre)} per dag`,
    peakText ? `, ${peakText}` : "",
    daily.compareOre
      ? `. Streckad linje: samma antal dagar i perioden innan, totalt ${kr(daily.compareOre.reduce((a, b) => a + b, 0))}.`
      : ".",
  ].join("");

  return (
    <section
      aria-labelledby="intakt-per-dag"
      className="mt-12 scroll-mt-28 border-t border-line pt-12 md:mt-16 md:pt-16"
    >
      <SectionHeader
        id="intakt-per-dag"
        index={1}
        eyebrow={`Intäkt per dag · ${formatInt(days)} d`}
        title="Intäkt per dag."
        aside={sentence(`Snitt ${kr(daily.averageOre)}${peakText ? `, ${peakText}` : ""}`)}
        actions={
          <ArrowLink href={`/lonsamhet${carriedParams(sp, { grupp: "dag" })}`}>
            Lönsamhet per dag
          </ArrowLink>
        }
      />
      <Panel grid marks className="mt-10 md:mt-12">
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

function TodoAndInsights({ model, sp }: { model: HomeModel; sp: SearchParams }) {
  const hasTodos = model.todos !== null;
  if (!hasTodos && model.insights.length === 0) return null;
  const insightIndex = hasTodos ? 3 : 2;

  return (
    <div className="mt-12 grid grid-cols-1 gap-x-8 gap-y-16 border-t border-line pt-12 md:mt-16 md:pt-16 lg:grid-cols-12">
      {model.todos ? (
        <section aria-labelledby="att-gora" className="min-w-0 scroll-mt-28 lg:col-span-5">
          <SectionHeader
            id="att-gora"
            index={2}
            eyebrow={`Att göra · ${formatInt(model.todoCount)} st`}
            title="Att göra."
            aside={todoAside(model)}
            size="md"
          />
          <div className="mt-8 flex flex-col gap-4">
            {model.todos.length > 0 ? (
              <TodoList todos={model.todos} />
            ) : (
              <StateMessage
                compact
                kind="empty"
                code="0 punkter"
                message="Inget att göra just nu."
              />
            )}
            {model.todoCount > model.todos.length ? (
              <ArrowLink href={`/att-gora${carriedParams(sp)}`}>
                {`Visa alla ${formatInt(model.todoCount)} i Att göra`}
              </ArrowLink>
            ) : model.todoCount > 0 ? (
              <ArrowLink href={`/att-gora${carriedParams(sp)}`}>Öppna Att göra</ArrowLink>
            ) : null}
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="vart-att-veta"
        className={
          hasTodos ? "min-w-0 scroll-mt-28 lg:col-span-7" : "min-w-0 scroll-mt-28 lg:col-span-12"
        }
      >
        <SectionHeader
          id="vart-att-veta"
          index={insightIndex}
          eyebrow={`Värt att veta · ${formatInt(model.insights.length)} st`}
          title="Värt att veta."
          aside={
            model.insights.length > 0
              ? `${formatInt(model.insights.length)} iakttagelser ur perioden, var och en med underlaget.`
              : "Inga iakttagelser som håller för perioden."
          }
          size="md"
        />
        <div className={hasTodos ? "mt-8" : "mt-8 max-w-3xl"}>
          {model.insights.length > 0 ? (
            <InsightList insights={model.insights} />
          ) : (
            <StateMessage
              compact
              kind="empty"
              code="0 iakttagelser"
              message="Perioden har för lite försäljning för att något ska sticka ut."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function todoAside(model: HomeModel): string {
  if (model.todoCount === 0) return "Inget väntar.";
  const now = model.todoNowCount;
  const total = `${formatInt(model.todoCount)} ${model.todoCount === 1 ? "punkt" : "punkter"}`;
  if (now === 0) return `${total}, ingen brådskar.`;
  return `${total}, ${formatInt(now)} gäller nu.`;
}

function topTitlesAside(model: HomeModel): string {
  const first = model.topTitles.rows[0];
  if (!first) return "";
  const top3 = model.topTitles.rows.slice(0, 3).reduce((n, r) => n + r.shareBp, 0);
  const lead = `${first.name} står för ${shareText(first.shareBp)} av intäkten`;
  return model.topTitles.rows.length >= 3 && model.topTitles.totalTitles > 3
    ? `${lead}, de tre största för ${shareText(top3)}.`
    : `${lead}.`;
}

function TitlesAside({ model }: { model: HomeModel }) {
  const t = model.topTitles;
  const items: { label: string; value: string }[] = [
    { label: "Titlar som sålt", value: formatInt(t.totalTitles) },
    {
      label: "Order",
      value: formatInt(t.rows.reduce((n, r) => n + r.orders, 0) + (t.rest?.orders ?? 0)),
    },
  ];
  if (model.unpriced) {
    items.push({
      label: "Utan inköpspris",
      value: `${formatInt(model.unpriced.titles.length)} ${model.unpriced.titles.length === 1 ? "titel" : "titlar"}`,
    });
  }
  return (
    <dl className="flex flex-col self-start lg:col-span-4">
      {items.map((i) => (
        <div
          key={i.label}
          className="flex items-baseline justify-between gap-4 border-t border-line py-2 last:border-b"
        >
          <dt className="label text-subtle">{i.label}</dt>
          <dd className="tnum text-sm text-fg">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
