import type { Metadata } from "next";

import { carriedQuery } from "@/components/shell/period-state";
import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";

import { CompensationBreakdown, UnpricedSummary } from "./_components/breakdown";
import { LonsamhetBridge } from "./_components/bridge";
import { LonsamhetKpis } from "./_components/kpis";
import { TableSection, TrendSection } from "./_components/sections";
import { buildLonsamhetModel, periodText, type TrendKey, type ViewKey } from "./_lib/model";
import { sentence } from "./_lib/headline";
import { parseTrendParam, parseViewParam } from "./_lib/params";

export const metadata: Metadata = { title: "Lönsamhet" };

type SearchParams = Record<string, string | string[] | undefined>;

const SECTION = "flex scroll-mt-28 flex-col gap-10 border-t border-line py-12 md:gap-12 md:py-16";

/**
 * Lönsamhet: vad tjänar vi, och var? Vattenfall från intäkt till vinst, tabell per titel,
 * automat och butik, utveckling per vecka eller månad och order utan inköpspris.
 *
 * Ägare, admin och läsare. Påfyllaren skickas till sin startsida av requireRoute och
 * får aldrig någon ekonomi (loadDomainInput kontrollerar rollen igen mot databasen).
 */
export default async function LonsamhetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("lonsamhet");
  const sp = await searchParams;
  const p = await loadPeriod(sp);
  const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });

  const model = buildLonsamhetModel(
    {
      current: input.current,
      previous: input.previous,
      titles: input.titles,
      machines: input.machines,
      stores: input.stores,
      scope: input.scope,
    },
    { today: ctx.today, carry: carriedQuery(sp).replace(/^\?/, "") },
  );

  const initialView: ViewKey = parseViewParam(sp.vy);
  const initialTrend: TrendKey = parseTrendParam(sp.per) ?? model.defaultTrend;
  const fileStem = `lonsamhet-${model.period.start}-${model.period.end}`;
  const b = model.bridge;

  const meta = [
    { label: "Period", value: model.periodLabel },
    { label: "Order", value: formatInt(model.orders) },
    ...(model.scopeLabel ? [{ label: "Filter", value: model.scopeLabel }] : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 md:px-8 md:pt-12">
      <div className="flex flex-col gap-10 pb-12 md:gap-12 md:pb-16">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Lönsamhet · ${model.days}${NBSP}d`}
          title={model.headline.title}
          aside={model.headline.aside}
          meta={meta}
        />
        {model.orders > 0 ? (
          <LonsamhetKpis
            kpis={model.kpis}
            label={`Nyckeltal · ${model.periodLabel}`}
            comparison={model.comparisonLabel}
          />
        ) : null}
      </div>

      {model.orders === 0 ? (
        <section className={SECTION} aria-label="Ingen försäljning">
          <StateMessage
            kind="empty"
            message={sentence(
              `Inga order under ${model.periodLabel}${model.scopeLabel ? ` för ${model.scopeLabel}` : ""}`,
            )}
            detail={
              p.dataStart
                ? sentence(
                    `Första ordern är från ${periodText({ start: p.dataStart, end: p.dataStart }, ctx.today)}`,
                  )
                : "Inga order har importerats ännu."
            }
            action={
              p.dataStart
                ? { label: "Visa hela historiken", href: "/lonsamhet?period=allt" }
                : { label: "Gå till datakällor", href: "/datakallor" }
            }
          />
        </section>
      ) : (
        <>
          <section aria-labelledby="till-vinst" className={SECTION}>
            <SectionHeader
              id="till-vinst"
              index={1}
              eyebrow={`Intäkt till vinst · ${model.days}${NBSP}d`}
              title="Från intäkt till vinst."
              aside={
                b.revenueOre > 0
                  ? `${formatSek(b.revenueOre / 100)} blev ${formatSek(b.profitOre / 100)} efter inköp, avgifter och butiksersättning${
                      b.marginBp === null ? "" : ` (${formatPercent(b.marginBp / 10_000)})`
                    }.`
                  : "Ingen order med inköpspris i perioden."
              }
            />
            <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
              <Panel grid marks className="lg:col-span-7">
                <LonsamhetBridge bridge={b} />
              </Panel>
              <Panel className="flex flex-col lg:col-span-5">
                <UnpricedSummary unpriced={model.unpriced} />
                <CompensationBreakdown bridge={b} />
              </Panel>
            </div>
          </section>

          <div className="border-t border-line py-12 md:py-16">
            <TableSection
              index={2}
              initialView={initialView}
              views={model.views}
              titles={model.viewTitles}
              totals={model.totals}
              periodLabel={model.periodLabel}
              days={model.days}
              fileStem={fileStem}
            />
          </div>

          <div className="border-t border-line py-12 md:py-16">
            <TrendSection
              index={3}
              initialTrend={initialTrend}
              trend={model.trend}
              days={model.days}
            />
          </div>
        </>
      )}
    </div>
  );
}
