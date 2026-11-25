import type { Metadata } from "next";
import { Suspense, type CSSProperties, type ReactNode } from "react";

import {
  isSingleDay,
  periodNameInline,
  periodQuery,
  withPeriodHref,
} from "@/components/shell/period-state";
import { DaySalesCard } from "@/components/v2/day-sales";
import { SkeletonCard } from "@/components/v2/skeleton";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { formatInt, NBSP } from "@/lib/format";
import { loadPeriod, requireRoute } from "@/server/data/core";
import { loadDaySales } from "@/server/data/v2/analytics/day-sales";

import {
  CityCard,
  GoalCard,
  MonthsCard,
  PayCard,
  PriceCard,
  ResultCard,
  TopCard,
  WaterfallCard,
  WorstCard,
} from "./_components/cards";
import { SplitCard } from "./_components/split-card";
import "./_components/money.css";

export const metadata: Metadata = { title: "Pengar" };

type SearchParams = Record<string, string | string[] | undefined>;

/** Ett kort som strömmar för sig, med sin plats i ordningen på smal skärm (`o`). */
function Slot({ o, rows = 3, children }: { o: number; rows?: number; children: ReactNode }) {
  return (
    <div data-o="" style={{ "--o": o } as CSSProperties} className="min-w-0">
      <Suspense fallback={<SkeletonCard rows={rows} />}>{children}</Suspense>
    </div>
  );
}

/**
 * Pengar (/pengar, G4): resultatet för perioden, vem pengarna är till (Min andel, partnern,
 * butikerna, momsen; bara ägare och admin), vägen från intäkt till vinst, vinst per stad,
 * underpresterande automater och vinst per automat och månad i huvudspalten; att betala till
 * butikerna, månadens mål, prisrådet och bästsäljarna till höger. Ägare, admin och läsare
 * (läsaren kan inte betala). Varje kort läser samma laddare som Lönsamhet och Butiker
 * (src/server/data/v2/analytics) och strömmar för sig.
 */
export default async function MoneyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [ctx, sp] = await Promise.all([requireRoute("pengar"), searchParams]);
  const p = await loadPeriod(sp);
  const days = isSingleDay(p.resolved)
    ? periodNameInline(p.resolved)
    : `${formatInt(p.days)}${NBSP}dagar`;
  // "Vad sålde vi i går": en enskild dag får listan per titel och automat under resultatet.
  const singleDay = isSingleDay(p.resolved);
  return (
    <V2Page title="Pengar" date={headerDate(new Date(ctx.now), ctx.timeZone)} period>
      <div className="g4 g4-work" data-testid="pengar-v2">
        <div className="g4-col">
          <Slot o={1} rows={5}>
            <ResultCard sp={sp} />
          </Slot>
          {singleDay ? (
            <Slot o={1} rows={8}>
              <Sold sp={sp} />
            </Slot>
          ) : null}
          <Slot o={1} rows={6}>
            <SplitCard sp={sp} days={days} />
          </Slot>
          <Slot o={6} rows={7}>
            <WaterfallCard sp={sp} days={days} />
          </Slot>
          <Slot o={3} rows={5}>
            <CityCard sp={sp} days={days} />
          </Slot>
          <Slot o={7} rows={3}>
            <WorstCard />
          </Slot>
          <Slot o={9} rows={8}>
            <MonthsCard />
          </Slot>
        </div>
        <div className="g4-col">
          <Slot o={2} rows={3}>
            <PayCard />
          </Slot>
          <Slot o={5} rows={3}>
            <GoalCard />
          </Slot>
          <Slot o={8} rows={3}>
            <PriceCard />
          </Slot>
          <Slot o={4} rows={5}>
            <TopCard sp={sp} days={days} />
          </Slot>
        </div>
      </div>
    </V2Page>
  );
}

async function Sold({ sp }: { sp: SearchParams }) {
  const v = await loadDaySales(sp);
  return (
    <DaySalesCard
      sales={v.sales}
      title={`Sålt ${v.inline}`}
      inline={v.inline}
      link={{ href: withPeriodHref("/lonsamhet?vy=title", periodQuery(sp)), label: "Lönsamhet" }}
    />
  );
}
