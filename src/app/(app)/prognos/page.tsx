import type { Metadata } from "next";

import Link from "next/link";
import { Suspense } from "react";

import { redirect } from "next/navigation";

import { type SearchParamsInput } from "@/components/shell/period-state";
import { HashTab } from "@/components/ui/hash-tab";
import { OpenOnHash } from "@/components/ui/open-on-hash";
import { ButtonLink } from "@/components/v2/button";
import { CardBody } from "@/components/v2/card";
import { KpiTile } from "@/components/v2/kpi-tile";
import { Notice } from "@/components/v2/notice";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { DomainError } from "@/domain";
import { messages } from "@/i18n";
import { loadOptionalContextIfSignedIn, loadPeriod, requireRoute } from "@/server/data/core";
import { currentViewer, loadPrognosFor } from "@/server/purchasing";

import { SimpleBuyListScreen } from "../_enkel/buy-list-screen";
import { AccuracyView } from "./_components/accuracy-view";
import { ForecastView } from "./_components/forecast-view";
import { LostSalesView } from "./_components/lost-sales-view";
import { OrdersView } from "./_components/orders-view";
import { OurStock } from "./_components/our-stock";
import { PackRows } from "./_components/pack-rows";
import "../drift/_components/ops.css";
import { ourStockTitle } from "./_lib/our-stock";
import { OnTheWayList } from "./_components/buy-actions";
import { PlanView } from "./_components/plan-view";
import { SuppliersView } from "./_components/suppliers-view";
import { ValuationView } from "./_components/valuation-view";
import { packActionHref } from "../vart-lager/mystery/_lib/model";
import { buildPageModel, ordersInMainView, type PageModel } from "./_lib/model";
import { loadOurStockFor, type OurStockView } from "../lager/_lib/data";

/** Inköp och prognos; i Enkel vy Inköpslistan på personens språk. */
export async function generateMetadata(): Promise<Metadata> {
  const ctx = await loadOptionalContextIfSignedIn().catch(() => null);
  if (ctx?.viewMode === "simple") return { title: messages(ctx.locale).stock.buyTitle };
  return { title: "Inköp och prognos" };
}

/** Vyerna: Inköp (standard) och Prognos, båda underflikar i menyn. */
type Tab = "bestall" | "prognos";

/** Gamla #ankare → vy. Avsnitten under "Mer" öppnas av OpenOnHash. */
const HASH_TO_TAB: Record<string, Tab> = {
  "vart-lager": "bestall",
  centrallager: "bestall",
  "att-packa": "bestall",
  inkopsforslag: "bestall",
  inkopsorder: "bestall",
  lagervarde: "bestall",
  leverantorer: "bestall",
  prognos: "prognos",
  traffsakerhet: "prognos",
  "forlorad-forsaljning": "prognos",
};

/** Gamla vyer (?vy=forlorad, ?vy=lager) ligger nu under "Mer" i Prognos respektive Inköp. */
const OLD_VIEWS: Record<string, { tab: Tab; hash: string }> = {
  forlorad: { tab: "prognos", hash: "forlorad-forsaljning" },
  lager: { tab: "bestall", hash: "leverantorer" },
};

function viewParam(sp: SearchParamsInput): string | undefined {
  return sp instanceof URLSearchParams || "get" in sp
    ? ((sp as { get(n: string): string | null }).get("vy") ?? undefined)
    : ((v) => (Array.isArray(v) ? v[0] : v))(
        (sp as Record<string, string | string[] | undefined>).vy,
      );
}

/**
 * Inköp och Prognos (två underflikar under Vårt lager). Inköp: vad som ska packas (egna
 * produkter) och beställas, inköpsorder, och under "Mer" lager, leverantörer och värde.
 * Prognos: vad som säljer de kommande fyra veckorna, och under "Mer" träffsäkerhet och
 * förlorad försäljning. Ägare, admin och läsare; bara ägare och admin ändrar inköpen.
 */
