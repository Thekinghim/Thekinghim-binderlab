import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { formatInt, formatPeriod } from "@/lib/format";
import { isUuid } from "@/server/access";
import { loadPeriod, requireRoute } from "@/server/data/core";

import { HistoryList } from "./_components/history-list";
import { LagerBoard } from "./_components/lager-board";
import { loadLagerFor } from "./_lib/data";
import { isoDateToDate, packs } from "./_lib/display";
import { headlineOf } from "./_lib/headline";
import { currentViewer } from "./_lib/session";
import { HISTORY_LIMIT } from "./_lib/types";

export const metadata: Metadata = { title: "Lager" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Lager: matrisen titel × automat (antal kvar, dagar kvar, status), påfyllningslistan
 * per automat inför ett besök, centrallagret och historiken. Alla roller ser sidan;
 * ägare, admin och påfyllare registrerar påfyllning och inventering. Inga belopp
 * visas eller skickas till klienten, för någon roll.
 */
export default async function LagerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireRoute("lager");
  const sp = await searchParams;
  const p = await loadPeriod(sp);
  const view = await loadLagerFor(
    await currentViewer(),
    { period: p.period, scope: p.scope },
    new Date(ctx.now),
  );
  const headline = headlineOf(view);

  const machineParam = first(sp.automat);
  const titleParam = first(sp.titel);
  const focus =
    isUuid(machineParam) && isUuid(titleParam)
      ? { machineId: machineParam, titleId: titleParam }
      : null;

  const periodText = formatPeriod({
    start: isoDateToDate(p.period.start),
    end: isoDateToDate(p.period.end),
  });
  const packsToday = view.packLists.reduce((s, l) => s + l.totalPacks, 0);

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Lager"
        title={headline.title}
        aside={headline.aside}
        meta={[
          { label: "Kritisk", value: formatInt(view.counts.critical) },
          { label: "Låg", value: formatInt(view.counts.low) },
          { label: "OK", value: formatInt(view.counts.ok) },
          { label: "Ut i dag", value: packs(packsToday) },
        ]}
      />

      <LagerBoard view={view} focus={focus} />

      <section aria-labelledby="historik" className="flex flex-col gap-6 md:gap-10">
        <SectionHeader
          id="historik"
          index={view.hasWarehouse ? 4 : 3}
          eyebrow="Historik"
          title="Vem, när och hur mycket."
          aside={
            view.historyTotal === 0
              ? `Inget registrerat, ${periodText}.`
              : `${formatInt(view.historyTotal)} ${view.historyTotal === 1 ? "händelse" : "händelser"}, ${periodText}${view.historyTotal > HISTORY_LIMIT ? `, de ${formatInt(HISTORY_LIMIT)} senaste visas` : ""}.`
          }
        />
        <HistoryList
          entries={view.history}
          timeZone={view.timeZone}
          now={view.now}
          periodText={periodText}
        />
      </section>
    </div>
  );
}
