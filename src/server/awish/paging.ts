/**
 * Vilka sidor av Awish orderlista (Orders, sidnummer + per_page) som en synk
 * läser. Ren logik utan nätverk och databas, så att den kan testas för sig.
 *
 * Ordningen i svaret är inte dokumenterad. Den avgörs vid varje körning: id på
 * första och sista ordern på sidan 1 (och vid behov första ordern på sista
 * sidan). "desc" = nyast först (sida 1 är nyast), "asc" = äldst först (sista
 * sidan är nyast). Uppgifterna nedan räknar alltid "från den nya änden".
 *
 * En körning läser:
 * 1. Huvudet: från den nya änden tills både (a) en order med id ≤ det högsta
 *    redan importerade id:t har setts och (b) en order som är äldre än ett dygn
 *    har setts. (b) gör att obetalda order från det senaste dygnet läses om
 *    varje gång, så att en sen betalning inte missas. Är källan tom gäller bara (b).
 * 2. Glapp: tog sidbudgeten slut innan huvudet nådde redan importerade order
 *    (lång driftpaus) sparas var läsningen slutade, och nästa körning fortsätter
 *    där tills den når det id som var högst när glappet uppstod. Flera glapp i
 *    rad (två långa pauser) sparas var för sig, nyast först.
 * 3. Historiken: första gången läses hela listan bakåt till den äldsta ordern,
 *    högst `maxPages` sidor per körning, och läget sparas så att nästa körning
 *    fortsätter.
 *
 * I "desc" flyttas äldre order till högre sidnummer när nya kommer till. En
 * sparad sida läses då om med några redan sedda order först, men inget hoppas
 * över. I "asc" ligger gamla order kvar på samma sida.
 *
 * Antalet sidor: last_page, annars total / per_page. Alla dessa fält är valfria i
 * proto-filen. Skickar servern inget av dem (eller 0) gäller has_more, och annars
 * att en sida som inte är full (eller tom) är den sista. I "asc" behövs sista
 * sidan; den letas då upp med en sökning (dubblering, sedan halvering).
 */

import { latestInstantOf, type AwishGrpcOrder } from "@/import/adapters/awish-grpc";

export type PageOrder = "desc" | "asc";

export interface OrdersPage {
  items: AwishGrpcOrder[];
  total: number | null;
  perPage: number | null;
  lastPage: number | null;
  /** has_more om servern skickar det. */
  hasMore?: boolean | null;
}

export interface SyncGap {
  page: number;
  stopAtId: string;
}

/** Högst så många glapp sparas; fler slås ihop (det äldsta stoppet behålls). */
export const MAX_GAPS = 10;

export interface SyncCursor {
  v: 1;
  /** Senast upptäckta ordning. */
  order: PageOrder | null;
  /** Glapp efter långa pauser, nyast först: sida att fortsätta på och id att stanna vid. */
  gaps: SyncGap[];
  /** Hela historiken: sida att fortsätta på (null = inte påbörjad). */
  history: { page: number } | null;
  historyDone: boolean;
}

export const EMPTY_CURSOR: SyncCursor = {
  v: 1,
  order: null,
  gaps: [],
  history: null,
  historyDone: false,
};

/** Lagrat läge (data_sources.config.awishGrpc.cursor) → SyncCursor, tåligt mot skräp. */
export function parseCursor(value: unknown): SyncCursor {
  if (!value || typeof value !== "object") return { ...EMPTY_CURSOR };
  const v = value as Record<string, unknown>;
  const order = v.order === "desc" || v.order === "asc" ? v.order : null;
  const pageOf = (x: unknown): number | null =>
    typeof x === "number" && Number.isSafeInteger(x) && x >= 1 ? x : null;
  const gapOf = (x: unknown): SyncGap | null => {
    if (!x || typeof x !== "object") return null;
    const g = x as Record<string, unknown>;
    const page = pageOf(g.page);
    return page !== null && typeof g.stopAtId === "string" && /^\d{1,30}$/.test(g.stopAtId)
      ? { page, stopAtId: g.stopAtId }
      : null;
  };
  // Äldre läge hade ett enda glapp (`gap`).
  const gapList = Array.isArray(v.gaps) ? v.gaps : v.gap ? [v.gap] : [];
  const gaps = gapList
    .map(gapOf)
    .filter((g): g is SyncGap => g !== null)
    .slice(0, MAX_GAPS);
  const histRaw = (v.history ?? null) as Record<string, unknown> | null;
  const histPage = histRaw ? pageOf(histRaw.page) : null;
  return {
    v: 1,
    order,
    gaps,
    history: histPage === null ? null : { page: histPage },
    historyDone: v.historyDone === true,
  };
}

