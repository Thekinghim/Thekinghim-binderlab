import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type CSSProperties } from "react";

import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { SectionHeader } from "@/components/ui/section-header";
import { formatInt } from "@/lib/format";
import { requestStoreShareView, requireRoute, requireViewer } from "@/server/data/core";
import { loadValueFor } from "@/server/varde/load";

import { ActionList, Fold, MonthPicker, ValueCards, ValueTable } from "./_components/sections";
import { buildValueView, monthLabel } from "./_lib/view";

export const metadata: Metadata = { title: "Värde" };

type SearchParams = Record<string, string | string[] | undefined>;

function rise(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

/**
 * Vad Binderlab gett dig: för en månad (?manad=ÅÅÅÅ-MM, standard förra månaden) visas
 * räddad försäljning (påfyllning i tid), sparad tid, kvar efter inköp och försäljning, och
 * de tre bästa åtgärderna. Utveckling, per automat, per butik och antagandena ligger
 * hopfällda under. Månadsrapporten (/rapport/varde) är samma siffror som A4.
 *
 * Bara ägare och admin (requireRoute; loadValueFor kontrollerar rollen igen mot databasen).
 * Allt läses med RLS för den aktiva organisationen. Regler: docs/berakningar.md, avsnitt 27.
 */
export default async function VardePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [, sp] = await Promise.all([requireRoute("varde"), searchParams]);
  const manad = typeof sp.manad === "string" ? sp.manad : null;
  const [data, showStoreShare] = await Promise.all([
    requireViewer().then((viewer) => loadValueFor(viewer, manad)),
    requestStoreShareView(),
  ]);
  const view = buildValueView(data, { showStoreShare });
  const shortLabel = (m: string) => {
    const l = monthLabel(m);
    return `${l.slice(0, 3)} ${m.slice(2, 4)}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 pt-6 pb-16 md:gap-12 md:px-8 md:pt-12">
      <div className="rise flex flex-col gap-5" style={rise(0)}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Värde · ${view.monthLabel}`}
          title={view.headline.title}
          aside={view.headline.aside}
          actions={
            data.hasData ? (
              <Link
                href={`/rapport/varde?manad=${data.month}`}
                className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover max-md:min-h-11"
              >
                Månadsrapport
              </Link>
            ) : undefined
          }
        />
        <MonthPicker
          months={data.months.map((m) => ({ month: m, label: shortLabel(m) }))}
          selected={data.month}
          label={monthLabel}
        />
      </div>

      <ValueCards cards={view.cards} />

      <section aria-labelledby="atgarder" className="rise flex flex-col gap-4" style={rise(5)}>
        <SectionHeader
          id="atgarder"
          size="md"
          title="Bästa åtgärder."
          aside={
            view.actions.length > 0
              ? `${formatInt(view.actions.length)} saker som ger mest.`
              : undefined
          }
        />
        <ActionList actions={view.actions} />
      </section>

      <section aria-label="Mer siffror" className="rise flex flex-col" style={rise(6)}>
        <Fold id="utveckling" title="Utveckling" meta={`${formatInt(view.trend.rows.length)} mån`}>
          <ValueTable
            {...view.trend}
            caption="Utveckling per månad"
            empty="Ingen försäljning än."
          />
          {view.trend.rows.some((r) => r.cells[0]?.endsWith("*")) ? (
            <p className="meta mt-2 text-subtle">* Månaden pågår.</p>
          ) : null}
        </Fold>
        <Fold id="automater" title="Per automat" meta={formatInt(view.machines.rows.length)}>
          <ValueTable
            {...view.machines}
            caption={`Per automat, ${view.monthLabel}`}
            empty="Ingen försäljning i månaden."
          />
        </Fold>
        <Fold id="butiker" title="Per butik" meta={formatInt(view.stores.rows.length)}>
          {/* Butikens andel och vår del per butik visas med knappen (som övriga sidor). */}
          <Suspense fallback={null}>
            <StoreShareToggle on={showStoreShare} className="mb-4" />
          </Suspense>
          <ValueTable
            {...view.stores}
            caption={`Per butik, ${view.monthLabel}`}
            empty="Ingen försäljning i månaden."
          />
        </Fold>
        <Fold id="tid" title="Tid sparad" meta={view.cards.find((c) => c.id === "time")?.value}>
          <ValueTable {...view.time} caption="Sparad tid per uppgift" empty="Inget ännu." />
        </Fold>
        <Fold id="sa-raknas-det" title="Så räknas det">
          <ul className="flex max-w-[72ch] list-disc flex-col gap-2 pl-5 text-sm text-muted">
            {view.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Fold>
      </section>
    </div>
  );
}
