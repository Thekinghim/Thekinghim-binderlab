import type { Metadata } from "next";
import type React from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { wallClockIn } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatRelative, formatTime } from "@/lib/format";
import {
  isKnownStock,
  loadMasterData,
  loadStock,
  requireRoute,
  scopeFromSearchParams,
} from "@/server/data/core";
import { hasOwnStockRows, ownStockTotals } from "@/server/data/core/own-stock";
import { loadRankedTodoState } from "@/server/data/todos";
import { getActiveOrganization, requireUser } from "@/server/session";

import { Suggestions } from "@/app/(app)/assistent/_components/suggestions";
import { BokforingReady } from "@/app/(app)/ekonomi/_components/bokforing-ready";
import { loadAdvisorStateFor } from "@/server/assistant/advisor/service";

import { HeaderMeta } from "./_components/header-meta";
import { TodoBoard } from "./_components/todo-board";
import { buildPage } from "./_lib/model";
import { loadDismissedFor } from "./_lib/service";

export const metadata: Metadata = { title: "Att göra" };

/**
 * Att göra: det som kräver åtgärd, räknat automatiskt ur order, lager, priser, rapporter,
 * avtal och larm (@/analytics/todos, samma punkter som menyns räknare), med påfyllningar
 * där slutsålt redan kostat intäkt först inom sin nivå (loadRankedTodoState).
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
  const [state, master, stock, user, organization] = await Promise.all([
    loadRankedTodoState(),
    loadMasterData(),
    loadStock(),
    requireUser(),
    getActiveOrganization(),
  ]);
  const now = new Date(ctx.now);
  const todos = state.items;
  // Avbockade punkter vars orsak finns kvar (RLS: påfyllaren bara lagerpunkter). En
  // avbockning vars orsak redan är löst döljer inget och visas inte.
  const dismissed = organization
    ? await loadDismissedFor(
        { user, organization },
        new Set(todos.map((t) => t.key)),
        now,
        new Set(state.dismissed.map((t) => t.key)),
      )
    : [];
  const wall = (d: Date) => wallClockIn(d, ctx.timeZone);
  // Rådgivarens öppna förslag (ägare och admin; null för andra roller).
  const advisor = organization ? await loadAdvisorStateFor({ user, organization }, now) : null;

  // Vårt lager: summan av alla egna lager per titel.
  const warehouse = hasOwnStockRows(stock.rows)
    ? new Map(ownStockTotals(stock.rows).map((r) => [r.titleId, r.onHand]))
    : null;

  const view = buildPage({
    todos,
    role: ctx.role,
    economy: ctx.canSeeEconomy,
    titles: master.titles,
    machines: master.machines,
    machineStock: stock.machineStock,
    warehouse,
    unknownStockMachineIds: [
      ...new Set(
        stock.rows
          .filter((r) => r.locationKind === "machine" && r.machineId !== null && !isKnownStock(r))
          .map((r) => r.machineId as string),
      ),
    ],
    scope: scopeFromSearchParams(sp),
    computedAt: formatTime(wall(now)),
    dismissed: dismissed.map((d) => ({
      key: d.key,
      title: d.title,
      when: formatRelative(wall(new Date(d.dismissedAt)), wall(now)),
      by: d.dismissedBy,
    })),
  });

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="rise">
        <SectionHeader
          as="h1"
          size="xl"
          id="att-gora-rubrik"
          eyebrow="Att göra"
          title={view.header.title}
          aside={view.header.aside}
          description={view.header.description || undefined}
          meta={<HeaderMeta items={view.header.meta} />}
          className="pb-12 md:pb-16"
        />
      </div>
      {organization ? <BokforingReady viewer={{ user, organization }} /> : null}
      {advisor && advisor.suggestions.length > 0 ? (
        <section
          aria-labelledby="forslag-rubrik"
          className="rise flex flex-col gap-4 pb-10"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <SectionHeader
            id="forslag-rubrik"
            size="sm"
            title="Förslag."
            aside="Från AI. Talen kontrollerade, effekten uppskattad."
          />
          <Suggestions items={advisor.suggestions} manualLeft={null} canGenerate={false} />
        </section>
      ) : null}
      {view.total === 0 ? (
        <div className="fade-in border-t border-line pt-10 pb-12">
          <StateMessage
            kind="empty"
            message={
              view.unknownStock > 0
                ? "Påfyllningar räknas när lagret är inräknat."
                : view.hiddenByScope > 0
                  ? "Inget att göra för filtret."
                  : "Inget kräver åtgärd just nu."
            }
            action={{
              label: view.unknownStock > 0 ? "Räkna in lagret" : "Visa lagret",
              href: "/lager",
            }}
          />
        </div>
      ) : null}
      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <TodoBoard groups={view.groups} dismissed={view.dismissed} canDismiss />
      </div>
    </div>
  );
}
