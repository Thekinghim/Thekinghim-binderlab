/**
 * Sidans egna parametrar: ?vy=titel|automat|butik, ?per=dag|vecka|manad och ?titel=<id>.
 * Okända värden ger standardvalet. Ren funktion, delas av server och klient.
 *
 * Andra sidor länkar hit med äldre namn: ?grupp=titel|automat|butik|dag|veckodag|vecka|manad
 * och ?fran= &till= för perioden. canonicalLonsamhetQuery översätter dem till sidans och
 * skalets namn (?vy=, ?per=, ?from=, ?to=), så att sidan, periodraden och filtret läser
 * samma adress.
 */

import type { TrendKey, ViewKey } from "./model";

type Param = string | string[] | null | undefined;
export type LonsamhetSearchParams = Record<string, string | string[] | undefined>;

function first(value: Param): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function norm(value: Param): string | null {
  const v = first(value)?.trim().toLowerCase();
  return v ? v : null;
}

const VIEWS: Record<string, ViewKey> = { titel: "title", automat: "machine", butik: "store" };
const TRENDS: Record<string, TrendKey> = {
  dag: "day",
  // Veckodag finns inte som upplösning här; närmast är per dag.
  veckodag: "day",
  vecka: "week",
  manad: "month",
  månad: "month",
};

/** URL-värden för vyerna (svenska, som skalets ?butik= och ?automat=). */
export const VIEW_PARAM: Record<ViewKey, string> = {
  title: "titel",
  machine: "automat",
  store: "butik",
};
export const TREND_PARAM: Record<TrendKey, string> = { day: "dag", week: "vecka", month: "manad" };

/** ?vy= → vy, eller null utan giltigt värde. */
export function parseViewParam(value: Param): ViewKey | null {
  const v = norm(value);
  return (v && VIEWS[v]) || null;
}

/** ?per= → upplösning, eller null (sidan väljer efter periodens längd). */
export function parseTrendParam(value: Param): TrendKey | null {
  const v = norm(value);
  return (v && TRENDS[v]) || null;
}

/** ?titel= → titelns id (markeras i tabellen), eller null. */
export function parseTitleParam(value: Param): string | null {
  const v = first(value)?.trim();
  return v && v.length <= 64 && /^[\w-]+$/.test(v) ? v.toLowerCase() : null;
}

/**
 * Översätter äldre parametrar (grupp, fran, till) till sidans och skalets. Returnerar den
 * nya frågesträngen ("?vy=titel&from=…", eller "" utan parametrar) när något ändrades,
 * annars null. Värden som redan står under det nya namnet vinner.
 */
export function canonicalLonsamhetQuery(sp: LonsamhetSearchParams): string | null {
  const legacy = ["grupp", "fran", "till"].some((k) => sp[k] !== undefined);
  if (!legacy) return null;

  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "grupp" || k === "fran" || k === "till" || v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else out.set(k, v);
  }

  const fran = first(sp.fran)?.trim();
  const till = first(sp.till)?.trim();
  if (fran && !out.has("from") && !out.has("period")) out.set("from", fran);
  if (till && !out.has("to") && !out.has("period")) out.set("to", till);

  const grupp = norm(sp.grupp);
  if (grupp && VIEWS[grupp] && !out.has("vy")) out.set("vy", grupp);
  const trend = grupp ? TRENDS[grupp] : undefined;
  if (trend && !out.has("per")) out.set("per", TREND_PARAM[trend]);

  const s = out.toString();
  return s ? `?${s}` : "";
}

/** Fliken under bryggan: tabell (förval), utveckling eller rytm (?visa=). */
export type AnalysisTab = "table" | "trend" | "rhythm";

/** ?visa= för varje flik. */
export const ANALYSIS_PARAM: Record<AnalysisTab, string> = {
  table: "tabell",
  trend: "utveckling",
  rhythm: "rytm",
};

/** Läser ?visa=; okänt eller saknat ger tabellen. */
export function parseAnalysisTab(raw: Param): AnalysisTab {
  const v = norm(raw);
  if (v === "utveckling") return "trend";
  if (v === "rytm") return "rhythm";
  return "table";
}