function idOf(text: string): bigint | null {
  return /^\d{1,30}$/.test(text) ? BigInt(text) : null;
}

/** Ordningen på en sida: första mot sista id. null = går inte att avgöra. */
export function detectOrder(items: readonly Pick<AwishGrpcOrder, "id">[]): PageOrder | null {
  if (items.length < 2) return null;
  const first = idOf(items[0]?.id ?? "");
  const last = idOf(items[items.length - 1]?.id ?? "");
  if (first === null || last === null || first === last) return null;
  return first > last ? "desc" : "asc";
}

export interface CollectOptions {
  fetchPage: (page: number) => Promise<OrdersPage>;
  cursor: SyncCursor;
  /** Högsta redan importerade Awish-id i datakällan (null = inga order än). */
  maxKnownId: string | null;
  now: Date;
  sourceTimezone: string;
  /** Högst så många anrop till Orders per körning. */
  maxPages: number;
  /** Bevaka så här långt bakåt (sena betalningar). Standard ett dygn. */
  lookbackMs?: number;
  /** Klockslag (ms) då inga fler sidor hämtas. */
  deadlineAt?: number;
  clock?: () => number;
  /** Fel från fetchPage som betyder "tiden är slut" (stoppar som budgeten, inte som fel). */
  isOutOfTime?: (error: unknown) => boolean;
}

export interface CollectResult {
  orders: AwishGrpcOrder[];
  pages: number;
  cursor: SyncCursor;
  order: PageOrder;
  total: number | null;
  /** Huvudet nådde redan importerade order (eller listan tog slut). */
  headComplete: boolean;
  /** Stoppades av sidbudgeten eller tidsgränsen. */
  budgetExhausted: boolean;
  /** Vilka sidfält servern skickade på sida 1 (för felsökning, sparas i läget). */
  pagingFields: string[];
}

export const DAY_MS = 86_400_000;

/**
 * Hämtar sidorna enligt reglerna ovan och returnerar alla order som sågs (en per
 * id, senast hämtade versionen) och nästa läge.
 */
