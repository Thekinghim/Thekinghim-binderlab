import type { Metadata } from "next";
import type React from "react";

import { isMine, personOptions, todoAssignee } from "@/analytics/team";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { wallClockIn } from "@/components/shell/period-state";
import { Icon } from "@/components/ui/icon";
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
import { MineToggle } from "@/components/ui/mine-toggle";
import { loadTeamStateFor } from "@/server/data/team";
import { slotCapacitiesInRequest } from "@/server/data/core/loaders";
import { hasOwnStockRows, ownStockTotals } from "@/server/data/core/own-stock";
import { queryRefillSources } from "@/server/data/core/places";
import { loadRankedTodoState, loadStartklarFor, loadTodoVisitPlan } from "@/server/data/todos";
import { getActiveOrganization, requireUser, withUserDb } from "@/server/session";

import { Suggestions } from "@/app/(app)/assistent/_components/suggestions";
import { BokforingReady } from "@/app/(app)/ekonomi/_components/bokforing-ready";
import { monthText } from "@/app/(app)/ekonomi/_lib/view";
import { NewMachinesFound, loadNewMachinesSafe } from "@/app/(app)/_nya-automater/new-machines";
import { StartklarRow } from "@/app/(app)/_nya-automater/startklar-row";
import { AwishExpiry } from "@/app/(app)/_awish/awish-expiry";
import { loadAwishExpirySafe } from "@/server/awish/expiry-notice";
import { readyPackageFor } from "@/server/bokforing/stored";
import { loadAdvisorStateFor } from "@/server/assistant/advisor/service";

