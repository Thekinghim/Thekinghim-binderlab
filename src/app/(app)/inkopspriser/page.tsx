import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import type React from "react";
import { Suspense } from "react";
import Link from "next/link";

import { describePeriod, toURLSearchParams, wallClockIn } from "@/components/shell/period-state";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { priceHistory, profitability, storeShareDeducted, type PurchasePrice } from "@/domain";
import { formatDate, formatInt } from "@/lib/format";
import { ALL_COST_LINES } from "@/lib/cost-lines";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { MobileMore } from "../_mobil/mobile-more";
import { PageHead } from "../vart-lager/_components/page-head";
import { TodoList } from "../vart-lager/_components/todo-list";
import { OwnProductToggle } from "./_components/own-product-toggle";
import { PriceForm } from "./_components/price-form";
import { PriceHistory } from "./_components/price-history";
import { PriceLog } from "./_components/price-log";
import { ScrollIntoView } from "./_components/scroll-into-view";
import { TitleTable, type StoreShareColumns } from "./_components/title-table";
import { loadPricePageFor, loadTitleDetailFor } from "./_lib/data";
import { currentPriceEconomics } from "./_lib/price-economics";
import {
  costLabel,
  PRICE_EDITOR_ID,
  pageHeadline,
  priceTodos,
  priceLog,
  priceTimeline,
  signalTitleIds,
  titleHeadline,
  titleRows,
} from "./_lib/model";

export const metadata: Metadata = { title: "Inköpspriser" };

