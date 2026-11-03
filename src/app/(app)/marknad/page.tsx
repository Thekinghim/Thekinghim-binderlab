import type { Metadata } from "next";

import { MerHead } from "@/app/(app)/installningar/_components/mer-head";

import { pickView, ViewTabs } from "../rapporter/_components/view-tabs";
import { minDate } from "@/domain";
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

const VIEWS = ["releaser", "priser", "sortiment"] as const;

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
  for (const key of ["period", "from", "to", "vy"]) {
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
    data.machines.map((m) => {
      const changes = data.assortmentChanges.filter((c) => c.machineId === m.id);
      return [
        m.id,
        {
          current: slotLinesOn(data, m.id, data.today),
          prefill: slotPrefill(data, m.id, model.assortment.period),
          lockedThrough: changes.reduce<string | null>(
            (max, c) => (max === null || c.implementedOn > max ? c.implementedOn : max),
            null,
          ),
          starts: [
            ...new Set(data.slots.filter((x) => x.machineId === m.id).map((x) => x.validFrom)),
          ].sort(),
        },
      ];
    }),
  );

  const view = pickView(sp.vy, VIEWS);
  const hrefFor = (v: (typeof VIEWS)[number]) => {
    const q = new URLSearchParams(query);
    q.delete("pristitel");
    if (v === "releaser") q.delete("vy");
    else q.set("vy", v);
    const qs = q.toString();
    return qs ? `/marknad?${qs}` : "/marknad";
  };
  const upcoming = model.releases.filter((r) => r.status === "upcoming").length;
  const machinesWithSlots = model.assortment.machines.ok
    ? model.assortment.machines.value.length
    : 0;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <div className="rise flex flex-col gap-6" style={{ "--i": 0 } as React.CSSProperties}>
        <MerHead
          eyebrow={`Marknad · ${periodLabel(period)}`}
          title={model.headline.title}
          line={model.headline.aside}
        />
        <ViewTabs
          label="Vy"
          value={view}
          hrefFor={hrefFor}
          tabs={[
            { value: "releaser", label: "Releaser", count: upcoming },
            { value: "priser", label: "Priser", count: data.quotes.length },
            { value: "sortiment", label: "Sortiment", count: machinesWithSlots },
          ]}
        />
      </div>

      <div className="rise flex flex-col gap-12" style={{ "--i": 1 } as React.CSSProperties}>
        {view === "releaser" ? <ReleasesSection releases={model.releases} ctx={ctx} /> : null}
        {view === "priser" ? (
          <>
            <PricesSection
              prices={model.prices}
              source={source}
              selectedTitleId={first(sp.pristitel)}
              period={period}
              ctx={ctx}
            />
            <PricingSection pricing={model.pricing} period={period} ctx={ctx} />
          </>
        ) : null}
        {view === "sortiment" ? (
          <AssortmentSection
            assortment={model.assortment}
            slots={slots}
            ctx={ctx}
            capacity={SLOTS_PER_MACHINE}
          />
        ) : null}
      </div>
    </div>
  );
}