import { HeaderMeta } from "./_components/header-meta";
import { TodoBoard } from "./_components/todo-board";
import { buildPage, extraTodos, suggestionsLine } from "./_lib/model";
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
  // Besöksplanen (samma som Drift > Besök) läses bara när det finns något att fylla på.
  const visits = state.items.some((t) => t.kind === "refill") ? await loadTodoVisitPlan() : null;
  // Vem gör vad: uttrycklig tilldelning, annars automatens ansvariga, annars Båda.
  const teamState = await loadTeamStateFor(user, ctx.organization.id);
  const me = ctx.user.id;
  const assignees = new Map(
    state.items.map((t) => [
      t.key,
      todoAssignee(
        { key: t.key, machineIds: t.evidence.machineIds },
        teamState.assignments,
        teamState.responsibles,
      ).userId,
    ]),
  );
  const mine = readParam(sp, "mina") === "1";
  // "Mina / Alla" behövs bara när någon punkt är någon annans (annars är listorna lika).
  const othersHaveItems = state.items.some((t) => !isMine(assignees.get(t.key), me));
  const todos = mine ? state.items.filter((t) => isMine(assignees.get(t.key), me)) : state.items;
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
  // Rådgivarens förslag, bokföringen att ladda ner och nya automater (ägare och admin; tomt
  // för andra roller). Läses här en gång, så att rubriken räknar med raderna som visas.
  const viewer = organization ? { user, organization } : null;
  const [advisor, ready, newMachines, awishExpiry, startklar] = viewer
    ? await Promise.all([
        loadAdvisorStateFor(viewer, now),
        readyPackageFor(viewer).catch((error: unknown) => {
          console.error("[att-gora] Bokföringen kunde inte läsas:", error);
          return null;
        }),
        loadNewMachinesSafe(viewer),
        loadAwishExpirySafe(viewer, now),
        // Startklar: en ny automat har steg kvar (samma rad som menyns räknare och Hem).
        loadStartklarFor(viewer),
      ])
    : [null, null, null, null, null];

  // Påfyllningsrutan räknar som Fyll på: fackens kapacitet och lagret automaten fylls på
  // från. Läses bara när det finns något att fylla på; fel ger rutan utan förslag.
  const hasRefills = todos.some((t) => t.kind === "refill");
  const [capacities, sources] =
    hasRefills && viewer
      ? await Promise.all([
          slotCapacitiesInRequest(viewer, now).catch(() => []),
          withUserDb((tx) => queryRefillSources(tx, ctx.organization.id)).catch(() => null),
        ])
      : [[], null];

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
    capacities,
    sources,
    unknownStockMachineIds: [
      ...new Set(
        stock.rows
          .filter((r) => r.locationKind === "machine" && r.machineId !== null && !isKnownStock(r))
          .map((r) => r.machineId as string),
      ),
    ],
    scope: scopeFromSearchParams(sp),
    today: ctx.today,
    visitPlan: visits?.plan ?? null,
    ...(visits ? { places: visits.places } : {}),
    computedAt: formatTime(wall(now)),
    assignees,
    extras: extraTodos({
      bokforingMonth: ready ? monthText(ready.month) : null,
      newMachines: newMachines?.machines.length ?? 0,
      awishExpiry,
      startklar,
    }),
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
          // Mobil: "Först: …" döljs (första raden säger samma sak).
          className="pb-6 max-md:pb-3 md:pb-8 max-md:[&_p.line-clamp-2]:hidden"
        />
      </div>
      {mine || othersHaveItems ? (
        <div
          className="rise flex flex-wrap items-center gap-3 pb-6 max-md:pb-4"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <MineToggle
            mine={mine}
            hrefMine={withMine(sp, true)}
            hrefAll={withMine(sp, false)}
            label="Vems punkter"
          />
        </div>
      ) : null}
      <AwishExpiry notice={awishExpiry} />
      {viewer ? <NewMachinesFound viewer={viewer} preloaded={newMachines} /> : null}
      <StartklarRow todo={startklar} />
      {viewer ? <BokforingReady viewer={viewer} preloaded={ready} /> : null}
      {view.total === 0 ? (
        <div className="fade-in border-t border-line pt-10 pb-12">
          <StateMessage
            kind="empty"
            message={
              view.unknownStock > 0
                ? "Räkna in lagret först."
                : view.hiddenByScope > 0
                  ? "Inget för filtret."
                  : "Allt klart."
            }
            action={{
              label: view.unknownStock > 0 ? "Räkna in lagret" : "Visa lagret",
              href: "/lager",
            }}
          />
        </div>
      ) : null}
      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <TodoBoard
          groups={view.groups}
          dismissed={view.dismissed}
          canDismiss
          people={personOptions(me, teamState.team)}
        />
      </div>
      {/* AI-förslagen ligger under listan, hopfällda till en rad: det som brådskar står först. */}
      {advisor && advisor.suggestions.length > 0 ? (
        <details
          className="group/ai rise border-t border-line"
          style={{ "--i": 2 } as React.CSSProperties}
          data-ai-suggestions
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 text-base text-fg hover:text-fg [&::-webkit-details-marker]:hidden">
            <span>{suggestionsLine(advisor.suggestions)}</span>
            <Icon
              name="chevronRight"
              size={12}
              className="shrink-0 text-subtle transition-transform duration-fast group-open/ai:rotate-90"
            />
          </summary>
          {/* Telefonen: kortets knappar får 44 px tryckyta. */}
          <div className="pt-2 pb-8 max-md:[&_a]:min-h-11 max-md:[&_button]:min-h-11">
            <Suggestions items={advisor.suggestions} manualLeft={null} canGenerate={false} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function readParam(sp: SearchParamsInput, name: string): string | null {
  if ("get" in sp && typeof sp.get === "function") return sp.get(name);
  const v = (sp as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Samma adress med eller utan ?mina=1 (filtret ?butik/?automat behålls). */
function withMine(sp: SearchParamsInput, mine: boolean): string {
  const q = new URLSearchParams();
  const entries: [string, string][] =
    sp instanceof URLSearchParams
      ? [...sp.entries()]
      : "get" in sp && typeof sp.get === "function"
        ? []
        : Object.entries(sp as Record<string, string | string[] | undefined>).flatMap(([k, v]) =>
            v === undefined
              ? []
              : (Array.isArray(v) ? v : [v]).map((x): [string, string] => [k, x]),
          );
  for (const [k, v] of entries) if (k !== "mina") q.append(k, v);
  if (mine) q.set("mina", "1");
  const s = q.toString();
  return `/att-gora${s ? `?${s}` : ""}`;
}