export default async function PrognosPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const ctx = await requireRoute("prognos");
  // Enkel vy: bara inköpslistan (vad som ska köpas och hur mycket), ingen prognos.
  if (ctx.viewMode === "simple") return <SimpleBuyListScreen ctx={ctx} />;
  const sp = await searchParams;
  const raw = viewParam(sp);
  const old = raw ? OLD_VIEWS[raw] : undefined;
  if (old) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp as Record<string, string | string[] | undefined>)) {
      if (k === "vy" || v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
    }
    if (old.tab !== "bestall") q.set("vy", old.tab);
    const qs = q.toString();
    redirect(`/prognos${qs ? `?${qs}` : ""}#${old.hash}`);
  }
  const tab: Tab = raw === "prognos" ? "prognos" : "bestall";

  const p = await loadPeriod(sp);
  let m: PageModel;
  let stock: OurStockView;
  let buyScope: string;
  try {
    const viewer = await currentViewer();
    buyScope = `${viewer.organization.id}:${viewer.user.userId}`;
    const [data, our] = await Promise.all([
      loadPrognosFor(viewer, { period: p.period, scope: p.scope }),
      loadOurStockFor(viewer, new Date(ctx.now)),
    ]);
    // Packa och Beställ X st: inköpsplanens antal (purchaseQty), samma som Vårt lager.
    // Räcker: samma regel och takt som Vårt lager (hemma + i automaterna, 14 dagars takt).
    const stockPace = new Map(our.rows.map((r) => [r.titleId, r.perDayTenths] as const));
    // Pack hemma som de är (även under 0): planen räknar under 0 som 0, men en titel under 0
    // ska räknas om först, precis som på Vårt lager.
    const stockHome = new Map<string, number>();
    for (const place of Object.values(our.byPlace)) {
      for (const [titleId, n] of Object.entries(place)) {
        stockHome.set(titleId, (stockHome.get(titleId) ?? 0) + n);
      }
    }
    const stockSlotDays = new Map(
      our.rows.map((r) => [r.titleId, r.machinesDaysLeft ?? null] as const),
    );
    m = buildPageModel(data, new Date(ctx.now), { stockPace, stockHome, stockSlotDays });
    stock = our;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return (
      <V2Page title={tab === "prognos" ? "Prognos" : "Inköp"}>
        <SubNav />
        <Notice
          tone="critical"
          title="Prognosen kunde inte räknas fram."
          action={
            <ButtonLink href="/datakallor" size="sm" touch>
              Öppna Datakällor
            </ButtonLink>
          }
        >
          {`${error.message} (kod ${error.code})`}
        </Notice>
      </V2Page>
    );
  }

  // Hela ordertabellen ligger under "Mer". Det som är beställt står redan i huvudvyn som
  // "På väg" med "Kom fram"; bara ett utkast (som måste beställas eller tas bort) lyfter upp den.
  const ordersMain = ordersInMainView(m.orders.open);
  const orders = (
    <OrdersView
      model={m.orders}
      suppliers={m.suppliers.suppliers}
      canEdit={m.canEdit}
      today={m.today}
      hasCentralWarehouse={m.hasCentralWarehouse}
    />
  );
  const buyPlaces = stock.places.map((pl) => ({ id: pl.id, name: pl.name }));
  const forecastMeta = m.meta.filter(
    (x) => x.label !== "Att beställa" && x.label !== "Kapitalbindning",
  );

  const head = tab === "prognos" ? m.heading : m.plan.heading;

  return (
    <V2Page
      title={tab === "prognos" ? "Prognos" : "Inköp"}
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period={tab === "prognos"}
      sub={
        <>
          <b>{head.title}</b>
          {head.aside ? <span>{head.aside}</span> : null}
          {tab === "bestall" && m.scoped ? <span>Hela organisationen</span> : null}
        </>
      }
    >
      <Suspense fallback={null}>
        <HashTab map={HASH_TO_TAB} defaultTab="bestall" />
      </Suspense>
      <SubNav />

      {tab === "bestall" ? (
        <div key="bestall" className="v2-stack">
          {m.plan.packLines.length > 0 ? (
            <section
              id="att-packa"
              aria-labelledby="att-packa-rubrik"
              className="v2-card scroll-mt-28"
            >
              <div className="v2-card-hd">
                <h2 id="att-packa-rubrik">
                  Att packa
                  <span aria-hidden="true">·</span>
                  <span className="n">{m.plan.packLines.length}</span>
                </h2>
              </div>
              <PackRows
                items={m.plan.packLines.map((l) => ({
                  key: l.titleId,
                  // Under 0 hemma: räkna om först (samma två steg som på Vårt lager).
                  verb: l.negative ? "Räkna om" : "Packa",
                  title: l.title,
                  // Mystery packs i hela omgångar, samma tal som Vårt lager.
                  qty: l.negative ? null : (l.action?.qty ?? l.packQty),
                  unit: l.action?.unit ?? "st",
                  note: l.steps,
                  fact: l.fact,
                  tone: l.negative || l.late || l.home <= 0 ? "critical" : "warning",
                  // Räkna om görs på Vårt lager (raden); Packa öppnar Mystery packs med
                  // antalet förvalt.
                  href: l.negative
                    ? `/vart-lager#rad-${l.titleId}`
                    : packActionHref(l.titleId, l.action?.packs ?? l.packQty, l.action?.placeId),
                }))}
              />
            </section>
          ) : null}

          {/* Beställt och på väg (även delägarens rader): "Kom fram" när packen kommit. */}
          <OnTheWayList
            items={m.plan.onTheWay}
            today={m.today}
            canEdit={m.canEdit && m.hasCentralWarehouse}
            places={buyPlaces}
            scope={buyScope}
            v2
          />

          <section aria-labelledby="inkopsforslag" className="v2-card scroll-mt-28">
            <div className="v2-card-hd">
              <h2 id="inkopsforslag">Att beställa</h2>
            </div>
            <CardBody>
              <PlanView
                model={m.plan}
                suppliers={m.suppliers.suppliers}
                canEdit={m.canEdit}
                today={m.today}
                places={buyPlaces}
                scope={buyScope}
              />
            </CardBody>
          </section>

          {ordersMain ? (
            <section aria-labelledby="inkopsorder" className="v2-card scroll-mt-28">
              <div className="v2-card-hd">
                <h2 id="inkopsorder">Inköpsorder</h2>
                <span className="text-v2-xs text-v2-mute">{m.orders.heading.title}</span>
              </div>
              <CardBody>{orders}</CardBody>
            </section>
          ) : null}

          <section aria-label="Mer" className="v2-card">
            <div className="v2-card-hd">
              <h2>Mer</h2>
            </div>
            {!ordersMain ? (
              <details id="inkopsorder" className="ops-acc">
                <summary>
                  <span>Inköpsorder</span>
                  <small>{m.orders.heading.title}</small>
                </summary>
                <div>{orders}</div>
              </details>
            ) : null}
            <details id="vart-lager" className="ops-acc">
              <summary>
                <span>Lager per titel</span>
                <small>{ourStockTitle(stock.rows, stock.places.length)}</small>
              </summary>
              <div className="flex flex-col gap-4">
                <OurStock
                  rows={stock.rows}
                  titles={stock.titles}
                  timeZone={stock.timeZone}
                  now={stock.now}
                  windowDays={stock.windowDays}
                  // Flera lager: antalet räknas per lager på Vårt lager (här vore det oklart vilket).
                  canRegister={stock.canRegister && stock.places.length <= 1}
                />
                <Link href="/vart-lager" className="ops-link w-fit">
                  Vårt lager{"\u00a0"}→
                </Link>
              </div>
            </details>
            <details id="leverantorer" className="ops-acc">
              <summary>
                <span>Leverantörer</span>
                <small>{m.suppliers.heading.title}</small>
              </summary>
              <div className="flex flex-col gap-4">
                <p className="ops-p">{m.suppliers.heading.aside}</p>
                <SuppliersView model={m.suppliers} titles={m.titles} canEdit={m.canEdit} />
                <Link href="/inkopspriser" className="ops-link w-fit">
                  Inköpspriser{"\u00a0"}→
                </Link>
              </div>
            </details>
            <details id="lagervarde" className="ops-acc">
              <summary>
                <span>Lagervärde</span>
                <small>{m.valuation.heading.title}</small>
              </summary>
              <div>
                <ValuationView model={m.valuation} />
              </div>
            </details>
            <OpenOnHash id="inkopsorder" />
            <OpenOnHash id="vart-lager" />
            <OpenOnHash id="leverantorer" />
            <OpenOnHash id="lagervarde" />
          </section>
        </div>
      ) : (
        <div key="prognos" className="v2-stack">
          <section aria-labelledby="prognos" className="v2-stack scroll-mt-28">
            <h2 id="prognos" className="sr-only">
              Prognos
            </h2>
            {forecastMeta.length > 0 ? (
              <div className="v2-band">
                {forecastMeta.map((x) => (
                  <KpiTile key={x.label} label={x.label} value={x.value} />
                ))}
              </div>
            ) : null}
            <ForecastView model={m.forecast} />
          </section>

          <section aria-label="Mer" className="v2-card">
            <div className="v2-card-hd">
              <h2>Mer</h2>
            </div>
            <details id="forlorad-forsaljning" className="ops-acc">
              <summary>
                <span>Förlorad försäljning</span>
                <small>{m.lost.heading.title}</small>
              </summary>
              <div className="flex flex-col gap-4">
                <p className="ops-p">{m.lost.periodText}</p>
                <LostSalesView model={m.lost} />
              </div>
            </details>
            <details id="traffsakerhet" className="ops-acc">
              <summary>
                <span>Träffsäkerhet</span>
                <small>{m.accuracy.heading.title}</small>
              </summary>
              <div className="flex flex-col gap-4">
                <p className="ops-p">{m.accuracy.heading.aside}</p>
                <AccuracyView model={m.accuracy} />
              </div>
            </details>
            <OpenOnHash id="forlorad-forsaljning" />
            <OpenOnHash id="traffsakerhet" />
          </section>
        </div>
      )}
    </V2Page>
  );
}
