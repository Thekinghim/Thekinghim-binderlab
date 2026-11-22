import type { Metadata } from "next";
import { Suspense } from "react";

import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatInt } from "@/lib/format";
import { requestStoreShareView, requireRoute, requireViewer } from "@/server/data/core";
import { loadValueFor } from "@/server/varde/load";

import { ActionList, Fold, MonthPicker, ValueCards, ValueTable } from "./_components/sections";
import { buildValueView, monthLabel } from "./_lib/view";

export const metadata: Metadata = { title: "Värde" };

type SearchParams = Record<string, string | string[] | undefined>;

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
  const [ctx, sp] = await Promise.all([requireRoute("varde"), searchParams]);
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
    <V2Page title="Värde" date={headerDate(new Date(ctx.now), ctx.timeZone)}>
      <SubNav />
      <div className={PAGE_BODY}>
        <PageIntro
          title={view.headline.title}
          aside={view.headline.aside}
          facts={[{ label: "Månad", value: view.monthLabel }]}
          actions={
            data.hasData ? (
              <ButtonLink href={`/rapport/varde?manad=${data.month}`} touch>
                Månadsrapport
              </ButtonLink>
            ) : undefined
          }
        >
          <MonthPicker
            months={data.months.map((m) => ({ month: m, label: shortLabel(m) }))}
            selected={data.month}
            label={monthLabel}
          />
        </PageIntro>

        <ValueCards cards={view.cards} />

        <div className="v2-stack">
          <Card
            title="Bästa åtgärder"
            count={view.actions.length > 0 ? view.actions.length : undefined}
          >
            <ActionList actions={view.actions} />
          </Card>

          <Card title="Mer siffror" as="section">
            <Fold
              id="utveckling"
              title="Utveckling"
              meta={`${formatInt(view.trend.rows.length)} mån`}
            >
              <ValueTable
                {...view.trend}
                caption="Utveckling per månad"
                empty="Ingen försäljning än."
              />
              {view.trend.rows.some((r) => r.cells[0]?.endsWith("*")) ? (
                <p className="mt-2 px-[18px] text-v2-xs text-v2-mute">* Månaden pågår.</p>
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
              <div className="px-[18px] pb-3">
                <Suspense fallback={null}>
                  <StoreShareToggle on={showStoreShare} />
                </Suspense>
              </div>
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
              <ul className="flex max-w-[72ch] list-disc flex-col gap-2 pr-[18px] pl-9 text-v2-sm text-v2-mute">
                {view.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Fold>
          </Card>
        </div>
      </div>
    </V2Page>
  );
}