export async function collectOrders(opts: CollectOptions): Promise<CollectResult> {
  const clock = opts.clock ?? Date.now;
  const lookback = opts.lookbackMs ?? DAY_MS;
  const oldBefore = opts.now.getTime() - lookback;
  const maxKnown = opts.maxKnownId === null ? null : idOf(opts.maxKnownId);
  const cache = new Map<number, OrdersPage>();
  const seen = new Map<string, AwishGrpcOrder>();
  let fetched = 0;
  let exhausted = false;

  const canFetch = (): boolean => {
    if (fetched >= opts.maxPages) return false;
    if (opts.deadlineAt !== undefined && clock() >= opts.deadlineAt) return false;
    return true;
  };
  const get = async (page: number): Promise<OrdersPage | null> => {
    const hit = cache.get(page);
    if (hit) return hit;
    if (!canFetch()) {
      exhausted = true;
      return null;
    }
    fetched += 1;
    let res: OrdersPage;
    try {
      res = await opts.fetchPage(page);
    } catch (error) {
      if (opts.isOutOfTime?.(error)) {
        exhausted = true;
        return null;
      }
      throw error;
    }
    cache.set(page, res);
    for (const o of res.items) seen.set(o.id, o);
    return res;
  };

  const first = await get(1);
  if (!first) {
    return {
      orders: [],
      pages: 0,
      cursor: opts.cursor,
      order: opts.cursor.order ?? "desc",
      total: null,
      headComplete: false,
      budgetExhausted: true,
      pagingFields: [],
    };
  }
  const pagingFields = [
    first.total !== null ? "total" : null,
    first.perPage !== null ? "per_page" : null,
    first.lastPage !== null ? "last_page" : null,
    first.hasMore !== undefined && first.hasMore !== null ? "has_more" : null,
  ].filter((f): f is string => f !== null);
  const perPage = first.perPage && first.perPage > 0 ? first.perPage : first.items.length || 1;
  /** Sista sidan enligt last_page eller total; null = servern skickade inget användbart. */
  const declared =
    first.lastPage !== null && first.lastPage > 0
      ? first.lastPage
      : first.total !== null && first.total > 0
        ? Math.ceil(first.total / perPage)
        : null;
  /** Är sidan den sista (bara när servern inte talar om antalet sidor)? */
  const endsHere = (res: OrdersPage): boolean =>
    declared === null &&
    (res.items.length === 0 || res.hasMore === false || res.items.length < perPage);

  let lastPage: number | null = declared ?? (endsHere(first) ? 1 : null);

  /** Sista sidan när servern inte anger den: dubblera tills slutet, halvera sedan. */
  const findLastPage = async (): Promise<number | null> => {
    let lo = 1;
    let hi: number | null = null;
    for (let probe = 2; hi === null; probe *= 2) {
      const res = await get(probe);
      if (!res) return null;
      if (res.items.length === 0) hi = probe;
      else if (endsHere(res)) return probe;
      else lo = probe;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const res = await get(mid);
      if (!res) return null;
      if (res.items.length === 0) hi = mid;
      else if (endsHere(res)) return mid;
      else lo = mid;
    }
    return lo;
  };

  // Ordningen: sida 1, annars sida 1 mot sista sidan, annars det sparade.
  let order = detectOrder(first.items);
  if (order === null && lastPage !== null && lastPage > 1) {
    const tail = await get(lastPage);
    const a = idOf(first.items[0]?.id ?? "");
    const b = idOf(tail?.items[0]?.id ?? "");
    if (a !== null && b !== null && a !== b) order = a > b ? "desc" : "asc";
  }
  order = order ?? opts.cursor.order ?? "desc";
  const cursor: SyncCursor = { ...opts.cursor, order, gaps: [...opts.cursor.gaps] };
  if (opts.cursor.order !== null && opts.cursor.order !== order) {
    // Ordningen har bytts: sparade sidnummer gäller inte längre.
    cursor.gaps = [];
    cursor.history = null;
  }
  if (order === "asc" && lastPage === null) {
    lastPage = await findLastPage();
    if (lastPage === null) {
      // Tiden eller budgeten tog slut under sökningen: inget läge ändras.
      return {
        orders: [...seen.values()],
        pages: fetched,
        cursor: { ...opts.cursor, order },
        order,
        total: first.total,
        headComplete: false,
        budgetExhausted: true,
        pagingFields,
      };
    }
  }
  const last = lastPage;

  /** Sida nummer i från den nya änden → absolut sidnummer. */
  const absolute = (i: number): number => (order === "desc" || last === null ? i : last - i + 1);
  /** Ett steg mot den gamla änden. */
  const older = (page: number): number => (order === "desc" ? page + 1 : page - 1);
  const inRange = (page: number): boolean => page >= 1 && (last === null || page <= last);
  /** Är `page` (med svaret `res`) den äldsta änden av listan? */
  const atOldEnd = (page: number, res: OrdersPage): boolean =>
    order === "desc" ? endsHere(res) || !inRange(page + 1) : page <= 1;

  const isKnown = (o: AwishGrpcOrder): boolean => {
    if (maxKnown === null) return true;
    const id = idOf(o.id);
    return id !== null && id <= maxKnown;
  };
  const isOld = (o: AwishGrpcOrder): boolean => {
    const t = latestInstantOf(o, opts.sourceTimezone);
    return t === null || t.getTime() < oldBefore;
  };

  // 1. Huvudet.
  const pending = cursor.gaps.length > 0 || !cursor.historyDone;
  const headCap = pending
    ? Math.max(1, opts.maxPages - Math.ceil(opts.maxPages / 5))
    : opts.maxPages;
  let reachedKnown = false;
  let reachedOld = false;
  let headComplete = false;
  let headNext: number | null = null;
  if (first.items.length === 0 && (first.total ?? 0) === 0) {
    headComplete = true;
  } else {
    for (let i = 1; ; i += 1) {
      const page = absolute(i);
      if (!inRange(page)) {
        headComplete = true;
        break;
      }
      // Huvudet lämnar en femtedel av budgeten åt glappet och historiken.
      if (fetched >= headCap && !cache.has(page)) {
        headNext = page;
        break;
      }
      const res = await get(page);
      if (!res) {
        headNext = page;
        break;
      }
      if (res.items.length === 0) {
        headComplete = true;
        break;
      }
      for (const o of res.items) {
        if (isKnown(o)) reachedKnown = true;
        if (isOld(o)) reachedOld = true;
      }
      if (reachedKnown && reachedOld) {
        headComplete = true;
        headNext = atOldEnd(page, res) ? null : older(page);
        break;
      }
      if (atOldEnd(page, res)) {
        headComplete = true;
        break;
      }
    }
  }
  if (!headComplete && !reachedKnown && headNext !== null && opts.maxKnownId !== null) {
    // Nytt glapp: från där huvudet slutade ned till det högsta id som fanns före
    // pausen. Ett äldre glapp ligger kvar (det täcker id under det här stoppet).
    cursor.gaps = [{ page: headNext, stopAtId: opts.maxKnownId }, ...cursor.gaps];
    while (cursor.gaps.length > MAX_GAPS) {
      // Slå ihop de två äldsta: börja på det nyares sida, stanna vid det äldres stopp.
      const older2 = cursor.gaps.pop()!;
      const newer = cursor.gaps.pop()!;
      cursor.gaps.push({ page: newer.page, stopAtId: older2.stopAtId });
    }
  }

  // 2. Glappet, 3. historiken.
  const walk = async (
    start: number,
    stop: (o: AwishGrpcOrder) => boolean,
  ): Promise<{ done: boolean; next: number }> => {
    let page = start;
    for (;;) {
      if (!inRange(page)) return { done: true, next: page };
      const res = await get(page);
      if (!res) return { done: false, next: page };
      if (res.items.length === 0) return { done: true, next: page };
      if (res.items.some(stop)) return { done: true, next: page };
      if (atOldEnd(page, res)) return { done: true, next: page };
      page = older(page);
    }
  };

  const gaps: SyncGap[] = [];
  for (const gap of cursor.gaps) {
    if (exhausted) {
      gaps.push(gap);
      continue;
    }
    const stopAt = idOf(gap.stopAtId);
    const r = await walk(gap.page, (o) => {
      const id = idOf(o.id);
      return stopAt !== null && id !== null && id <= stopAt;
    });
    if (!r.done) gaps.push({ ...gap, page: r.next });
  }
  cursor.gaps = gaps;
  if (!cursor.historyDone && !exhausted) {
    const start = cursor.history?.page ?? headNext ?? (headComplete ? null : absolute(1));
    if (start === null) {
      cursor.history = null;
      cursor.historyDone = true;
    } else {
      const r = await walk(start, () => false);
      if (r.done) {
        cursor.history = null;
        cursor.historyDone = true;
      } else {
        cursor.history = { page: r.next };
      }
    }
  }

  return {
    orders: [...seen.values()],
    pages: fetched,
    cursor,
    order,
    total: first.total,
    headComplete,
    budgetExhausted: exhausted,
    pagingFields,
  };
}
