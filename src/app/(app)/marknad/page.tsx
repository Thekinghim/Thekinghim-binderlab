import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { minDate } from "@/domain";
import { formatInt } from "@/lib/format";
import { loadPeriod, requireRoute } from "@/server/data/core";
import { loadMarket, loadMarketReferences } from "@/server/market";
import { periodLabel } from "@/server/market/display";
import {
  buildMarketModel,
  slotLinesOn,
  slotPrefill,
  SLOTS_PER_MACHINE,
} from "@/server/market/model";
import { MARKET_SOURCE_CANDIDATES } from "@/server/market/sources";

import { AssortmentSection, type SlotInfo } from "./_components/assortment-section";
import type { EvidenceNames } from "./_components/evidence";
import { PricesSection, type MarketSourceView } from "./_components/prices-section";
import { PricingSection } from "./_components/pricing-section";
import { ReleasesSection } from "./_components/releases-section";
import type { SectionContext } from "./_lib/context";

export const metadata: Metadata = { title: "Marknad" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

const SECTIONS = [
  { id: "releaser", label: "Releaser" },
  { id: "priser", label: "Priser" },
  { id: "sortiment", label: "Sortiment" },
  { id: "prissattning", label: "Prissättning" },
] as const;

/**
 * Marknad (fas 11): releasekalender med förslag och utfall, leverantörspriser över tid
 * med avvikande inköp, sortiment per automat med väntad effekt och uppföljning, och
 * prisändringar med effekt och förslag på pristester. Ägare, admin och läsare; bara
 * ägare och admin ändrar. Varje rekommendation har sitt underlag utfällbart.
 */
export default async function MarknadPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireRoute("marknad");
  const sp = await searchParams;
  const [appPeriod, data] = await Promise.all([loadPeriod(sp), loadMarket()]);
  const period = {
    start: minDate(appPeriod.period.start, data.today),
    end: minDate(appPeriod.period.end, data.today),
  };
  const model = buildMarketModel(data, period);

  const trendIds = model.prices.trends.ok ? model.prices.trends.value.map((t) => t.titleId) : [];
  const refs = await loadMarketReferences(data, trendIds);
  const source: MarketSourceView = {
    kind: refs.status.kind,
    reason: refs.status.kind === "ready" ? null : refs.status.reason,
    sourceName: refs.status.kind === "ready" ? refs.status.source.name : null,
    candidates: MARKET_SOURCE_CANDIDATES.map((c) => c.name),
    latest: Object.fromEntries(
      [...refs.prices.entries()].flatMap(([titleId, points]) => {
        const last = points[points.length - 1];
        return last
          ? [
              [
                titleId,
                {
                  priceMinor: last.priceMinor,
                  currency: last.currency,
                  observedOn: last.observedOn,
                  productName: last.productName,
                },
              ],
            ]
          : [];
      }),
    ),
    error: refs.error,
  };

  const names: EvidenceNames = {
    today: data.today,
    title: Object.fromEntries(data.titles.map((t) => [t.id, t.name])),
    machine: Object.fromEntries(data.machines.map((m) => [m.id, m.code])),
    supplier: Object.fromEntries(data.suppliers.map((s) => [s.id, s.name])),
    purchases: Object.fromEntries(
      model.prices.purchases.map((p) => [
        p.id,
        {
          origin: p.origin,
          supplierId: p.supplierId,
          date: p.date,
          unitCostOre: p.unitCostOre,
          quantity: p.quantity,
        },
      ]),
    ),
  };
  const query: Record<string, string> = {};
  for (const key of ["period", "from", "to"]) {
    const v = first(sp[key]);
    if (v) query[key] = v;
  }
  const ctx: SectionContext = {
    today: data.today,
    canEdit: data.canEdit,
    names,
    titleOptions: data.titles
      .filter((t) => !t.archived && !t.mergedIntoId)
      .map((t) => ({ value: t.id, label: t.name }))
      .sort((a, b) => a.label.localeCompare(b.label, "sv")),
    supplierOptions: data.suppliers
      .filter((s) => !s.archived)
      .map((s) => ({ value: s.id, label: s.name })),
    supplierItems: Object.fromEntries(
      data.supplierItems.map((i) => [
        `${i.supplierId}:${i.titleId}`,
        { packSize: i.packSize, minOrderQty: i.minOrderQty },
      ]),
    ),
    query,
  };
  const slots: SlotInfo = Object.fromEntries(
    data.machines.map((m) => [
      m.id,
      {
        current: slotLinesOn(data, m.id, data.today),
        prefill: slotPrefill(data, m.id, period),
      },
    ]),
  );

  const upcoming = model.releases.filter((r) => r.status === "upcoming").length;
  const machinesWithSlots = model.assortment.machines.ok ? model.assortment.machines.value.length : 0;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-6">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Marknad · ${periodLabel(period)}`}
          title={model.headline.title}
          aside={model.headline.aside}
          meta={[
            { label: "Kommande släpp", value: formatInt(upcoming) },
            { label: "Registrerade priser", value: formatInt(data.quotes.length) },
            { label: "Automater med fack", value: formatInt(machinesWithSlots) },
            { label: "Pristester", value: formatInt(data.experiments.length) },
          ]}
        />
        <nav aria-label="Sektioner på sidan" className="flex flex-wrap gap-x-6 gap-y-2">
          {SECTIONS.map((s, i) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="label rounded-xs text-subtle hover:text-fg"
            >
              <span className="tnum text-fg">{String(i + 1).padStart(2, "0")}</span>
              <span aria-hidden className="mx-1.5 text-faint">
                /
              </span>
              {s.label}
            </a>
          ))}
        </nav>
      </div>

      <ReleasesSection releases={model.releases} ctx={ctx} />
      <PricesSection
        prices={model.prices}
        source={source}
        selectedTitleId={first(sp.pristitel)}
        period={period}
        ctx={ctx}
      />
      <AssortmentSection
        assortment={model.assortment}
        slots={slots}
        ctx={ctx}
        capacity={SLOTS_PER_MACHINE}
      />
      <PricingSection pricing={model.pricing} period={period} ctx={ctx} />
    </div>
  );
}
