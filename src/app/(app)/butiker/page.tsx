import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";

import { StoreKpis } from "./_components/kpis";
import { AddStoreButton } from "./_components/store-dialogs";
import { StoreTable } from "./_components/store-table";
import { loadStoreList, periodQuery } from "./_lib/data";
import { plural, sek } from "./_lib/model";

export const metadata: Metadata = { title: "Butiker" };

/**
 * Butiker: alla butiker med periodens intäkt, butiksersättning, ersättningsmodell och
 * vad butiken tjänat hittills i månaden. Ägare, admin och läsare (påfyllaren skickas
 * vidare av requireRoute). Ägare och admin lägger till butiker här; avtal, kontakt och
 * rapportmottagare ändras på butikens sida.
 */
export default async function ButikerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadStoreList(sp);
  const { ctx, rows, period, headline } = data;
  const active = rows.filter((r) => !r.archived);
  const archived = rows.length - active.length;
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const earned = active.reduce((n, r) => n + r.earnedMonthOre, 0);
  const withAgreement = active.filter((r) => r.current !== null).length;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={data.scopeLabel ? `Butiker · ${data.scopeLabel}` : "Butiker"}
        title={headline.title}
        aside={headline.aside}
        meta={[
          { label: "Period", value: period.rangeLabel },
          { label: "Butiker", value: formatInt(active.length) },
          ...(data.examples > 0 ? [{ label: "Exempel", value: formatInt(data.examples) }] : []),
          ...(archived > 0 ? [{ label: "Arkiverade", value: formatInt(archived) }] : []),
          { label: "Kräver åtgärd", value: formatInt(data.flagged) },
        ]}
        actions={ctx.canEdit ? <AddStoreButton query={periodQuery(sp)} /> : undefined}
      />

      {rows.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Det finns inga butiker i organisationen ännu."
          detail={
            ctx.canEdit
              ? "Lägg till den första butiken. Automater placeras i butiker under Automater."
              : "Ägare och admin lägger till butiker."
          }
        />
      ) : (
        <>
          <StoreKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />

          <section aria-labelledby="alla-butiker" className="flex flex-col gap-6">
            <SectionHeader
              id="alla-butiker"
              index={1}
              eyebrow={`Per butik · ${days}`}
              title={`${sek(earned)} intjänat av butikerna hittills i ${data.monthLabel}.`}
              aside={
                withAgreement === active.length
                  ? `${plural(withAgreement, "butik", "butiker")} med gällande avtal.`
                  : `${formatInt(withAgreement)} av ${plural(active.length, "butik", "butiker")} har gällande avtal.`
              }
            />
            <StoreTable
              rows={rows}
              monthLabel={data.monthLabel}
              caption={`Butiker, intäkt och ersättning ${period.rangeLabel}`}
            />
          </section>
        </>
      )}
    </div>
  );
}
