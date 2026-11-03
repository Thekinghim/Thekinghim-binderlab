import type { Metadata } from "next";

import type React from "react";

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
  const placesTotal = view.counts.critical + view.counts.low + view.counts.ok;
  const warehouseTotal = view.warehouse.reduce((s, w) => s + Math.max(0, w.onHand), 0);

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Lager"
          title={headline.title}
          aside={headline.aside}
          meta={[
            { label: "Platser", value: formatInt(placesTotal) },
            ...(view.hasWarehouse ? [{ label: "Centrallager", value: packs(warehouseTotal) }] : []),
          ]}
        />
      </div>

      <LagerBoard view={view} focus={focus} />

      <details
        className="group rise rounded-sm border border-line"
        style={{ "--i": 4 } as React.CSSProperties}
      >
        <summary className="flex cursor-pointer items-baseline justify-between gap-4 px-4 py-3 text-sm font-medium">
          <h2 id="historik">Historik ({formatInt(view.historyTotal)})</h2>
          <span className="text-xs text-muted">
            {periodText}
            {view.historyTotal > HISTORY_LIMIT ? ` · ${formatInt(HISTORY_LIMIT)} senaste` : ""}
          </span>
        </summary>
        <div className="border-t border-line p-4">
          <HistoryList
            entries={view.history}
            timeZone={view.timeZone}
            now={view.now}
            periodText={periodText}
          />
        </div>
      </details>
    </div>
  );
}
