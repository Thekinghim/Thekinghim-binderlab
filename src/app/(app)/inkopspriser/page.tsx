import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import type React from "react";
import Link from "next/link";

import { describePeriod, toURLSearchParams, wallClockIn } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { priceHistory, profitability, titleEconomics, type PurchasePrice } from "@/domain";
import { formatDate, formatInt } from "@/lib/format";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { PriceForm } from "./_components/price-form";
import { PriceHistory } from "./_components/price-history";
import { PriceLog } from "./_components/price-log";
import { ScrollIntoView } from "./_components/scroll-into-view";
import { TitleTable } from "./_components/title-table";
import { loadPricePageFor, loadTitleDetailFor } from "./_lib/data";
import {
  PRICE_EDITOR_ID,
  pageHeadline,
  perTitleAside,
  priceLog,
  priceTimeline,
  signalTitleIds,
  titleHeadline,
  titleRows,
} from "./_lib/model";

export const metadata: Metadata = { title: "Inköpspriser" };

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

/**
 * Inköpspriser: vad varje titel kostar, vad den lämnar per order och om den går med
 * förlust, med prishistorik, nytt pris (ägare och admin) och ändringslogg per titel.
 * Ägare, admin och läsare (requireRoute skickar påfyllare till sin startsida). Siffrorna
 * räknas i @/domain (titleEconomics, profitability, priceHistory, priceChangeImpact).
 */
