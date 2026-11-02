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
  const { headline } = model;

  const periodText = (p: { start: string; end: string }) =>
    formatPeriodShort({ start: dateOf(p.start), end: dateOf(p.end) }, dateOf(today));
  const dayOnly = (d: string) => periodText({ start: d, end: d });
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
          aside="Filtret i adressen pekar på något som inte finns i organisationen."
        />
        <StateMessage
          className="mt-12"
          kind="empty"
          code="0 träffar"
          message={`${noun} i filtret finns inte, eller så har du inte tillgång till den.`}
          action={{ label: "Visa hela organisationen", href: `/${carriedParams(sp, {}, false)}` }}
        />
      </div>
    );
  }

  // Perioden är skalets; nyckeltalen gäller hela den. Börjar datan inne i perioden står
  // det som en egen rad, så att perioden och jämförelsen är desamma som i skalet.
  const dataFrom =
    model.dataStart && model.dataStart > model.period.start && model.dataStart <= model.period.end
      ? model.dataStart
      : null;
  const meta: SectionMeta[] = [{ label: "Period", value: periodText(model.period) }];
  if (dataFrom) meta.push({ label: "Första order", value: dayOnly(dataFrom) });
  meta.push(
    {
      label: "Jämfört med",
      value: model.compare ? periodText(model.compare) : EN_DASH,
    },
    { label: "Order", value: formatInt(model.kpis.find((k) => k.id === "orders")?.value ?? 0) },
  );
  if (scopeText)
    meta.unshift({ label: scope?.kind === "machine" ? "Automat" : "Butik", value: scopeText });

  const comparison = model.compare
    ? `${periodText(model.period)} · jämfört med ${periodText(model.compare)}`
    : model.dataStart
      ? `${periodText(model.period)} · ingen jämförelse, datan börjar ${dayOnly(model.dataStart)}`
      : periodText(model.period);

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
          action={canEdit ? { label: "Lägg till datakälla", href: "/datakallor" } : undefined}
        />
      ) : (
        <>
          <div className="mt-8 flex flex-col gap-4 md:mt-10">
            <HomeKpis kpis={model.kpis} comparison={comparison} />
            {model.unpriced ? <UnpricedNote unpriced={model.unpriced} canEdit={canEdit} /> : null}
          </div>

          {headline.state === "no-orders" ? (
            <StateMessage
              className="mt-12"
              kind="empty"
              code="0 order"
              message="Diagrammet och topplistan visas när perioden har order."
              action={{ label: "Visa allt", href: `/${carriedParams(sp, { period: "allt" })}` }}
            />
          ) : null}

          <DailyAndTodos model={model} today={today} sp={sp} revenue={revenue} />

          <Insights model={model} />

          {model.topTitles.rows.length > 0 ? (
            <section
              aria-labelledby="titlar"
              className="mt-12 scroll-mt-28 border-t border-line pt-12 md:mt-16 md:pt-16"
            >
              <SectionHeader
                id="titlar"
                index={sectionIndex(model, "titles")}
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
                    caption={`Titlar efter intäkt ${periodText(model.period)}, med andel av intäkten.`}
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

/** Sektionernas nummer: diagrammet, Att göra (bara för roller som har den), Värt att veta, titlar. */
function sectionIndex(model: HomeModel, id: "daily" | "todos" | "insights" | "titles"): number {
  const order = [
    model.daily ? "daily" : null,
    model.todos ? "todos" : null,
    "insights",
    "titles",
  ].filter(Boolean);
  return order.indexOf(id) + 1;
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
  if (!model.daily && !model.todos) return null;
  // Diagrammet och Att göra står bredvid varandra på dator, så att "Vad behöver jag göra?"
  // syns på första skärmen; på mobil kommer Att göra direkt under diagrammet.
  return (
    <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-16 border-t border-line pt-10 md:mt-12 md:pt-12 lg:grid-cols-12">
      {model.daily ? (
        <DailySection
          daily={model.daily}
          todayPending={model.todayPending}
          today={today}
          sp={sp}
          revenue={revenue}
          index={sectionIndex(model, "daily")}
          className={model.todos ? "lg:col-span-8" : "lg:col-span-12"}
        />
      ) : null}
      {model.todos ? (
        <TodoSection
          model={model}
          sp={sp}
          index={sectionIndex(model, "todos")}
          className={model.daily ? "lg:col-span-4" : "lg:col-span-6"}
        />
      ) : null}
    </div>
  );
}

function DailySection({
  daily,
  todayPending,
  today,
  sp,
  revenue,
  index,
  className,
}: {
  daily: HomeDaily;
  todayPending: boolean;
  today: string;
  sp: SearchParams;
  revenue: number;
  index: number;
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
    sentence(`Snitt ${kr(daily.averageOre)} per dag${peakText ? `, ${peakText}` : ""}`),
    todayPending ? "I dag är inte med: inga order än." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section aria-labelledby="intakt-per-dag" className={`min-w-0 scroll-mt-28 ${className ?? ""}`}>
      <SectionHeader
        id="intakt-per-dag"
        index={index}
        eyebrow={`Intäkt per dag · ${formatInt(days)} d`}
        title="Intäkt per dag."
        aside={aside}
        size="md"
        actions={
          <ArrowLink href={`/lonsamhet${carriedParams(sp, { grupp: "dag" })}`}>
            Lönsamhet per dag
          </ArrowLink>
        }
      />
      <Panel grid marks className="mt-8">
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

function TodoSection({
  model,
  sp,
  index,
  className,
}: {
  model: HomeModel;
  sp: SearchParams;
  index: number;
  className?: string;
}) {
  if (!model.todos) return null;
  return (
    <section aria-labelledby="att-gora" className={`min-w-0 scroll-mt-28 ${className ?? ""}`}>
      <SectionHeader
        id="att-gora"
        index={index}
        eyebrow={`Att göra · ${formatInt(model.todoCount)} st`}
        title="Att göra."
        aside={todoAside(model)}
        size="md"
      />
      <div className="mt-6 flex flex-col gap-4">
        {model.todos.length > 0 ? (
          <TodoList todos={model.todos} />
        ) : (
          <StateMessage compact kind="empty" code="0 punkter" message="Inget att göra just nu." />
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
  );
}

function Insights({ model }: { model: HomeModel }) {
  if (model.headline.state !== "ok") return null;
  const n = model.insights.length;
  return (
    <section
      aria-labelledby="vart-att-veta"
      className="mt-12 min-w-0 scroll-mt-28 border-t border-line pt-12 md:mt-16 md:pt-16"
    >
      <SectionHeader
        id="vart-att-veta"
        index={sectionIndex(model, "insights")}
        eyebrow={`Värt att veta · ${formatInt(n)} st`}
        title="Värt att veta."
        aside={
          n === 0
            ? "Inget utöver det som står ovan sticker ut i perioden."
            : n === 1
              ? "En iakttagelse ur perioden, med underlaget."
              : `${formatInt(n)} iakttagelser ur perioden, var och en med underlaget.`
        }
        size="md"
      />
      {n > 0 ? (
        <div className="mt-8">
          <InsightList insights={model.insights} />
        </div>
      ) : null}
    </section>
  );
}

function todoAside(model: HomeModel): string {
  if (model.todoCount === 0) return "Inget väntar.";
  const now = model.todoNowCount;
  const total = `${formatInt(model.todoCount)} ${model.todoCount === 1 ? "punkt" : "punkter"}`;
  if (now === 0) return `${total}, ingen brådskar.`;
  return `${total}, ${formatInt(now)} gäller nu.`;
}

/** Topplistans rubrik: hur spridd intäkten är (den största titeln står i listan och i Värt att veta). */
function topTitlesAside(model: HomeModel): string {
  const t = model.topTitles;
  const sold = `${formatInt(t.totalTitles)} ${t.totalTitles === 1 ? "titel" : "titlar"} sålde`;
  if (t.rows.length < 3 || t.totalTitles <= 3) return `${sold}.`;
  const top3 = t.rows.slice(0, 3).reduce((n, r) => n + r.shareBp, 0);
  return `${sold}, de tre största står för ${shareText(top3)} av intäkten.`;
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
