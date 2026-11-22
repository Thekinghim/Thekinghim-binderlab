import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import type React from "react";
import { Suspense } from "react";
import Link from "next/link";

import { describePeriod, toURLSearchParams, wallClockIn } from "@/components/shell/period-state";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { StateMessage } from "@/components/ui/state-message";
import { ButtonLink } from "@/components/v2/button";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { priceHistory, profitability, storeShareDeducted, type PurchasePrice } from "@/domain";
import { MISSING, formatDate, formatInt, formatKronor } from "@/lib/format";
import { ALL_COST_LINES } from "@/lib/cost-lines";
import { messages } from "@/i18n";
import {
  loadDomainInput,
  loadOptionalContextIfSignedIn,
  loadPeriod,
  requireRoute,
} from "@/server/data/core";
import { requireUser } from "@/server/session";

import { ClosedMonthsNote } from "../_manad/closed-note";
import { SimplePricesScreen } from "../_enkel/prices-screen";
import { MobileMore } from "../_mobil/mobile-more";
import { currentViewer } from "../lager/_lib/session";
import { TodoList } from "../vart-lager/_components/todo-list";
import { CostNotice } from "../vart-lager/mystery/_components/cost-notice";
import { loadMysteryCostDriftsFor } from "../vart-lager/mystery/_lib/data";
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
  CUSTOMER_PRICE_TEXT,
  kr,
  PRICE_EDITOR_ID,
  pageHeadline,
  priceTodos,
  priceLog,
  priceTimeline,
  signalTitleIds,
  priceGap,
  priceGapText,
  titleHeadline,
  titleRows,
  withCustomerPrices,
} from "./_lib/model";

/** Inköpspriser; i Enkel vy på personens språk. */
export async function generateMetadata(): Promise<Metadata> {
  const ctx = await loadOptionalContextIfSignedIn().catch(() => null);
  if (ctx?.viewMode === "simple") return { title: messages(ctx.locale).stock.pricesTitle };
  return { title: "Inköpspriser" };
}

/** Kolumnrubriken för andelen och vem den gäller: vald butik, vald automat eller alla. */
function shareScope(
  scope: { storeId: string | null; machineId: string | null; ownerId?: string | null },
  stores: ReadonlyArray<{ id: string; name: string }>,
  machines: ReadonlyArray<{ id: string; name: string; code?: string | null }>,
  owners: ReadonlyArray<{ id: string; name: string }> = [],
): StoreShareColumns {
  if (scope.storeId) {
    const store = stores.find((s) => s.id === scope.storeId);
    return { header: "Butikens andel", scope: store?.name ?? "vald butik" };
  }
  if (scope.ownerId && !scope.machineId) {
    const owner = owners.find((o) => o.id === scope.ownerId);
    return { header: "Butikernas andel", scope: owner?.name ?? "vald butiksägare" };
  }
  if (scope.machineId) {
    const m = machines.find((x) => x.id === scope.machineId);
    const name = m ? m.code || m.name : null;
    return { header: "Butikens andel", scope: name ? `automat ${name}` : "vald automat" };
  }
  return { header: "Butikernas andel", scope: "alla butiker" };
}

type SearchParams = Record<string, string | string[] | undefined>;

