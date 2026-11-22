import type { Metadata } from "next";
import { Suspense } from "react";

import { routeById } from "@/components/shell/nav";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatInt, formatPeriod } from "@/lib/format";
import { isUuid } from "@/server/access";
import { loadPeriod, requireRoute } from "@/server/data/core";

import "../drift/_components/ops.css";
import { HistoryList } from "./_components/history-list";
import { WarehouseRedirect } from "./_components/warehouse-redirect";
import { LagerBoard } from "./_components/lager-board";
import { loadLagerFor } from "./_lib/data";
import { isoDateToDate } from "./_lib/display";
import { headlineOf } from "./_lib/headline";
import { currentViewer } from "./_lib/session";
import { HISTORY_LIMIT } from "./_lib/types";

export const metadata: Metadata = { title: "Lager" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Lager: det som finns i automaterna. Matrisen titel × automat (antal kvar, dagar kvar,
 * status; saldot från Awish när automaten är kopplad), påfyllningslistan per automat
 * inför ett besök och historiken. Vårt eget lager har en egen flik
 * (/vart-lager); gamla länkar hit (#centrallager, ?vy=centrallager) skickas dit. Alla roller ser sidan;
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
  const placesTotal = view.counts.critical + view.counts.low + view.counts.ok + view.unknownCount;

  return (
    <V2Page
      title="Lager"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      sub={
        <>
          <b>{headline.title}</b>
          {headline.aside ? <span>{headline.aside}</span> : null}
          <span className="max-[900px]:hidden">
            {`${formatInt(placesTotal)} platser`}
            {view.unknownCount > 0 ? ` · saldo okänt ${formatInt(view.unknownCount)}` : ""}
          </span>
        </>
      }
      tools={
        view.unknownCount > 0 && routeById("datakallor").roles.includes(ctx.role) ? (
          <ButtonLink href="/datakallor" touch>
            Koppla Awish
          </ButtonLink>
        ) : undefined
      }
    >
      {routeById("vart-lager").roles.includes(ctx.role) ? (
        <Suspense fallback={null}>
          <WarehouseRedirect />
        </Suspense>
      ) : null}
      <SubNav />
      <div className="v2-stack">
        <LagerBoard view={view} focus={focus} />

        <Card
          title={<span id="historik">Historik</span>}
          count={view.historyTotal}
          actions={
            <span className="text-v2-xs text-v2-mute">
              {periodText}
              {view.historyTotal > HISTORY_LIMIT ? ` · ${formatInt(HISTORY_LIMIT)} senaste` : ""}
            </span>
          }
        >
          <details className="ops-more group">
            <summary className="w-full px-[18px] py-2 max-[900px]:px-4">
              <span className="group-open:hidden">Visa historiken</span>
              <span className="hidden group-open:inline">Dölj historiken</span>
            </summary>
            <div className="border-t border-v2-line2">
              <HistoryList
                entries={view.history}
                timeZone={view.timeZone}
                now={view.now}
                periodText={periodText}
              />
            </div>
          </details>
        </Card>
      </div>
    </V2Page>
  );
}
