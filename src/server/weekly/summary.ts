/**
 * Veckosammanfattningens siffror för en given användare: förra veckan mot veckan innan,
 * bästa produkten och antalet punkter i Att göra. Läses under RLS som användaren, med samma
 * laddare som sidorna (loadDomainInputFor), alltid FÖRE butikernas andel och utan VMB-knappen.
 * Används av sidan Veckan, Försäljning i den enkla vyn och måndagens notis (./job.ts), så
 * att alla tre visar samma tal. Att göra räknas av anroparen (den här filen läser inget om
 * Att göra, utbetalningar eller avräkningar: Försäljning i den enkla vyn visar bara siffrorna).
 */

import "server-only";

import {
  buildWeeklySummary,
  type WeekPeriods,
  type WeeklySummary,
} from "@/app/(app)/veckan/_lib/model";
import { profitabilityViews } from "@/domain";
import { loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";

export async function loadWeeklySummaryFor(
  viewer: Viewer,
  periods: WeekPeriods,
  now: Date = new Date(),
  options: {
    /**
     * Antalet punkter i Att göra (sidan: menyns räknare; jobbet: loadTodoCountFor). Utelämnat
     * = visas inte: den enkla vyn har ingen Att göra-lista, och läsaren inte heller.
     */
    readonly todos?: () => Promise<number | null>;
  } = {},
): Promise<WeeklySummary> {
  const todosP = (options.todos ?? (async () => null))().catch(() => null);
  const input = await loadDomainInputFor(
    viewer,
    {
      period: periods.all,
      compare: null,
      storeId: null,
      machineId: null,
      vmb: false,
      storeShare: false,
    },
    now,
  );
  const days = profitabilityViews(input.current, ["day"]).day.rows.filter((r) => r.kind === "time");
  const lastOrders = input.current.orders.filter(
    (o) => o.businessDate >= periods.last.start && o.businessDate <= periods.last.end,
  );
  const titleRows = profitabilityViews(
    { ...input.current, orders: lastOrders, period: periods.last },
    ["title"],
  ).title.rows;
  return buildWeeklySummary({
    periods,
    days,
    titleRows,
    titles: input.titles,
    todos: await todosP,
  });
}