/** Ett pris i kronor, eller strecket när det saknas (aldrig 0 kr). */
function money(ore: number | null | undefined): string {
  return ore === null || ore === undefined ? MISSING : formatKronor(kr(ore));
}

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
  // Enkel vy: delägarens enkla lista med priser och Ändra (ingen butiksandel, ingen logg).
  if (ctx.viewMode === "simple") return <SimplePricesScreen ctx={ctx} />;
  const sp = await searchParams;
  const [period, user] = await Promise.all([loadPeriod(sp), requireUser()]);
  const [input, data, mysteryDrifts] = await Promise.all([
    loadDomainInput({ period: period.period, ...period.scope }),
    loadPricePageFor(user, ctx.organization.id),
    // Mystery packs vars inköpspris inte stämmer med kalkylen ("kostar nu X kr, inte Y kr").
    currentViewer().then((viewer) => loadMysteryCostDriftsFor(viewer, new Date(ctx.now))),
  ]);

  const today = ctx.today;
  // Ny produkt i Awish: ägare och admin.
  const canAddProduct = ctx.role === "owner" || ctx.role === "admin";
  const periodLabel = describePeriod(period.resolved).rangeLabel;
  const activeTitleIds = input.titles.filter((t) => !t.archived).map((t) => t.id);
  const economics = currentPriceEconomics({ ...input.current, titleIds: activeTitleIds });
  const unpriced = profitability(input.current, "title").unpriced;
  // Pris mot kund läggs på raderna efter beräkningen: det visas bara, inget räknas på det.
  const allRows = withCustomerPrices(
    titleRows(economics, input.titles, unpriced.byTitle),
    data.prices,
  );
  const onlyMissing = one(sp.saknar) === "pris";
  const rows = onlyMissing
    ? allRows.filter((r) => r.status === "missing" || r.unpricedOrders > 0)
    : allRows;
  // Ägarens regel: hela beloppet (före butikens andel) som standard. Andelen och vår del
  // visas med vald butik, eller med "Visa butikernas andel" när någon titel har en andel:
  // samma flagga som alla sidors vinst (loadDomainInput, Settings.deductStoreShare).
  const filtered = Boolean(
    (period.scope.storeId || period.scope.ownerId) && !period.scope.machineId,
  );
  const anyShare = allRows.some((r) => (r.storeShareOre ?? 0) !== 0);
  const shareToggle = storeShareDeducted(input.settings) && !filtered;
  const showShare = filtered || (shareToggle && anyShare);
  const shareColumns: StoreShareColumns | null = showShare
    ? shareScope(period.scope, input.stores, input.machines, input.owners)
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
  // Priset som gäller i dag: det formuläret ändrar, och det titelns huvud visar (tabellen
  // visar priset vid periodens slut, som är samma sak i en period som slutar i dag).
  const todayPrice = titlePrices.filter((p) => p.validFrom <= today).at(-1) ?? null;
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
          new Map(titlePrices.map((p) => [p.validFrom, p.customerPriceOre])),
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
    <div className={PAGE_BODY}>
      <PageIntro
        title={headline.title}
        aside={headline.aside}
        facts={[
          { label: "Period", value: periodLabel },
          {
            label: "Med pris",
            value: `${formatInt(pricedCount)} av ${formatInt(allRows.length)}`,
          },
          { label: "Senast ändrat", value: lastChange },
        ]}
        actions={
          <>
            {canAddProduct ? (
              <>
                <ButtonLink href="/inkopspriser/ny-produkt" touch>
                  Varor i Awish
                </ButtonLink>
                <ButtonLink href="/inkopspriser/ny-produkt?flik=ny" touch>
                  + Ny produkt
                </ButtonLink>
              </>
            ) : null}
            {/* Vald butik: andelen visas alltid, knappen behövs inte. Utan andel: ingen knapp. */}
            {filtered || !anyShare ? null : (
              <MobileMore label="Fler val för inköpspriser">
                <Suspense fallback={null}>
                  <StoreShareToggle on={shareToggle} menuItem />
                </Suspense>
              </MobileMore>
            )}
          </>
        }
      >
        <AiPageLine metric="marginalen per titel" route="inkopspriser" />
      </PageIntro>
      <TodoList items={todos} done="Alla titlar har pris." moreHref={undefined} />
      {mysteryDrifts.map((d) => (
        <CostNotice
          key={d.titleId}
          titleId={d.titleId}
          name={d.name}
          currentOre={d.currentOre}
          calculatedOre={d.calculatedOre}
          canUpdate={ctx.canEdit}
          href={`/vart-lager/mystery/${d.titleId}#kalkyl`}
        />
      ))}

      <section aria-labelledby="per-titel" className="v2-card">
        <div className="v2-card-hd flex-wrap gap-y-1">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="per-titel">
              Per titel <span className="font-[450] text-v2-mute">· {periodLabel}</span>
            </h2>
            {/* Vem andelen gäller syns vid tabellen (beskrivningen läses bara av skärmläsare). */}
            {shareColumns ? (
              <p className="text-v2-sm text-v2-mute">
                {shareColumns.header} och vår del: {shareColumns.scope}
              </p>
            ) : null}
          </div>
          {onlyMissing ? (
            <Link className="lk" href={showAllHref}>
              Visa alla titlar <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <div className="v2-card-body">
            <StateMessage
              kind="empty"
              message={onlyMissing ? "Alla titlar har inköpspris." : "Inga titlar ännu."}
              action={
                onlyMissing
                  ? { label: "Visa alla titlar", href: showAllHref }
                  : { label: "Importera order", href: "/datakallor" }
              }
            />
          </div>
        ) : (
          <div className="px-[18px] pt-2 pb-3">
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
          </div>
        )}
      </section>

      {selectedTitle && titleHead ? (
        <section
          id={PRICE_EDITOR_ID}
          aria-labelledby="titel-rubrik"
          tabIndex={-1}
          className="v2-card scroll-mt-28 outline-none md:scroll-mt-44"
        >
          <ScrollIntoView
            targetId={PRICE_EDITOR_ID}
            titleId={selectedTitle.id}
            active={requested !== null}
          />
          <div className="v2-card-hd">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 id="titel-rubrik">{titleHead.title}</h2>
              <p className="text-v2-sm text-v2-mute">
                {selectedTitle.series ? `${selectedTitle.series} · ` : ""}
                {titleAside}
              </p>
            </div>
          </div>

          {/* Vårt pris och pris mot kund i dag, också på mobil (där tabellen döljer dem). */}
          <div className="flex flex-col gap-2 border-b border-v2-line2 px-[18px] py-3">
            <dl
              aria-label={`Priser för ${selectedTitle.name}`}
              className="flex flex-wrap gap-x-8 gap-y-2"
            >
              {[
                {
                  label: own ? "Vår kostnad" : CUSTOMER_PRICE_TEXT.ours,
                  value: money(todayPrice?.unitCostOre),
                },
                {
                  label: CUSTOMER_PRICE_TEXT.customer,
                  value: money(todayPrice?.customerPriceOre),
                },
                {
                  label: CUSTOMER_PRICE_TEXT.gap,
                  value: priceGapText(
                    priceGap(todayPrice?.unitCostOre, todayPrice?.customerPriceOre),
                  ),
                },
              ].map((x) => (
                <div key={x.label} className="flex flex-col">
                  <dt className="text-v2-xs font-[550] text-v2-mute">{x.label}</dt>
                  <dd className="tnum text-v2-lg font-[650] text-v2-ink">{x.value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-v2-xs text-v2-mute">{CUSTOMER_PRICE_TEXT.helper}</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12">
            {/* Redigeraren först: ett klick på en titel rullar hit och sätter markören i priset. */}
            <div className="flex min-w-0 flex-col gap-4 px-[18px] py-4 lg:col-span-5 lg:border-r lg:border-v2-line2">
              {canAddProduct ? (
                <div className="flex flex-wrap gap-x-6">
                  <Link
                    href={`/inkopspriser/ny-produkt?titel=${selectedTitle.id}`}
                    className="inline-flex min-h-11 w-fit items-center text-v2-sm font-[550] text-v2-ink hover:underline md:min-h-7"
                  >
                    Redigera namn, pris och bild i Awish →
                  </Link>
                  <Link
                    href={`/inkopspriser/ny-produkt?flik=fack&titel=${selectedTitle.id}`}
                    className="inline-flex min-h-11 w-fit items-center text-v2-sm font-[550] text-v2-ink hover:underline md:min-h-7"
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
              <h3 className="text-v2-md font-[650] text-v2-ink">
                {own ? "Ändra kostnad" : "Ändra inköpspris"}
              </h3>
              <ClosedMonthsNote months={data.closedMonths} />
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
                  currentCostOre={todayPrice?.unitCostOre ?? null}
                  customerPriceOre={todayPrice?.customerPriceOre ?? null}
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

            <div className="flex min-w-0 flex-col gap-4 border-t border-v2-line2 px-[18px] py-4 lg:col-span-7 lg:border-t-0">
              <h3 className="text-v2-md font-[650] text-v2-ink">Prishistorik</h3>
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

          <div className="flex flex-col gap-4 border-t border-v2-line2 px-[18px] py-4">
            <h3 className="text-v2-md font-[650] text-v2-ink">Ändringslogg</h3>
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
