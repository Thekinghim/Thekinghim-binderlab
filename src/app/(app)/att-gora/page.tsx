import type { Metadata } from "next";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { wallClockIn } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatTime } from "@/lib/format";
import {
  loadMasterData,
  loadStock,
  loadTodos,
  requireRoute,
  scopeFromSearchParams,
} from "@/server/data/core";

import { TodoBoard } from "./_components/todo-board";
import { buildPage } from "./_lib/model";

export const metadata: Metadata = { title: "Att göra" };

/**
 * Att göra: det som kräver åtgärd, räknat automatiskt ur order, lager, priser och
 * rapporter (@/analytics/todos via loadTodos, samma lista som menyns räknare).
 * Ingen manuell lista: punkter försvinner när orsaken är löst och kan bockas av.
 *
 * Ägare och admin ser alla regler. Påfyllaren ser bara lagerpunkter, utan belopp
 * (loadTodos tar bort dem på servern). Läsaren har ingen Att göra (requireRoute).
 */
export default async function TodoPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const ctx = await requireRoute("att-gora");
  const sp = await searchParams;
  const [todos, master, stock] = await Promise.all([loadTodos(), loadMasterData(), loadStock()]);

  const central = stock.warehouse.filter((r) => r.isCentral);
  const warehouse =
    central.length > 0 || stock.rows.some((r) => r.isCentral)
      ? new Map(central.map((r) => [r.titleId, r.onHand]))
      : null;

  const view = buildPage({
    todos,
    role: ctx.role,
    economy: ctx.canSeeEconomy,
    titles: master.titles,
    machines: master.machines,
    machineStock: stock.machineStock,
    warehouse,
    scope: scopeFromSearchParams(sp),
    computedAt: formatTime(wallClockIn(new Date(ctx.now), ctx.timeZone)),
  });

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        id="att-gora-rubrik"
        eyebrow="Att göra"
        title={view.header.title}
        aside={view.header.aside}
        meta={view.header.meta}
        className="pb-12 md:pb-16"
      />
      {view.total === 0 ? (
        <div className="border-t border-line pt-10">
          <StateMessage
            kind="empty"
            message={
              view.hiddenByScope > 0
                ? "Inget att göra för filtret."
                : "Inget kräver åtgärd just nu."
            }
            detail={
              ctx.role === "refiller"
                ? "Listan räknas om vid varje försäljning och påfyllning. Nya punkter dyker upp här av sig själva."
                : "Listan räknas om vid varje synk, påfyllning och prisändring. Nya punkter dyker upp här av sig själva."
            }
            action={{ label: "Visa lagret →", href: "/lager" }}
          />
        </div>
      ) : (
        <TodoBoard groups={view.groups} canDismiss />
      )}
    </div>
  );
}
