/**
 * Sidans egna parametrar: ?vy=titel|automat|butik och ?per=vecka|manad.
 * Okända värden ger standardvalet. Ren funktion, delas av server och klient.
 */

import type { TrendKey, ViewKey } from "./model";

type Param = string | string[] | null | undefined;

function first(value: Param): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const VIEWS: Record<string, ViewKey> = { titel: "title", automat: "machine", butik: "store" };
const TRENDS: Record<string, TrendKey> = { vecka: "week", manad: "month", månad: "month" };

/** ?vy= → vy. Standard: per titel. */
export function parseViewParam(value: Param): ViewKey {
  const v = first(value)?.trim().toLowerCase();
  return (v && VIEWS[v]) || "title";
}

/** ?per= → upplösning, eller null (sidan väljer efter periodens längd). */
export function parseTrendParam(value: Param): TrendKey | null {
  const v = first(value)?.trim().toLowerCase();
  return (v && TRENDS[v]) || null;
}
