/**
 * Orderlistans egna URL-parametrar, utöver skalets (?period ?from ?to ?butik ?automat):
 *
 *   ?q=        fritext (ordernummer, titel, originaltitel, automat, butik)
 *   ?titel=    titelns id
 *   ?sortera=  tid | nr | titel | automat | butik | belopp   (standard: tid)
 *   ?ordning=  stigande | fallande                           (standard: fallande för tid och belopp)
 *   ?order=    orderns id (detaljvyn är öppen)
 *
 * Rent och klientsäkert: används av sidan, server actions, exporten och filterraden.
 * Skräp i URL:en ger aldrig fel, bara standardvärden.
 */

import {
  FROM_PARAM,
  PERIOD_PARAM,
  TO_PARAM,
  toURLSearchParams,
  type SearchParamsInput,
} from "@/components/shell/period-state";

export const SEARCH_PARAM = "q";
export const TITLE_PARAM = "titel";
export const SORT_PARAM = "sortera";
export const DIR_PARAM = "ordning";
export const ORDER_PARAM = "order";

/** Parametrar som hör till listan (inte detaljvyn). */
export const LIST_PARAMS = [SEARCH_PARAM, TITLE_PARAM, SORT_PARAM, DIR_PARAM] as const;

export const SORT_KEYS = ["tid", "nr", "titel", "automat", "butik", "belopp"] as const;
export type OrderSortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export interface OrderSort {
  readonly key: OrderSortKey;
  readonly dir: SortDir;
}

/** Nyaste först. */
export const DEFAULT_SORT: OrderSort = { key: "tid", dir: "desc" };

/** Första riktningen när man klickar på en kolumn: tal och tid fallande, text stigande. */
export function firstDir(key: OrderSortKey): SortDir {
  return key === "tid" || key === "belopp" || key === "nr" ? "desc" : "asc";
}

/** Längsta sökning som används (resten kapas). */
export const MAX_QUERY_LENGTH = 100;
/** Flest sökord. Varje ord måste träffa något fält. */
export const MAX_TERMS = 6;

export interface OrderParams {
  /** Söktexten, trimmad och kapad. Tom sträng = ingen sökning. */
  readonly q: string;
  readonly titleId: string | null;
  readonly sort: OrderSort;
  /** Ordern som visas i detaljvyn, eller null. */
  readonly orderId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

function read(sp: URLSearchParams, name: string): string | null {
  const v = sp.get(name);
  return v === null ? null : v;
}

function isSortKey(v: string | null): v is OrderSortKey {
  return v !== null && (SORT_KEYS as readonly string[]).includes(v);
}

/** Söktexten som den används: blanktecken ihop, trimmad, högst MAX_QUERY_LENGTH tecken. */
export function cleanQuery(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH).trim();
}

/** Sökorden: unika, i ordning, högst MAX_TERMS. */
export function searchTerms(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cleanQuery(q).split(" ")) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

export function parseOrderParams(input: SearchParamsInput): OrderParams {
  const sp = toURLSearchParams(input);
  const title = read(sp, TITLE_PARAM);
  const sortRaw = read(sp, SORT_PARAM);
  const key: OrderSortKey = isSortKey(sortRaw) ? sortRaw : DEFAULT_SORT.key;
  const dirRaw = read(sp, DIR_PARAM);
  const dir: SortDir =
    dirRaw === "stigande" ? "asc" : dirRaw === "fallande" ? "desc" : firstDir(key);
  const order = read(sp, ORDER_PARAM);
  return {
    q: cleanQuery(read(sp, SEARCH_PARAM)),
    titleId: isUuid(title) ? title.toLowerCase() : null,
    sort: { key, dir },
    orderId: isUuid(order) ? order.toLowerCase() : null,
  };
}

export interface OrderParamsPatch {
  q?: string;
  titleId?: string | null;
  sort?: OrderSort | null;
  orderId?: string | null;
}

/**
 * Ny query med ändringarna. Övriga parametrar (skalets period och filter) lämnas orörda.
 * Standardvärden skrivs inte ut, så att länken blir kort.
 */
export function withOrderParams(
  current: SearchParamsInput,
  patch: OrderParamsPatch,
): URLSearchParams {
  const next = toURLSearchParams(current);
  if (patch.q !== undefined) {
    const q = cleanQuery(patch.q);
    if (q) next.set(SEARCH_PARAM, q);
    else next.delete(SEARCH_PARAM);
  }
  if (patch.titleId !== undefined) {
    if (patch.titleId && isUuid(patch.titleId)) next.set(TITLE_PARAM, patch.titleId);
    else next.delete(TITLE_PARAM);
  }
  if (patch.sort !== undefined) {
    next.delete(SORT_PARAM);
    next.delete(DIR_PARAM);
    const s = patch.sort;
    if (s && !(s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir)) {
      if (s.key !== DEFAULT_SORT.key) next.set(SORT_PARAM, s.key);
      if (s.dir !== firstDir(s.key)) next.set(DIR_PARAM, s.dir === "asc" ? "stigande" : "fallande");
    }
  }
  if (patch.orderId !== undefined) {
    if (patch.orderId && isUuid(patch.orderId)) next.set(ORDER_PARAM, patch.orderId);
    else next.delete(ORDER_PARAM);
  }
  return next;
}

/** Nyckel för listans innehåll: ändras den laddas listan om från början. */
export function listSignature(input: SearchParamsInput): string {
  const sp = toURLSearchParams(input);
  sp.delete(ORDER_PARAM);
  sp.sort();
  return sp.toString();
}

/**
 * Listans query med perioden låst till datum (?from=&to=), för påfyllningen: en relativ
 * period ("30d", "idag") räknas annars om vid varje sida och flyttar sig vid midnatt.
 */
export function lockedListQuery(
  input: SearchParamsInput,
  period: { readonly start: string; readonly end: string },
): string {
  const sp = toURLSearchParams(input);
  sp.delete(ORDER_PARAM);
  sp.delete(PERIOD_PARAM);
  sp.set(FROM_PARAM, period.start);
  sp.set(TO_PARAM, period.end);
  sp.sort();
  return sp.toString();
}

/** Sant när sökning eller titelfilter är satt (sidans egna filter, inte skalets). */
export function hasPageFilter(p: OrderParams): boolean {
  return p.q !== "" || p.titleId !== null;
}

/** Mönster för ILIKE (delsträng): %, _ och \ i söktexten matchar sig själva. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
