import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { simpleHomeFor } from "@/components/shell/simple-view";
import { PeriodSegment } from "@/components/v2/period-segment";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { Skeleton, SkeletonCard } from "@/components/v2/skeleton";
import { messages } from "@/i18n";
import { formatPeriodShort } from "@/lib/format";
import {
  loadContext,
  loadOptionalContextIfSignedIn,
  loadPeriod,
  requireRoute,
} from "@/server/data/core";
import { loadKpiBand } from "@/server/data/v2/analytics/kpi-band";
import { loadLiveOrders } from "@/server/data/v2/analytics/live";
import { loadFleetState } from "@/server/data/v2/fleet";
import { loadDayRoute } from "@/server/data/v2/route";

import { SalesScreen } from "./forsaljning/_components/sales-screen";
import { dateOf } from "./_hem/text";
import {
  GeoCardView,
  GoalCardView,
  LossCardView,
  OpsCardView,
  ResultCard,
  ShopsCardView,
  StockCardView,
  TopCardView,
  WhenCardView,
  WorstCardView,
} from "./_hem/v2/analytics";
import { ActionsCard, HemKpiBand, LiveCard, RouteCard, TodayLine, TodoCard } from "./_hem/v2/today";
import { loadHemToday } from "./_hem/v2/today-data";

import "./_hem/v2/hem.css";

/** Hem; i Enkel vy är startsidan Försäljning (på personens språk). */
export async function generateMetadata(): Promise<Metadata> {
  const ctx = await loadOptionalContextIfSignedIn().catch(() => null);
  if (ctx?.viewMode === "simple") return { title: messages(ctx.locale).sales.title };
  return { title: "Hem" };
}

type SearchParams = Record<string, string | string[] | undefined>;

/** Roller som får ändra rutten och fylla på (samma som Fyll på). */
const ROUTE_ROLES = new Set(["owner", "admin", "refiller"]);

/**
 * Hem i V2 (docs/design/v2/byggplan.md 2.2, prototypen #hem): dagens rad, KPI-bandet, Kräver
 * åtgärd (störst förlorad vinst först), Senaste köp, Dagens rutt, Att göra och tio analyskort
 * för vald period (?period=30d|7d|idag). Varje kort strömmar för sig (Suspense) men läser
 * samma memoiserade underlag.
 *
 * Alla fyra roller. Påfyllaren ser bara det som är att göra: inga belopp, inget KPI-band, inga
 * köp och inga pengakort (servern skickar inget av det, se _hem/v2/today-data.ts). Läsaren
 * ser allt men får inga knappar som ändrar något.
 */
export default async function HemPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Enkel vy: startsidan är Försäljning (utan omväg via en omdirigering efter inloggningen).
  const simple = await loadContext();
  if (simple.viewMode === "simple") {
    if (!simple.canSeeEconomy) redirect(simpleHomeFor(simple.role));
    return <SalesScreen ctx={simple} week={(await searchParams).vecka} />;
  }
  const ctx = await requireRoute("hem");
  const sp = await searchParams;
  const economy = ctx.canSeeEconomy;
  const canRoute = ROUTE_ROLES.has(ctx.role);
  const p = economy ? await loadPeriod(sp) : null;
  const periodName =
    p === null
      ? null
      : p.key === "30d"
        ? "30 dagar"
        : p.key === "7d"
          ? "7 dagar"
          : p.key === "idag"
            ? "i dag"
            : formatPeriodShort(
                { start: dateOf(p.period.start), end: dateOf(p.period.end) },
                dateOf(ctx.today),
              );

  return (
    <V2Page
      title="Hem"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period={economy}
      className="hem2"
      sub={
        <Suspense fallback={<Skeleton width={320} height={16} />}>
          <TodaySub />
        </Suspense>
      }
    >
      {economy ? (
        <Suspense fallback={<div className="v2-card h-[106px]" aria-busy="true" />}>
          <Band sp={sp} />
        </Suspense>
      ) : null}

      <div className="work">
        <div className="col">
          <Suspense fallback={<SkeletonCard rows={5} className="o-act" />}>
            <Actions canRoute={canRoute} nowIso={ctx.now} />
          </Suspense>
          {economy ? (
            <Suspense fallback={<SkeletonCard rows={4} className="o-live" />}>
              <Live nowIso={ctx.now} />
            </Suspense>
          ) : null}
        </div>
        <div className="col">
          <Suspense fallback={<SkeletonCard rows={5} className="o-rutt" />}>
            <Route canRoute={canRoute} />
          </Suspense>
          <Suspense fallback={<SkeletonCard rows={3} className="o-todo" />}>
            <Todo />
          </Suspense>
        </div>
      </div>

      <section className="x-an" aria-labelledby="hem-analys">
        <div className="x-hd">
          <h2 id="hem-analys">Analys{periodName ? <span> · {periodName}</span> : null}</h2>
          {economy ? <PeriodSegment className="aseg" /> : null}
          {economy ? (
            <Link className="lk text-v2-sm text-v2-mute" href="/pengar">
              Allt i Pengar →
            </Link>
          ) : null}
        </div>
        <div className="x-grid">
          {economy ? (
            <>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c x-res" />}>
                <ResultCard sp={sp} />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <WhenCardView sp={sp} />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <GeoCardView sp={sp} />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <TopCardView sp={sp} />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <WorstCardView />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <StockCardView />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <LossCardView sp={sp} />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={6} className="x-c" />}>
                <ShopsCardView sp={sp} />
              </Suspense>
              <Suspense fallback={<SkeletonCard rows={4} className="x-c" />}>
                <GoalCardView />
              </Suspense>
            </>
          ) : null}
          <Suspense fallback={<SkeletonCard rows={3} className="x-c x-ops" />}>
            <OpsCardView timeZone={ctx.timeZone} />
          </Suspense>
        </div>
      </section>
    </V2Page>
  );
}

async function TodaySub() {
  return <TodayLine today={await loadHemToday()} />;
}

async function Band({ sp }: { sp: SearchParams }) {
  const tiles = await loadKpiBand(sp);
  return tiles && tiles.length > 0 ? <HemKpiBand tiles={tiles} /> : null;
}

async function Actions({ canRoute, nowIso }: { canRoute: boolean; nowIso: string }) {
  const [today, route, fleet] = await Promise.all([
    loadHemToday(),
    loadDayRoute(),
    loadFleetState(),
  ]);
  const soon = fleet.machines
    .filter((m) => m.status === "tom-snart" && m.daysLeft !== null)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
    .slice(0, 3)
    .map((m) => ({ id: m.id, name: m.name, code: m.code, days: m.daysLeft ?? 0 }));
  return (
    <ActionsCard
      today={today}
      nowIso={nowIso}
      canRoute={canRoute}
      inRoute={route.stops.map((s) => s.machineId)}
      soon={soon}
    />
  );
}

async function Live({ nowIso }: { nowIso: string }) {
  const orders = await loadLiveOrders().catch((error: unknown) => {
    console.error("[hem] Senaste köp kunde inte läsas:", error);
    return null;
  });
  return orders ? <LiveCard orders={orders} nowIso={nowIso} /> : null;
}

async function Route({ canRoute }: { canRoute: boolean }) {
  return <RouteCard today={await loadHemToday()} canRoute={canRoute} />;
}

async function Todo() {
  return <TodoCard today={await loadHemToday()} />;
}
