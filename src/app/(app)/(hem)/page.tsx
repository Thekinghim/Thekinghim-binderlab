import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  isSingleDay,
  periodDaysText,
  periodNameInline,
  periodQuery,
} from "@/components/shell/period-state";
import { simpleHomeFor } from "@/components/shell/simple-view";
import { DaySalesCard } from "@/components/v2/day-sales";
import { PeriodSegment } from "@/components/v2/period-segment";
import { SafeSuspense } from "@/components/v2/safe-suspense";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { Skeleton, SkeletonCard } from "@/components/v2/skeleton";
import { messages } from "@/i18n";
import {
  loadContext,
  loadOptionalContextIfSignedIn,
  loadPeriod,
  requireRoute,
  requireViewer,
} from "@/server/data/core";
import { loadDaySales } from "@/server/data/v2/analytics/day-sales";
import { loadLiveOrders } from "@/server/data/v2/analytics/live";
import { loadFleetState } from "@/server/data/v2/fleet";
import { loadDayRoute } from "@/server/data/v2/route";
import { isDemoFor } from "@/server/demo/guard";
import { pushStatus } from "@/server/notify/push";
import { loadAwishFreshnessFor } from "@/server/monitoring/watch";
import { loadSalePushPref } from "@/server/sales-push/prefs";
import { withUserDb } from "@/server/session";

import { AwishOrdersBanner } from "../_vakt/data-age-line";
import { BriefButton } from "../_hem/brief/button";
import { SalesScreen } from "../forsaljning/_components/sales-screen";
import { SplitCard } from "../pengar/_components/split-card";
import {
  GeoCardView,
  LossCardView,
  OpsCardView,
  ResultCard,
  ShopsCardView,
  StockCardView,
  TopCardView,
  WhenCardView,
  WorstCardView,
} from "../_hem/v2/analytics";
import { HemHero } from "../_hem/v2/hero-card";
import { HemHeroSkeleton } from "../_hem/v2/hero-skeleton";
import { ActionsCard, LiveCard, RouteCard, TodayLine, TodoCard } from "../_hem/v2/today";
import { SalePrompt } from "../_hem/v2/sale-prompt";
import { loadHemToday } from "../_hem/v2/today-data";

import "../_hem/v2/hem.css";

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
 * Hem i V2 (docs/design/v2/byggplan.md 2.2, prototypen #hem): dagens rad, hjältekortet, "Vem
 * pengarna är till" (bara ägare och admin, direkt under hjältekortet), Kräver
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
  // Alla roller väljer period: påfyllaren ser vad som såldes (bara antal), ekonomirollerna
  // dessutom KPI-bandet och analysen för perioden.
  const p = await loadPeriod(sp);
  const periodName = economy ? periodNameInline(p.resolved) : null;
  // "Vad sålde vi i går": en enskild dag (I går, I dag, ett eget datum) får en lista per titel
  // och automat direkt under bandet. Påfyllaren får listan för alla perioder (bara antal),
  // under det som är att göra.
  const soldTop = economy && isSingleDay(p.resolved);

  return (
    <V2Page
      title="Hem"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period
      tools={<BriefButton />}
      className="hem2"
      sub={
        <SafeSuspense fallback={<Skeleton width="min(320px, 85%)" height={16} />}>
          <TodaySub />
        </SafeSuspense>
      }
    >
      {/* Försäljningen har inte hämtats på 30 min (Awish svarar inte): orderlistan i
          Datakällor är reserven. Bara ägare och admin; ingenting när allt fungerar. */}
      <SafeSuspense fallback={null}>
        <AwishOrdersBanner className="mb-3" />
      </SafeSuspense>

      {/* Hjältekortet (visuellt/02): vinst, pallen och månadens mål, nyckeltalen kompakt under
          (ersätter KPI-bandet; _hem/v2/hero-card.tsx). Bara ekonomiroller. */}
      {economy ? (
        <SafeSuspense fallback={<HemHeroSkeleton />}>
          <HemHero sp={sp} />
        </SafeSuspense>
      ) : null}

      {/* "Vem pengarna är till" (Min andel, partnern, butikernas bolag): högt upp, direkt under
          hjältekortet, för vald period. Bara ägare och admin (canEdit; laddaren kontrollerar
          rollen igen). Eget Suspense, så att avräkningarna per månad aldrig håller upp
          hjältekortet. Samma kort som på Pengar. */}
      {economy && ctx.canEdit ? (
        <div className="o-split">
          <SafeSuspense fallback={<SkeletonCard rows={6} />}>
            <SplitCard sp={sp} days={periodDaysText(p.resolved, p.days)} />
          </SafeSuspense>
        </div>
      ) : null}

      {soldTop ? (
        <SafeSuspense fallback={<SkeletonCard rows={6} className="o-sold" />}>
          <Sold sp={sp} economy={economy} />
        </SafeSuspense>
      ) : null}

      <div className="work">
        <div className="col">
          <SafeSuspense fallback={<SkeletonCard rows={5} className="o-act" />}>
            <Actions canRoute={canRoute} nowIso={ctx.now} />
          </SafeSuspense>
          {/* Påfyllaren (utan ekonomi) har ingen analys: Driftstatus bor då under Kräver åtgärd,
              så att den inte blir ett ensamt kort i en egen sektion och lämnar ett hål här. */}
          {!economy ? (
            <SafeSuspense fallback={<SkeletonCard rows={3} className="x-c x-ops" />}>
              <OpsCardView timeZone={ctx.timeZone} />
            </SafeSuspense>
          ) : null}
          {economy ? (
            <SafeSuspense fallback={<SkeletonCard rows={4} className="o-live" />}>
              <Live nowIso={ctx.now} />
            </SafeSuspense>
          ) : null}
          {/* Resultat bor i vänsterkolumnen (under Senaste köp), så att den inte lämnar ett hål
              bredvid Att göra. Under 1240 px ligger den efter Senaste köp (hem.css). */}
          {economy ? (
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c x-res" />}>
              <ResultCard sp={sp} />
            </SafeSuspense>
          ) : null}
          {/* "Få notis vid varje försäljning": sist i kolumnen (inte bråttom), så att rutan inte
              flyttar korten ovanför när den dyker upp. */}
          {ctx.role === "owner" ? (
            <SafeSuspense fallback={null}>
              <SalePromptSlot />
            </SafeSuspense>
          ) : null}
        </div>
        <div className="col">
          <SafeSuspense fallback={<SkeletonCard rows={5} className="o-rutt" />}>
            <Route canRoute={canRoute} />
          </SafeSuspense>
          <SafeSuspense fallback={<SkeletonCard rows={3} className="o-todo" />}>
            <Todo />
          </SafeSuspense>
        </div>
      </div>

      {!economy ? (
        <SafeSuspense fallback={<SkeletonCard rows={6} className="o-sold" />}>
          <Sold sp={sp} economy={economy} />
        </SafeSuspense>
      ) : null}

      {economy ? (
        <section className="x-an" aria-labelledby="hem-analys">
          <div className="x-hd">
            <h2 id="hem-analys">Analys{periodName ? <span> · {periodName}</span> : null}</h2>
            <PeriodSegment className="aseg" />
            <Link prefetch={false} className="lk text-v2-sm text-v2-mute" href="/pengar">
              Allt i Pengar →
            </Link>
          </div>
          <div className="x-grid">
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <WhenCardView sp={sp} />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <GeoCardView sp={sp} />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <TopCardView sp={sp} />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <WorstCardView />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <StockCardView />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <LossCardView sp={sp} />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={6} className="x-c" />}>
              <ShopsCardView sp={sp} />
            </SafeSuspense>
            <SafeSuspense fallback={<SkeletonCard rows={3} className="x-c x-ops" />}>
              <OpsCardView timeZone={ctx.timeZone} />
            </SafeSuspense>
          </div>
        </section>
      ) : null}
    </V2Page>
  );
}

