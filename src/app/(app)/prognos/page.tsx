import type { Metadata } from "next";

import Link from "next/link";
import type React from "react";
import { Suspense } from "react";

import { redirect } from "next/navigation";

import { type SearchParamsInput } from "@/components/shell/period-state";
import { HashTab } from "@/components/ui/hash-tab";
import { OpenOnHash } from "@/components/ui/open-on-hash";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
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
import { ourStockTitle } from "./_lib/our-stock";
import { PlanView } from "./_components/plan-view";
import { SuppliersView } from "./_components/suppliers-view";
import { ValuationView } from "./_components/valuation-view";
import { PageHead } from "../vart-lager/_components/page-head";
import { packHref } from "../vart-lager/mystery/_lib/model";
import { TodoList } from "../vart-lager/_components/todo-list";
import { buildPageModel, type PageModel } from "./_lib/model";
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

const SECTION = "flex scroll-mt-28 flex-col gap-8";
/** "Mer"-raderna. Mobil: platta rader med linje under (inga kort), 44 px höga. */
const MORE =
  "group scroll-mt-28 rounded-sm border border-line [&>summary]:flex [&>summary]:cursor-pointer [&>summary]:items-baseline [&>summary]:justify-between [&>summary]:gap-4 [&>summary]:px-4 [&>summary]:py-3 max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:[&>summary]:min-h-11 max-md:[&>summary]:items-center max-md:[&>summary]:px-0 max-md:[&>summary]:flex-wrap max-md:[&>summary]:gap-x-3 max-md:[&>summary]:py-2 max-md:[&>div]:px-0";

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
  try {
    const viewer = await currentViewer();
    const [data, our] = await Promise.all([
      loadPrognosFor(viewer, { period: p.period, scope: p.scope }),
      loadOurStockFor(viewer, new Date(ctx.now)),
    ]);
    // Packa och Beställ X st: inköpsplanens antal (purchaseQty), samma som Vårt lager.
    // Räcker: samma regel och takt som Vårt lager (hemma + i automaterna, 14 dagars takt).
    const stockPace = new Map(our.rows.map((r) => [r.titleId, r.perDayTenths] as const));
    m = buildPageModel(data, new Date(ctx.now), { stockPace });
    stock = our;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return (
      <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12">
        <StateMessage
          kind="loading-failed"
          message="Prognosen kunde inte räknas fram."
          detail={error.message}
          action={{ label: "Öppna Datakällor", href: "/datakallor" }}
          diagnostics={[{ label: "Kod", value: error.code }]}
        />
      </div>
    );
  }

  const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;
  // Öppna inköpsorder står i huvudvyn; utan öppna ligger listan under "Mer".
  const ordersMain = m.orders.open.length > 0;
  const orders = (
    <OrdersView
      model={m.orders}
      suppliers={m.suppliers.suppliers}
      canEdit={m.canEdit}
      today={m.today}
      hasCentralWarehouse={m.hasCentralWarehouse}
    />
  );
  const forecastMeta = m.meta.filter(
    (x) => x.label !== "Att beställa" && x.label !== "Kapitalbindning",
  );

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-14 md:px-8 md:pt-12">
      <Suspense fallback={null}>
        <HashTab map={HASH_TO_TAB} defaultTab="bestall" />
      </Suspense>

      {tab === "bestall" ? (
        <div key="bestall" className="fade-in flex flex-col gap-12 max-md:gap-8 md:gap-14">
          <PageHead
            eyebrow={m.scoped ? "Inköp · hela organisationen" : "Inköp"}
            title={m.plan.heading.title}
            aside={m.plan.heading.aside}
          />

          {m.plan.packLines.length > 0 ? (
            <section id="att-packa" aria-labelledby="att-packa-rubrik" className={SECTION}>
              <h2 id="att-packa-rubrik" className="label text-subtle">
                Att packa
              </h2>
              <TodoList
                label="Att packa"
                done=""
                max={12}
                items={m.plan.packLines.map((l) => ({
                  key: l.titleId,
                  verb: "Packa",
                  title: l.title,
                  qty: l.packQty,
                  tone: l.late ? "critical" : "warning",
                  // Packa öppnar Mystery packs med antalet förvalt (omgångar).
                  href: packHref(l.titleId, l.packQty),
                }))}
              />
            </section>
          ) : null}

          <section aria-labelledby="inkopsforslag" className={`rise ${SECTION}`} style={rise(2)}>
            <h2 id="inkopsforslag" className="label text-subtle">
              Att beställa
            </h2>
            <PlanView
              model={m.plan}
              suppliers={m.suppliers.suppliers}
              canEdit={m.canEdit}
              today={m.today}
            />
          </section>

          {ordersMain ? (
            <section aria-labelledby="inkopsorder" className={`rise ${SECTION}`} style={rise(3)}>
              <SectionHeader
                id="inkopsorder"
                size="md"
                eyebrow="Inköpsorder"
                title={m.orders.heading.title}
              />
              {orders}
            </section>
          ) : null}

          <div className="rise flex flex-col gap-3 max-md:gap-0" style={rise(4)}>
            <p className="label text-subtle max-md:border-b max-md:border-line max-md:pb-2">Mer</p>
            {!ordersMain ? (
              <details id="inkopsorder" className={MORE}>
                <summary>
                  <span className="text-sm font-medium text-fg">Inköpsorder</span>
                  <span className="meta text-muted">{m.orders.heading.title}</span>
                </summary>
                <div className="border-t border-line p-4">{orders}</div>
              </details>
            ) : null}
            <details id="vart-lager" className={MORE}>
              <summary>
                <span className="text-sm font-medium text-fg">Lager per titel</span>
                <span className="meta text-muted">
                  {ourStockTitle(stock.rows, stock.places.length)}
                </span>
              </summary>
              <div className="flex flex-col gap-4 border-t border-line p-4">
                <OurStock
                  rows={stock.rows}
                  titles={stock.titles}
                  timeZone={stock.timeZone}
                  now={stock.now}
                  windowDays={stock.windowDays}
                  // Flera lager: antalet räknas per lager på Vårt lager (här vore det oklart vilket).
                  canRegister={stock.canRegister && stock.places.length <= 1}
                />
                <Link href="/vart-lager" className="meta w-fit text-muted hover:text-fg max-md:tap">
                  Vårt lager{"\u00a0"}→
                </Link>
              </div>
            </details>
            <details id="leverantorer" className={MORE}>
              <summary>
                <span className="text-sm font-medium text-fg">Leverantörer</span>
                <span className="meta text-muted">{m.suppliers.heading.title}</span>
              </summary>
              <div className="flex flex-col gap-4 border-t border-line p-4">
                <p className="text-sm text-muted">{m.suppliers.heading.aside}</p>
                <SuppliersView model={m.suppliers} titles={m.titles} canEdit={m.canEdit} />
                <Link
                  href="/inkopspriser"
                  className="meta w-fit text-muted hover:text-fg max-md:tap"
                >
                  Inköpspriser{"\u00a0"}→
                </Link>
              </div>
            </details>
            <details id="lagervarde" className={MORE}>
              <summary>
                <span className="text-sm font-medium text-fg">Lagervärde</span>
                <span className="meta text-muted">{m.valuation.heading.title}</span>
              </summary>
              <div className="border-t border-line p-4">
                <ValuationView model={m.valuation} />
              </div>
            </details>
            <OpenOnHash id="inkopsorder" />
            <OpenOnHash id="vart-lager" />
            <OpenOnHash id="leverantorer" />
            <OpenOnHash id="lagervarde" />
          </div>
        </div>
      ) : (
        <div key="prognos" className="fade-in flex flex-col gap-12 max-md:gap-8 md:gap-14">
          <PageHead eyebrow="Prognos · 4 veckor" title={m.heading.title} aside={m.heading.aside} />
          <section aria-labelledby="prognos" className={`rise ${SECTION}`} style={rise(1)}>
            <h2 id="prognos" className="sr-only">
              Prognos
            </h2>
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              {forecastMeta.map((x) => (
                <div key={x.label} className="flex flex-col">
                  <dt className="label text-subtle">{x.label}</dt>
                  <dd className="tnum text-base text-fg">{x.value}</dd>
                </div>
              ))}
            </dl>
            <ForecastView model={m.forecast} />
          </section>

          <div className="rise flex flex-col gap-3 max-md:gap-0" style={rise(2)}>
            <p className="label text-subtle max-md:border-b max-md:border-line max-md:pb-2">Mer</p>
            <details id="forlorad-forsaljning" className={MORE}>
              <summary>
                <span className="text-sm font-medium text-fg">Förlorad försäljning</span>
                <span className="meta text-muted">{m.lost.heading.title}</span>
              </summary>
              <div className="flex flex-col gap-6 border-t border-line p-4">
                <p className="text-sm text-muted">{m.lost.periodText}</p>
                <LostSalesView model={m.lost} />
              </div>
            </details>
            <details id="traffsakerhet" className={MORE}>
              <summary>
                <span className="text-sm font-medium text-fg">Träffsäkerhet</span>
                <span className="meta text-muted">{m.accuracy.heading.title}</span>
              </summary>
              <div className="flex flex-col gap-6 border-t border-line p-4">
                <p className="text-sm text-muted">{m.accuracy.heading.aside}</p>
                <AccuracyView model={m.accuracy} />
              </div>
            </details>
            <OpenOnHash id="forlorad-forsaljning" />
            <OpenOnHash id="traffsakerhet" />
          </div>
        </div>
      )}
    </div>
  );
}
