import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";

import { MachineKpis } from "./_components/kpis";
import { AddMachineButton } from "./_components/machine-dialogs";
import { MachineTable } from "./_components/machine-table";
import { UnpricedNote } from "./_components/unpriced-note";
import { loadOverview } from "./_lib/data";
import { nextMachineCode, overviewKpis, spreadText } from "./_lib/model";

export const metadata: Metadata = { title: "Automater" };

/**
 * Automater: alla automater med periodens intäkt, vinst, status, butik och lager.
 * Ägare, admin och läsare (påfyllaren skickas vidare av requireRoute). Ägare och admin
 * lägger till automater här; redigering, flytt och avveckling görs på automatens sida.
 */
export default async function AutomaterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const data = await loadOverview(await searchParams);
  const { ctx, overview, period } = data;
  const { totals, rows, headline } = overview;
  const active = rows.filter((r) => r.lifecycle === "active");
  const decommissioned = rows.filter((r) => r.lifecycle === "decommissioned").length;
  const planned = rows.filter((r) => r.lifecycle === "planned").length;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const daysLabel = `${formatInt(period.span.days)}${NBSP}d`;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={data.scopeLabel ? `Automater · ${data.scopeLabel}` : "Automater"}
        title={headline.title}
        aside={headline.aside}
        meta={[
          { label: "Period", value: period.rangeLabel },
          { label: "I drift", value: formatInt(totals.activeMachines) },
          ...(planned > 0 ? [{ label: "Planerade", value: formatInt(planned) }] : []),
          ...(decommissioned > 0
            ? [{ label: "Avvecklade", value: formatInt(decommissioned) }]
            : []),
          { label: "Kräver åtgärd", value: formatInt(overview.flagged) },
        ]}
        actions={
          ctx.canEdit ? (
            <AddMachineButton
              stores={data.stores}
              today={ctx.today}
              suggestedCode={nextMachineCode(rows.map((r) => r.code))}
            />
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Det finns inga automater i organisationen ännu."
          detail={
            ctx.canEdit
              ? "Lägg till den första med knappen ovan. Order från Awish kopplas till den under Datakällor."
              : "Ägare och admin lägger till automater."
          }
        />
      ) : (
        <>
          {period.pendingToday ? (
            <StateMessage
              kind="empty"
              message="Inga order har kommit in i dag ännu."
              detail="Intäkt och vinst för i dag visas när dagens order har importerats. Välj I går eller 7 dagar i periodraden för en hel period."
            />
          ) : active.length > 0 || totals.orders > 0 ? (
            <div className="flex flex-col gap-4">
              <MachineKpis
                items={overviewKpis(totals)}
                label={`Nyckeltal · ${daysLabel}`}
                comparison={comparison}
              />
              {overview.unpriced ? (
                <UnpricedNote unpriced={overview.unpriced} canEdit={ctx.canEdit} />
              ) : null}
            </div>
          ) : null}

          <section aria-labelledby="alla-automater" className="flex flex-col gap-6">
            <SectionHeader
              id="alla-automater"
              index={1}
              eyebrow={`Per automat · ${daysLabel}`}
              title={
                active.length === 0
                  ? "Ingen automat i drift."
                  : `${formatInt(active.length)} ${active.length === 1 ? "automat" : "automater"} i drift.`
              }
              aside={spreadText(rows)}
            />
            <MachineTable
              rows={rows}
              others={overview.others}
              totals={rows.length > 1 || overview.others.length > 0 ? totals : null}
              pending={period.pendingToday}
              timeZone={ctx.timeZone}
              now={ctx.now}
              caption={`Automater, intäkt och vinst ${period.rangeLabel}`}
            />
          </section>
        </>
      )}
    </div>
  );
}
