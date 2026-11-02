import "server-only";

import type { SearchParamsInput } from "@/components/shell/period-state";
import {
  loadContext,
  loadDomainInput,
  loadPeriod,
  loadTodos,
  requireRoute,
} from "@/server/data/core";

import { loadHomeWith, type HomeData } from "./data";

/**
 * Hem för den inloggade, med de memoiserade laddarna (samma frågor som layouten delas).
 * Påfyllare skickas till sin startsida (Att göra) innan något läses.
 */
export async function loadHome(searchParams: SearchParamsInput): Promise<HomeData> {
  await requireRoute("hem");
  return loadHomeWith(
    {
      context: loadContext,
      period: loadPeriod,
      domainInput: loadDomainInput,
      todos: loadTodos,
    },
    searchParams,
  );
}
