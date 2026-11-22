import type { Metadata } from "next";

import { V2Page, headerDate } from "@/components/v2/shell/page";
import { getT } from "@/i18n/server";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadTodoCount } from "@/server/data/todos";
import { loadWeeklySummaryFor } from "@/server/weekly/summary";

import { WeekSummary } from "./_components/week-summary";
import { weekFromParam } from "./_lib/model";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.week.title };
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Veckan (/veckan): sidan som måndagens notis öppnar. Förra veckan mot veckan innan, bästa
 * produkten och Att göra. ?v=ÅÅÅÅ-MM-DD (en måndag) väljer veckan, annars förra veckan.
 * Samma roller som Hem (ägare, admin, läsare); läsaren har ingen Att göra-lista. Vinsten är
 * alltid före butikernas andel. I den enkla vyn visas samma sammanfattning på Försäljning.
 */
export default async function WeekPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireRoute("hem");
  const [sp, viewer, { t, f }] = await Promise.all([searchParams, requireViewer(), getT()]);
  const summary = await loadWeeklySummaryFor(
    viewer,
    weekFromParam(sp.v, ctx.today),
    new Date(ctx.now),
    { todos: async () => (ctx.canEdit ? loadTodoCount() : null) },
  );
  return (
    <V2Page title={t.week.title} date={headerDate(new Date(ctx.now), ctx.timeZone)}>
      <div className="mx-auto w-full max-w-[640px]">
        <WeekSummary
          summary={summary}
          today={ctx.today}
          t={t}
          f={f}
          headingLevel="h2"
          todoHref={ctx.canEdit ? "/att-gora" : null}
          close={{ href: "/", label: t.week.toHome }}
          v2
        />
      </div>
    </V2Page>
  );
}
