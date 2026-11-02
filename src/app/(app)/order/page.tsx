import type { Metadata } from "next";

import { routeById } from "@/components/shell/nav";
import { toURLSearchParams } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatKronor, formatPeriodShort, MISSING } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { OrderBrowser } from "./_components/order-browser";
import { averageOre, formatAt, isoToLocalDate, orderHeadline, sentence } from "./_lib/headline";
import { hasPageFilter, listSignature, withOrderParams } from "./_lib/params";
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
    latestOrderAt: list.latestOrderAt,
    dataStart: period.dataStart,
    filtered: scoped || pageFiltered,
    timeZone: ctx.timeZone,
    now,
  });
  const avg = averageOre(list.totals);
  const periodText = formatPeriodShort(
    { start: isoToLocalDate(list.period.start), end: isoToLocalDate(list.period.end) },
    now,
  );
  const canOpenImport = routeById("datakallor").roles.includes(ctx.role);

  let empty = null;
  if (list.latestOrderAt === null) {
    empty = (
      <StateMessage
        kind="empty"
        message="Inga order är importerade ännu."
        detail="Orderna kommer från Awish via Datakällor."
        action={canOpenImport ? { label: "Importera orderlistan", href: "/datakallor" } : undefined}
      />
    );
  } else if (list.totals.count === 0) {
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
          detail={
            params.q
              ? "Sökningen gäller ordernummer, tolkad titel, originaltitel, automat och butik."
              : undefined
          }
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
          detail={`Senaste ordern kom ${formatAt(list.latestOrderAt, ctx.timeZone, now)}.`}
          action={{ label: "Visa hela historiken", href: `/order?${all}` }}
        />
      );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Order"
        title={headline.title}
        aside={headline.aside}
        meta={[
          { label: "Period", value: periodText },
          { label: "Snitt per order", value: avg === null ? MISSING : formatKronor(avg / 100) },
          {
            label: "Senaste order",
            value: formatAt(list.latestOrderAt, ctx.timeZone, now),
          },
        ]}
      />

      <section aria-label="Orderlista" className="flex min-w-0 flex-col">
        <OrderBrowser
          query={listSignature(sp)}
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
          initialOrderId={params.orderId}
          initialDetail={initialDetail}
          empty={empty}
        />
      </section>
    </div>
  );
}