/** Kolumnrubriken för andelen och vem den gäller: vald butik, vald automat eller alla. */
function shareScope(
  scope: { storeId: string | null; machineId: string | null },
  stores: ReadonlyArray<{ id: string; name: string }>,
  machines: ReadonlyArray<{ id: string; name: string; code?: string | null }>,
): StoreShareColumns {
  if (scope.storeId) {
    const store = stores.find((s) => s.id === scope.storeId);
    return { header: "Butikens andel", scope: store?.name ?? "vald butik" };
  }
  if (scope.machineId) {
    const m = machines.find((x) => x.id === scope.machineId);
    const name = m ? m.code || m.name : null;
    return { header: "Butikens andel", scope: name ? `automat ${name}` : "vald automat" };
  }
  return { header: "Butikernas andel", scope: "alla butiker" };
}

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
  // Ny produkt i Awish: ägare och admin.
  const canAddProduct = ctx.role === "owner" || ctx.role === "admin";
  const periodLabel = describePeriod(period.resolved).rangeLabel;
  const activeTitleIds = input.titles.filter((t) => !t.archived).map((t) => t.id);
  const economics = currentPriceEconomics({ ...input.current, titleIds: activeTitleIds });
  const unpriced = profitability(input.current, "title").unpriced;
  const allRows = titleRows(economics, input.titles, unpriced.byTitle);
  const onlyMissing = one(sp.saknar) === "pris";
  const rows = onlyMissing
    ? allRows.filter((r) => r.status === "missing" || r.unpricedOrders > 0)
    : allRows;
  // Ägarens regel: hela beloppet (före butikens andel) som standard. Andelen och vår del
  // visas med vald butik, eller med "Visa butikernas andel" när någon titel har en andel:
  // samma flagga som alla sidors vinst (loadDomainInput, Settings.deductStoreShare).
  const filtered = Boolean(period.scope.storeId && !period.scope.machineId);
  const anyShare = allRows.some((r) => (r.storeShareOre ?? 0) !== 0);
  const shareToggle = storeShareDeducted(input.settings) && !filtered;
  const showShare = filtered || (shareToggle && anyShare);
  const shareColumns: StoreShareColumns | null = showShare
    ? shareScope(period.scope, input.stores, input.machines)
    : null;
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
  const titleHead = selectedTitle
    ? titleHeadline(selectedRow, selectedTitle.name, today, shareColumns?.header ?? null)
    : null;
  const own = selectedTitle?.ownProduct === true;
  // Egen produkt: priset är kostnaden för innehållet, inte ett inköp.
  const titleAside =
    titleHead && own ? titleHead.aside.replace(/^Inköp /, "Kostnad ") : titleHead?.aside;
  const todoHref = (id: string) => {
    const q = new URLSearchParams(baseQuery);
    q.set("titel", id);
    return `/inkopspriser?${q.toString()}#${PRICE_EDITOR_ID}`;
  };
  const todos = priceTodos(allRows).map((t) => ({
    key: t.id,
    verb: t.verb,
    title: t.title,
    qty: t.orders > 0 ? t.orders : null,
    unit: "order",
    tone: t.tone,
    href: todoHref(t.id),
  }));
  const lastChange = data.lastChangeAt
    ? formatDate(wallClockIn(new Date(data.lastChangeAt), ctx.timeZone), {
        year: "auto",
        now: wallClockIn(new Date(ctx.now), ctx.timeZone),
      })
    : "Aldrig";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-6">
        <div className="relative">
          <PageHead
            eyebrow="Inköpspriser"
            title={headline.title}
            aside={headline.aside}
            actions={
              <>
                {canAddProduct ? (
                  <>
                    <Link
                      href="/inkopspriser/ny-produkt"
                      className="inline-flex h-9 items-center rounded-sm border border-line-strong bg-surface px-3 text-sm font-medium text-fg hover:border-line-control hover:bg-hover max-md:h-11 max-md:min-h-11"
                    >
                      Varor i Awish
                    </Link>
                    <Link
                      href="/inkopspriser/ny-produkt?flik=ny"
                      className="inline-flex h-9 items-center rounded-sm border border-line-strong bg-surface px-3 text-sm font-medium text-fg hover:border-line-control hover:bg-hover max-md:h-11 max-md:min-h-11"
                    >
                      + Ny produkt
                    </Link>
                  </>
                ) : null}
                {/* Vald butik: andelen visas alltid, knappen behövs inte. Utan andel: ingen knapp. */}
                {filtered || !anyShare ? null : (
                  <MobileMore
                    label="Fler val för inköpspriser"
                    className="max-md:absolute max-md:-top-2 max-md:-right-2"
                  >
                    <Suspense fallback={null}>
                      <StoreShareToggle on={shareToggle} menuItem />
                    </Suspense>
                  </MobileMore>
                )}
              </>
            }
          />
        </div>
        <TodoList items={todos} done="Alla titlar har pris." moreHref={undefined} />
        <dl
          className="rise flex flex-wrap gap-x-8 gap-y-2"
          style={{ "--i": 2 } as React.CSSProperties}
        >
          {[
            { label: "Period", value: periodLabel },
            {
              label: "Med pris",
              value: `${formatInt(pricedCount)} av ${formatInt(allRows.length)}`,
            },
            { label: "Senast ändrat", value: lastChange },
          ].map((x) => (
            <div key={x.label} className="flex flex-col">
              <dt className="label text-subtle">{x.label}</dt>
              <dd className="tnum text-base text-fg">{x.value}</dd>
            </div>
          ))}
        </dl>
        <AiPageLine metric="marginalen per titel" route="inkopspriser" />
      </div>

      <section
        aria-labelledby="per-titel"
        className="rise flex flex-col gap-6"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="per-titel" className="label text-subtle">
              Per titel · {periodLabel}
            </h2>
            {/* Vem andelen gäller syns vid tabellen (beskrivningen läses bara av skärmläsare). */}
            {shareColumns ? (
              <p className="meta text-subtle">
                {shareColumns.header} och vår del: {shareColumns.scope}
              </p>
            ) : null}
          </div>
          {onlyMissing ? (
            <Link
              href={showAllHref}
              className="meta rounded-xs text-muted underline underline-offset-4 hover:text-fg"
            >
              Visa alla titlar
            </Link>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <StateMessage
            kind="empty"
            message={onlyMissing ? "Alla titlar har inköpspris." : "Inga titlar ännu."}
            action={
              onlyMissing
                ? { label: "Visa alla titlar", href: showAllHref }
                : { label: "Importera order", href: "/datakallor" }
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
            rent={(input.costLines ?? ALL_COST_LINES).rent}
            share={shareColumns}
            note={
              anyShare && !shareColumns ? "Kvar per order är före butikernas andel." : undefined
            }
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
            aside={titleAside}
          />

          <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
            {/* Redigeraren först: ett klick på en titel rullar hit och sätter markören i priset. */}
            <div className="flex min-w-0 flex-col gap-6 lg:col-span-5">
              {canAddProduct ? (
                <div className="flex flex-wrap gap-x-6">
                  <Link
                    href={`/inkopspriser/ny-produkt?titel=${selectedTitle.id}`}
                    className="meta inline-flex min-h-11 w-fit items-center text-muted underline underline-offset-4 hover:text-fg md:min-h-0"
                  >
                    Redigera namn, pris och bild i Awish →
                  </Link>
                  <Link
                    href={`/inkopspriser/ny-produkt?flik=fack&titel=${selectedTitle.id}`}
                    className="meta inline-flex min-h-11 w-fit items-center text-muted underline underline-offset-4 hover:text-fg md:min-h-0"
                  >
                    Lägg i fack →
                  </Link>
                </div>
              ) : null}
              <OwnProductToggle
                key={`own-${selectedTitle.id}`}
                titleId={selectedTitle.id}
                titleName={selectedTitle.name}
                initial={own}
                canEdit={ctx.canEdit}
              />
              <h3 className="label text-subtle">{own ? "Ändra kostnad" : "Ändra inköpspris"}</h3>
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
                  label={costLabel(own)}
                  current={
                    selectedRow
                      ? {
                          leftBeforeOre: selectedRow.leftBeforeOre,
                          storeShareOre: selectedRow.storeShareOre,
                          leftOre: selectedRow.leftOre,
                        }
                      : null
                  }
                  query={baseQuery}
                  showShare={shareColumns?.header ?? null}
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
                  code="Inget pris"
                  compact
                  message={`${selectedTitle.name} saknar pris. Räknas inte i vinsten.`}
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