export default async function PurchasePricesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("inkopspriser");
  const sp = await searchParams;
  const [period, user] = await Promise.all([loadPeriod(sp), requireUser()]);
  const [input, data] = await Promise.all([
    loadDomainInput({ period: period.period, ...period.scope }),
    loadPricePageFor(user, ctx.organization.id),
  ]);

  const today = ctx.today;
  const periodLabel = describePeriod(period.resolved).rangeLabel;
  const activeTitleIds = input.titles.filter((t) => !t.archived).map((t) => t.id);
  const economics = titleEconomics({ ...input.current, titleIds: activeTitleIds });
  const unpriced = profitability(input.current, "title").unpriced;
  const allRows = titleRows(economics, input.titles, unpriced.byTitle);
  const onlyMissing = one(sp.saknar) === "pris";
  const rows = onlyMissing
    ? allRows.filter((r) => r.status === "missing" || r.unpricedOrders > 0)
    : allRows;
  const dates = { asOf: input.current.period.end, today: ctx.today };
  const headline = pageHeadline(allRows, dates);
  const signalIds = signalTitleIds(rows);

  const requested = one(sp.titel);
  const selectedRow =
    allRows.find((r) => r.id === requested) ??
    allRows.find((r) => r.id === signalIds[0]) ??
    rows[0] ??
    null;
  const selectedTitle = selectedRow
    ? (input.titles.find((t) => t.id === selectedRow.id) ?? null)
    : null;

  const baseParams = toURLSearchParams(sp);
  baseParams.delete("titel");
  const baseQuery = baseParams.toString();
  const allParams = new URLSearchParams(baseParams);
  allParams.delete("saknar");
  const showAllHref = `/inkopspriser${allParams.size > 0 ? `?${allParams.toString()}` : ""}`;

  const pricedCount = allRows.filter((r) => r.currentCostOre !== null).length;

  const detail = selectedTitle
    ? await loadTitleDetailFor(user, ctx.organization.id, selectedTitle.id)
    : null;
  const titlePrices = selectedTitle
    ? data.prices.filter((p) => p.titleId === selectedTitle.id)
    : [];
  const domainPrices: PurchasePrice[] = titlePrices.map((p) => ({
    titleId: p.titleId,
    unitCostOre: p.unitCostOre,
    validFrom: p.validFrom,
  }));
  const timeline =
    selectedTitle && detail
      ? priceTimeline(
          priceHistory(domainPrices, selectedTitle.id),
          detail.orderDays,
          today,
          new Map(titlePrices.map((p) => [p.validFrom, p.note])),
        )
      : [];
  const log = detail ? priceLog(detail.events, data.actorNames) : [];
  const titleHead = selectedTitle ? titleHeadline(selectedRow, selectedTitle.name, today) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="rise">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Inköpspriser"
          title={headline.title}
          aside={headline.aside}
          meta={[
            { label: "Period", value: periodLabel },
            {
              label: "Med inköpspris",
              value: `${formatInt(pricedCount)} av ${formatInt(allRows.length)}`,
            },
            {
              label: "Senaste prisändring",
              value: data.lastChangeAt
                ? formatDate(wallClockIn(new Date(data.lastChangeAt), ctx.timeZone), {
                    year: "auto",
                    now: wallClockIn(new Date(ctx.now), ctx.timeZone),
                  })
                : "Aldrig",
            },
          ]}
        />
        <AiPageLine metric="marginalen per titel" route="inkopspriser" className="mt-4" />
      </div>

      <section
        aria-labelledby="per-titel"
        className="rise flex flex-col gap-6"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <SectionHeader
          id="per-titel"
          eyebrow={`Per titel · ${periodLabel}`}
          title="Vad varje pack lämnar."
          aside={perTitleAside(rows, dates)}
          actions={
            onlyMissing ? (
              <Link
                href={showAllHref}
                className="meta rounded-xs text-muted underline underline-offset-4 hover:text-fg"
              >
                Visa alla titlar
              </Link>
            ) : null
          }
        />
        {rows.length === 0 ? (
          <StateMessage
            kind="empty"
            message={
              onlyMissing
                ? "Alla titlar har inköpspris."
                : "Inga titlar ännu. Titlar skapas när order importeras."
            }
            action={
              onlyMissing
                ? { label: "Visa alla titlar →", href: showAllHref }
                : { label: "Importera order →", href: "/datakallor" }
            }
          />
        ) : (
          <TitleTable
            rows={rows}
            selectedId={selectedRow?.id ?? null}
            baseQuery={baseQuery}
            today={today}
            periodLabel={periodLabel}
            criticalIds={signalIds}
          />
        )}
      </section>

      {selectedTitle && titleHead ? (
        <section
          id={PRICE_EDITOR_ID}
          aria-labelledby="titel-rubrik"
          tabIndex={-1}
          className="fade-in flex scroll-mt-28 flex-col gap-10 border-t border-line pt-12 outline-none md:scroll-mt-44"
        >
          <ScrollIntoView
            targetId={PRICE_EDITOR_ID}
            titleId={selectedTitle.id}
            active={requested !== null}
          />
          <SectionHeader
            id="titel-rubrik"
            eyebrow={`Titel${selectedTitle.series ? ` · ${selectedTitle.series}` : ""}`}
            title={titleHead.title}
            aside={titleHead.aside}
          />

          <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
            {/* Redigeraren först: ett klick på en titel rullar hit och sätter markören i priset. */}
            <div className="flex min-w-0 flex-col gap-6 lg:col-span-5">
              <h3 className="label text-subtle">Ändra inköpspris</h3>
              {ctx.canEdit && detail ? (
                <PriceForm
                  key={selectedTitle.id}
                  titleId={selectedTitle.id}
                  titleName={selectedTitle.name}
                  prices={titlePrices.map((p) => ({
                    unitCostOre: p.unitCostOre,
                    validFrom: p.validFrom,
                  }))}
                  orderDays={detail.orderDays}
                  closedMonths={data.closedMonths}
                  today={today}
                />
              ) : (
                <StateMessage kind="denied" compact message="Gäller från datumet." />
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-6 lg:col-span-7">
              <h3 className="label text-subtle">Prishistorik</h3>
              {timeline.length === 0 ? (
                <StateMessage
                  kind="not-configured"
                  compact
                  message={`${selectedTitle.name} har inget inköpspris. Order av titeln räknas inte in i vinsten.`}
                />
              ) : (
                <PriceHistory entries={timeline} today={today} />
              )}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <h3 className="label text-subtle">Ändringslogg</h3>
            {log.length === 0 ? (
              <StateMessage
                kind="empty"
                compact
                message={`Inga ändringar av inköpspriset för ${selectedTitle.name}.`}
              />
            ) : (
              <PriceLog
                entries={log}
                timeZone={ctx.timeZone}
                now={ctx.now}
                today={today}
                titleName={selectedTitle.name}
              />
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