async function Sold({ sp, economy }: { sp: SearchParams; economy: boolean }) {
  const v = await loadDaySales(sp).catch((error: unknown) => {
    console.error("[hem] Försäljningen för perioden kunde inte läsas:", error);
    return null;
  });
  if (!v) return null;
  return (
    <DaySalesCard
      sales={v.sales}
      title={v.singleDay ? `Sålt ${v.inline}` : `Sålt · ${v.inline}`}
      inline={v.inline}
      link={economy ? { href: `/pengar${periodQuery(sp)}`, label: "Pengar" } : undefined}
      className="v2-ds o-sold"
    />
  );
}

/**
 * "Få notis vid varje försäljning" för ägaren som inte har den på (och inte i en demo, där
 * skickas inget). Ett fel här döljer bara rutan.
 */
async function SalePromptSlot() {
  const props = await salePromptProps().catch((error: unknown) => {
    console.error("[hem] Notisrutan kunde inte läsas:", error);
    return null;
  });
  return props ? <SalePrompt {...props} /> : null;
}

async function salePromptProps(): Promise<{ publicKey: string; hasDevice: boolean } | null> {
  const ctx = await loadContext();
  const push = await pushStatus();
  if (!push.configured || !push.publicKey) return null;
  const user = { userId: ctx.user.id, email: ctx.user.email };
  if (await isDemoFor(user, ctx.organization.id)) return null;
  const pref = await withUserDb((tx) => loadSalePushPref(tx, ctx.organization.id, ctx.user.id));
  if (pref.on && pref.endpoints.length > 0) return null;
  return { publicKey: push.publicKey, hasDevice: pref.endpoints.length > 0 };
}

async function TodaySub() {
  return <TodayLine today={await loadHemToday()} />;
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
  const [orders, fresh] = await Promise.all([
    loadLiveOrders().catch((error: unknown) => {
      console.error("[hem] Senaste köp kunde inte läsas:", error);
      return null;
    }),
    // Riktig ålder i stället för "ungefär var 5:e minut" (null vid fel: raden blir neutral).
    requireViewer()
      .then((viewer) => loadAwishFreshnessFor(viewer))
      .catch(() => null),
  ]);
  return orders ? <LiveCard orders={orders} nowIso={nowIso} freshness={fresh?.text} /> : null;
}

async function Route({ canRoute }: { canRoute: boolean }) {
  return <RouteCard today={await loadHemToday()} canRoute={canRoute} />;
}

async function Todo() {
  return <TodoCard today={await loadHemToday()} />;
}
