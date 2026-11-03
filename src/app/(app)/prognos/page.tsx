import type { Metadata } from "next";

import Link from "next/link";
import type React from "react";
import { Suspense } from "react";

import { carriedQuery, type SearchParamsInput } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { DomainError } from "@/domain";
import { loadPeriod, requireRoute } from "@/server/data/core";
import { currentViewer, loadPrognosFor } from "@/server/purchasing";

import { AccuracyView } from "./_components/accuracy-view";
import { ForecastView } from "./_components/forecast-view";
import { LostSalesView } from "./_components/lost-sales-view";
import { OrdersView } from "./_components/orders-view";
import { PlanView } from "./_components/plan-view";
import { SuppliersView } from "./_components/suppliers-view";
import { ValuationView } from "./_components/valuation-view";
import { pickTab, ViewTabs } from "../automater/_components/view-tabs";
import { HashTab } from "./_components/hash-tab";
import { buildPageModel, type PageModel } from "./_lib/model";

export const metadata: Metadata = { title: "Prognos & inköp" };

const TABS = [
  { value: "bestall", label: "Beställ" },
  { value: "prognos", label: "Prognos" },
  { value: "forlorad", label: "Förlorad försäljning" },
  { value: "lager", label: "Lager och leverantörer" },
] as const;

/** Gamla #ankare → flik. Första värdet är standardfliken. */
const HASH_TO_TAB: Record<string, string> = {
  inkopsforslag: "bestall",
  inkopsorder: "bestall",
  prognos: "prognos",
  traffsakerhet: "prognos",
  "forlorad-forsaljning": "forlorad",
  lagervarde: "lager",
  leverantorer: "lager",
};

const SECTION = "flex scroll-mt-28 flex-col gap-10 md:gap-12";

/**
 * Prognos & inköp: vad slutsålt kostat, vad som säljer de kommande fyra veckorna (med
 * intervall och träffsäkerhet) och vad som ska beställas till centrallagret. Ägare, admin
 * och läsare; bara ägare och admin kan ändra inköpen. Påfyllaren skickas vidare.
 */
export default async function PrognosPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const ctx = await requireRoute("prognos");
  const sp = await searchParams;
  const p = await loadPeriod(sp);
  let m: PageModel;
  try {
    const data = await loadPrognosFor(await currentViewer(), { period: p.period, scope: p.scope });
    m = buildPageModel(data, new Date(ctx.now));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return (
      <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12">
        <StateMessage
          kind="loading-failed"
          message="Prognosen kunde inte räknas fram ur datan."
          detail={error.message}
          action={{ label: "Öppna Datakällor", href: "/datakallor" }}
          diagnostics={[{ label: "Kod", value: error.code }]}
        />
      </div>
    );
  }

  const raw =
    sp instanceof URLSearchParams || "get" in sp
      ? ((sp as { get(n: string): string | null }).get("vy") ?? undefined)
      : (sp as Record<string, string | string[] | undefined>).vy;
  const tab = pickTab(TABS, raw);
  const meta = m.scoped
    ? [...m.meta, { label: "Centrallager", value: "Hela organisationen" }]
    : m.meta;
  const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <Suspense fallback={null}>
        <HashTab map={HASH_TO_TAB} />
      </Suspense>
      <div className="rise flex flex-col gap-8">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Prognos & inköp"
          title={m.heading.title}
          aside={m.heading.aside}
          meta={meta}
        />
        <ViewTabs
          tabs={TABS}
          value={tab}
          basePath="/prognos"
          query={carriedQuery(sp)}
          label="Avsnitt"
        />
      </div>

      <div key={tab} className="flex flex-col gap-12 md:gap-16">
        {tab === "bestall" ? (
          <>
            <section aria-labelledby="inkopsforslag" className={`rise ${SECTION}`} style={rise(1)}>
              <SectionHeader
                id="inkopsforslag"
                eyebrow="Inköpsförslag · centrallagret"
                title={m.plan.heading.title}
                aside={m.plan.heading.aside}
              />
              <PlanView
                model={m.plan}
                suppliers={m.suppliers.suppliers}
                canEdit={m.canEdit}
                today={m.today}
              />
            </section>
            <section aria-labelledby="inkopsorder" className={`rise ${SECTION}`} style={rise(2)}>
              <SectionHeader
                id="inkopsorder"
                eyebrow="Inköpsorder"
                title={m.orders.heading.title}
                aside={m.orders.heading.aside}
              />
              <OrdersView
                model={m.orders}
                suppliers={m.suppliers.suppliers}
                canEdit={m.canEdit}
                today={m.today}
                hasCentralWarehouse={m.hasCentralWarehouse}
              />
            </section>
          </>
        ) : null}

        {tab === "prognos" ? (
          <>
            <section aria-labelledby="prognos" className={`rise ${SECTION}`} style={rise(1)}>
              <SectionHeader
                id="prognos"
                eyebrow="Prognos · kommande 4 veckor"
                title={m.forecast.heading.title}
                aside={m.forecast.heading.aside}
              />
              <ForecastView model={m.forecast} />
            </section>
            <details className={`rise rounded-sm border border-line p-4 md:p-6`} style={rise(2)}>
              <summary className="cursor-pointer text-sm font-medium text-fg">
                Träffsäkerhet · {m.accuracy.heading.title}
              </summary>
              <section aria-labelledby="traffsakerhet" className={`mt-6 ${SECTION}`}>
                <SectionHeader
                  id="traffsakerhet"
                  eyebrow="Träffsäkerhet · prövad bakåt"
                  title={m.accuracy.heading.title}
                  aside={m.accuracy.heading.aside}
                />
                <AccuracyView model={m.accuracy} />
              </section>
            </details>
          </>
        ) : null}

        {tab === "forlorad" ? (
          <section
            aria-labelledby="forlorad-forsaljning"
            className={`rise ${SECTION}`}
            style={rise(1)}
          >
            <SectionHeader
              id="forlorad-forsaljning"
              eyebrow={`Förlorad försäljning · ${m.lost.periodText}`}
              title={m.lost.heading.title}
              aside={m.lost.heading.aside}
            />
            <LostSalesView model={m.lost} />
          </section>
        ) : null}

        {tab === "lager" ? (
          <>
            <section aria-labelledby="lagervarde" className={`rise ${SECTION}`} style={rise(1)}>
              <SectionHeader
                id="lagervarde"
                eyebrow="Lagervärde och kapitalbindning"
                title={m.valuation.heading.title}
                aside={m.valuation.heading.aside}
              />
              <ValuationView model={m.valuation} />
            </section>
            <section aria-labelledby="leverantorer" className={`rise ${SECTION}`} style={rise(2)}>
              <SectionHeader
                id="leverantorer"
                eyebrow="Leverantörer"
                title={m.suppliers.heading.title}
                aside={m.suppliers.heading.aside}
                actions={
                  <Link
                    href="/inkopspriser"
                    className="meta inline-flex min-h-7 items-center rounded-xs text-muted hover:text-fg"
                  >
                    Inköpspriser{"\u00a0"}→
                  </Link>
                }
              />
              <SuppliersView model={m.suppliers} titles={m.titles} canEdit={m.canEdit} />
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
