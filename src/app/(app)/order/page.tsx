import type { Metadata } from "next";
import type { CSSProperties } from "react";

import { routeById } from "@/components/shell/nav";
import { toURLSearchParams } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatKronor, formatPeriodShort, MISSING } from "@/lib/format";
import { OPERATOR_ROLES, requireRoute } from "@/server/data/core";

import { OrderBrowser } from "./_components/order-browser";
import { isoToLocalDate, orderHeadline, sentence } from "./_lib/headline";
import { hasPageFilter, listSignature, lockedListQuery, withOrderParams } from "./_lib/params";
import { titleChoices } from "./_lib/refs";
import { loadOrderDetailFor, loadOrderListFor } from "./_lib/service";
import { currentViewer, listArgsFrom } from "./_lib/session";

export const metadata: Metadata = { title: "Order" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Order: varje betald order i perioden, sökbar och filtrerbar (titel, automat, butik,
 * period i URL:en). Listan laddas en sida i taget från servern i vald sortering och
 * fylls på när man scrollar; exporten tar hela urvalet. Klick på ett ordernummer visar
 * ordern med originaltitel, tolkad titel och importen den kom från.
 * Ägare, admin och läsare (requireRoute skickar påfyllaren till Att göra).
 */
export default async function OrderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireRoute("order");
  const sp = await searchParams;
  const { args, period, params } = await listArgsFrom(sp);
  const viewer = await currentViewer();
  const now = new Date(ctx.now);

  const [list, initialDetail] = await Promise.all([
    loadOrderListFor(viewer, args, now),
    params.orderId ? loadOrderDetailFor(viewer, params.orderId) : Promise.resolve(null),
  ]);

  const scoped = period.scope.storeId !== null || period.scope.machineId !== null;
  const pageFiltered = hasPageFilter(params);
  const headline = orderHeadline({
    totals: list.totals,
    compareTotals: list.compareTotals,
    period: list.period,
    compare: list.compare,
    days: period.days,
    periodKey: period.key,
    hasOrders: list.hasOrders,
    latestOrderAt: list.latestOrderAt,
    dataStart: list.firstOrderDate,
    filtered: scoped || pageFiltered,
    timeZone: ctx.timeZone,
    now,
  });
  const periodText = formatPeriodShort(
    { start: isoToLocalDate(list.period.start), end: isoToLocalDate(list.period.end) },
    now,
  );
  const canOpenImport = routeById("datakallor").roles.includes(ctx.role);
  const canMarkTestPurchase = (OPERATOR_ROLES as readonly string[]).includes(ctx.role);

  let empty = null;
  if (!list.hasOrders) {
    empty = (
      <StateMessage
        kind="empty"
        message="Inga order är importerade ännu."
        action={canOpenImport ? { label: "Importera orderlistan", href: "/datakallor" } : undefined}
      />
    );
  } else if (list.totals.count === 0 && list.rows.length === 0) {
    // Inga rader alls. Bara testköp ger rader men antal 0: då visas listan (de går att ångra).
    const all = toURLSearchParams(sp);
    all.delete("from");
    all.delete("to");
    all.set("period", "allt");
    empty =
      pageFiltered || scoped ? (
        <StateMessage
          kind="no-results"
          message={`Ingen order ${periodText} matchar ${
            params.q ? `”${params.q}”` : "filtret"
          }${scoped ? " i vald butik eller automat" : ""}.`}
          action={
            pageFiltered
              ? {
                  label: "Rensa sökning och titel",
                  href: `/order?${withOrderParams(sp, { q: "", titleId: null, orderId: null })}`,
                }
              : { label: "Sök i hela historiken", href: `/order?${all}` }
          }
        />
      ) : (
        <StateMessage
          kind="empty"
          message={sentence(`Inga order ${periodText}`)}
          action={{ label: "Visa hela historiken", href: `/order?${all}` }}
        />
      );
  }

  // Sidofakta säger bara det rubriken inte säger: utan träffar står senaste ordern redan där.
  const meta =
    list.totals.count === 0
      ? [{ label: "Period", value: periodText }]
      : [
          { label: "Period", value: periodText },
          {
            label: "Snitt per order",
            value:
              list.averageOrderValueOre === null
                ? MISSING
                : formatKronor(list.averageOrderValueOre / 100),
          },
        ];

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 pt-8 pb-16 max-md:gap-5 md:px-8 md:pt-10">
      <SectionHeader
        // Mobil: perioden står redan i raden överst; bara snittet visas.
        className="rise max-md:[&_dl>div:first-child]:hidden"
        as="h1"
        size="lg"
        eyebrow="Order"
        title={headline.title}
        aside={headline.aside}
        meta={meta}
      />

      <section
        aria-label="Orderlista"
        className="rise flex min-w-0 flex-col"
        style={{ "--i": 1 } as CSSProperties}
      >
        <OrderBrowser
          query={listSignature(sp)}
          pageQuery={lockedListQuery(sp, list.period)}
          rows={list.rows}
          nextOffset={list.nextOffset}
          totals={list.totals}
          refs={list.refs}
          titleOptions={titleChoices(list.refs.titles, params.titleId)}
          q={params.q}
          titleId={params.titleId}
          sort={params.sort}
          timeZone={ctx.timeZone}
          now={ctx.now}
          canOpenImport={canOpenImport}
          canMarkTestPurchase={canMarkTestPurchase}
          initialOrderId={params.orderId}
          initialDetail={initialDetail}
          empty={empty}
        />
      </section>
    </div>
  );
}
