import type { Metadata } from "next";

import type { SearchParamsInput } from "@/components/shell/period-state";
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
import { buildPageModel, type PageModel } from "./_lib/model";

export const metadata: Metadata = { title: "Prognos & inköp" };

const SECTIONS = [
  { id: "forlorad-forsaljning", label: "Förlorad försäljning" },
  { id: "prognos", label: "Prognos" },
  { id: "traffsakerhet", label: "Träffsäkerhet" },
  { id: "inkopsforslag", label: "Inköpsförslag" },
  { id: "inkopsorder", label: "Inköpsorder" },
  { id: "lagervarde", label: "Lagervärde" },
  { id: "leverantorer", label: "Leverantörer" },
] as const;

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
  const p = await loadPeriod(await searchParams);
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

  const scopeNote = m.scoped ? " Gäller hela organisationen: centrallagret är gemensamt." : "";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-8">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Prognos & inköp"
          title={m.heading.title}
          aside={m.heading.aside}
          meta={m.meta}
        />
        <nav aria-label="Avsnitt" className="-mx-1 flex flex-wrap gap-x-1 gap-y-1">
          {SECTIONS.map((s, i) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="label flex h-7 items-center gap-1.5 rounded-xs px-1 text-subtle transition-colors hover:text-fg"
            >
              <span className="tnum text-fg">{String(i + 1).padStart(2, "0")}</span>
              <span aria-hidden className="text-faint">
                /
              </span>
              {s.label}
            </a>
          ))}
        </nav>
      </div>

      <section
        aria-labelledby="forlorad-forsaljning"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="forlorad-forsaljning"
          index={1}
          eyebrow={`Förlorad försäljning · ${m.lost.periodText}`}
          title={m.lost.heading.title}
          aside={m.lost.heading.aside}
        />
        <LostSalesView model={m.lost} />
      </section>

      <section
        aria-labelledby="prognos"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="prognos"
          index={2}
          eyebrow="Prognos · kommande 4 veckor"
          title={m.forecast.heading.title}
          aside={m.forecast.heading.aside}
        />
        <ForecastView model={m.forecast} />
      </section>

      <section
        aria-labelledby="traffsakerhet"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="traffsakerhet"
          index={3}
          eyebrow="Träffsäkerhet · backtest"
          title={m.accuracy.heading.title}
          aside={m.accuracy.heading.aside}
        />
        <AccuracyView model={m.accuracy} />
      </section>

      <section
        aria-labelledby="inkopsforslag"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="inkopsforslag"
          index={4}
          eyebrow="Inköpsförslag · centrallagret"
          title={m.plan.heading.title}
          aside={`${m.plan.heading.aside}${scopeNote}`}
        />
        <PlanView
          model={m.plan}
          suppliers={m.suppliers.suppliers}
          canEdit={m.canEdit}
          today={m.today}
        />
      </section>

      <section
        aria-labelledby="inkopsorder"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="inkopsorder"
          index={5}
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

      <section
        aria-labelledby="lagervarde"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="lagervarde"
          index={6}
          eyebrow="Lagervärde och kapitalbindning"
          title={m.valuation.heading.title}
          aside={`${m.valuation.heading.aside}${scopeNote}`}
        />
        <ValuationView model={m.valuation} />
      </section>

      <section
        aria-labelledby="leverantorer"
        className="flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 md:gap-12"
      >
        <SectionHeader
          id="leverantorer"
          index={7}
          eyebrow="Leverantörer"
          title={m.suppliers.heading.title}
          aside={m.suppliers.heading.aside}
        />
        <SuppliersView model={m.suppliers} titles={m.titles} canEdit={m.canEdit} />
      </section>
    </div>
  );
}
