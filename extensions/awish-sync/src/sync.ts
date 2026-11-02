/**
 * Synken: Binderlabs status → Awish sidor (nyast först) → batcher till Binderlab.
 *
 * - Vanlig synk (var 10:e minut): läser från sida 1 tills den når ordernummer som
 *   Binderlab redan har (status-API:t) och en sida till (överlapp). Bara rader som
 *   Binderlab inte har skickas; en ej betald order skickas en gång, och igen när den
 *   blivit betald.
 * - Hela historiken (första gången, när Binderlab inte har några order, eller "Läs hela
 *   historiken igen"): alla sidor bakåt, en sida i sekunden. Läget sparas efter varje
 *   skickad batch, så att en avbruten läsning fortsätter där den slutade.
 * - Batcher om högst 200 rader. Återförsök med backoff ligger i ./binderlab.ts.
 * - Utloggad från Awish: inget läses, Binderlab får en rapport (som syns under
 *   Datakällor), och popupen visar "Logga in på dash.awish.vip i Chrome så fortsätter
 *   synken". Efter två timmar utan lyckad synk larmar Binderlab.
 *
 * Ren logik med beroenden utifrån (fetch, tolkning, klocka, lagring), så att den kan
 * testas utan Chrome (src/import/adapters/awish-extension-sync.test.ts).
 */

import { AwishReader, LOGGED_OUT_MESSAGE, type AwishDeps, type AwishMemory } from "./awish.js";
import { BinderlabClient, BinderlabError, type BatchResult, type Report } from "./binderlab.js";
import { ReaderError, type OrderRow } from "./reader.js";

export interface Settings {
  binderlabUrl: string;
  token: string;
}

export interface FullHistory {
  active: boolean;
  /** Nästa sida att läsa (allt före den är skickat). */
  nextPage: number;
  startedAt: string;
  pagesRead: number;
  rowsSent: number;
  lastPage: number | null;
}

export interface RunSummary {
  mode: "incremental" | "full";
  source: "json" | "html" | null;
  pagesRead: number;
  rowsSeen: number;
  rowsSent: number;
  newOrders: number;
  duplicates: number;
  errorRows: number;
  batches: number;
  finishedAt: string;
}

export interface SyncState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  loggedOut: boolean;
  tokenInvalid: boolean;
  lastRun: RunSummary | null;
  totals: { rowsSent: number; newOrders: number };
  full: FullHistory | null;
  /** Begärt av användaren ("Läs hela historiken igen"), startas vid nästa körning. */
  fullRequested: boolean;
  awish: AwishMemory;
  /** Ordernummer som skickats som ej betalda (de senaste 2 000). */
  sentUnpaid: string[];
  /** Datakällans namn i Binderlab (för popupen). */
  dataSourceName: string | null;
  binderlabOrders: number | null;
}

export function initialState(): SyncState {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    loggedOut: false,
    tokenInvalid: false,
    lastRun: null,
    totals: { rowsSent: 0, newOrders: 0 },
    full: null,
    fullRequested: false,
    awish: { api: null, apiSource: null, apiProbeFailedAt: null, htmlPageParam: null },
    sentUnpaid: [],
    dataSourceName: null,
    binderlabOrders: null,
  };
}

export interface SyncDeps extends Omit<AwishDeps, "fetch"> {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  version: string;
  pageDelayMs: number;
  batchSize: number;
  overlapPages: number;
  maxIncrementalPages: number;
  /** Sparar läget under körningen (efter varje batch). */
  saveState?: (state: SyncState) => Promise<void>;
  /** Anropas när något i läget ändrats (popupen uppdateras). */
  onProgress?: (state: SyncState) => void;
}

const MAX_CELL = 2000;

function isPaid(row: OrderRow): boolean {
  return /^\s*paid\s*success\s*$/i.test(row.isPaid) || /^(?:paid|success|betald|yes|true|1)$/i.test(row.isPaid.trim());
}

function trimRow(row: OrderRow): OrderRow {
  const cut = (v: string | null | undefined) => (typeof v === "string" ? v.slice(0, MAX_CELL) : v);
  return {
    ...row,
    externalId: row.externalId.slice(0, MAX_CELL),
    title: row.title.slice(0, MAX_CELL),
    machine: row.machine.slice(0, MAX_CELL),
    amount: row.amount.slice(0, MAX_CELL),
    isPaid: row.isPaid.slice(0, MAX_CELL),
    paidAt: row.paidAt.slice(0, MAX_CELL),
    paymentMethod: cut(row.paymentMethod),
    rowId: cut(row.rowId),
    orderDate: cut(row.orderDate),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * En körning. Returnerar nytt läge (kastar inte): fel hamnar i lastError, utloggning i
 * loggedOut och en ogiltig token i tokenInvalid.
 */
export async function runSync(
  deps: SyncDeps,
  settings: Settings | null,
  previous: SyncState,
  options: { full?: boolean } = {},
): Promise<SyncState> {
  const state: SyncState = structuredClone(previous);
  const now = () => deps.now().toISOString();
  state.lastRunAt = now();
  const progress = () => deps.onProgress?.(state);

  if (!settings?.binderlabUrl || !settings.token) {
    state.lastError = "Ange Binderlabs adress och token i tillägget.";
    return state;
  }
  let binder: BinderlabClient;
  try {
    binder = new BinderlabClient({ fetch: deps.fetch, sleep: deps.sleep, version: deps.version }, settings.binderlabUrl, settings.token);
  } catch (error) {
    state.lastError = errorText(error);
    return state;
  }

  // 1. Binderlab: vilka ordrar finns redan?
  let known: Set<string>;
  try {
    const status = await binder.status();
    known = new Set(status.orders.knownExternalIds);
    state.tokenInvalid = false;
    state.dataSourceName = status.dataSource.name;
    state.binderlabOrders = status.orders.count;
    if (status.orders.count === 0 && !state.full?.active) options = { ...options, full: true };
  } catch (error) {
    if (error instanceof BinderlabError && error.kind === "auth") state.tokenInvalid = true;
    state.lastError = errorText(error);
    return state;
  }

  const full = Boolean(options.full || state.fullRequested || state.full?.active);
  if (full && (!state.full?.active || options.full || state.fullRequested)) {
    state.full = { active: true, nextPage: 1, startedAt: now(), pagesRead: 0, rowsSent: 0, lastPage: null };
  }
  state.fullRequested = false;
  const reader = new AwishReader({ ...deps, fetch: deps.fetch }, state.awish);

  const summary: RunSummary = {
    mode: full ? "full" : "incremental",
    source: null,
    pagesRead: 0,
    rowsSeen: 0,
    rowsSent: 0,
    newOrders: 0,
    duplicates: 0,
    errorRows: 0,
    batches: 0,
    finishedAt: now(),
  };
  const unpaid = new Set(state.sentUnpaid);
  const seenThisRun = new Set<string>();
  let buffer: OrderRow[] = [];
  let absent = new Set<"paymentMethod">();
  let bufferedThroughPage = 0;

  const flush = async (report?: Report): Promise<void> => {
    if (buffer.length === 0) return;
    summary.batches += 1;
    const result: BatchResult = await binder.postBatch({
      rows: buffer.map(trimRow),
      absent: [...absent],
      batch: summary.batches,
      report,
    });
    summary.rowsSent += buffer.length;
    summary.newOrders += result.summary?.new ?? 0;
    summary.duplicates += result.summary?.duplicate ?? 0;
    summary.errorRows += result.summary?.error ?? 0;
    state.totals.rowsSent += buffer.length;
    state.totals.newOrders += result.summary?.new ?? 0;
    for (const r of buffer) {
      if (isPaid(r)) unpaid.delete(r.externalId);
      else unpaid.add(r.externalId);
    }
    state.sentUnpaid = [...unpaid].slice(-2000);
    if (state.full?.active) {
      state.full.nextPage = bufferedThroughPage + 1;
      state.full.rowsSent += buffer.length;
    }
    buffer = [];
    absent = new Set();
    await deps.saveState?.(state);
    progress();
  };

  const finish = (error: string | null): SyncState => {
    summary.finishedAt = now();
    state.lastRun = summary;
    state.lastError = error;
    if (!error) state.lastSuccessAt = now();
    progress();
    return state;
  };

  // 2. Awish: sida för sida, nyast först.
  let page = full ? (state.full?.nextPage ?? 1) : 1;
  let stopAfter: number | null = null;
  let previousIds = "";
  try {
    for (;;) {
      let read;
      for (let attempt = 0; ; attempt += 1) {
        try {
          read = await reader.readPage(page);
          break;
        } catch (error) {
          const transient = error instanceof ReaderError && (error.kind === "network" || error.kind === "http");
          if (!transient || attempt >= 2) throw error;
          await deps.sleep(5_000 * (attempt + 1));
        }
      }
      state.loggedOut = false;
      summary.source = read.mode;
      summary.pagesRead += 1;
      summary.rowsSeen += read.seen;
      if (state.full?.active) {
        state.full.pagesRead += 1;
        state.full.lastPage = read.lastPage ?? state.full.lastPage;
      }

      // Samma rader som förra sidan: panelen bryr sig inte om sidparametern. Sluta.
      const ids = read.rows.map((r) => r.externalId).join("|");
      if (page > 1 && ids !== "" && ids === previousIds) break;
      previousIds = ids;

      let reachedKnown = false;
      for (const row of read.rows) {
        if (seenThisRun.has(row.externalId)) continue;
        seenThisRun.add(row.externalId);
        const isKnown = known.has(row.externalId);
        if (isKnown) reachedKnown = true;
        if (!full) {
          if (isKnown) continue;
          if (!isPaid(row) && unpaid.has(row.externalId)) continue;
        }
        buffer.push(row);
      }
      for (const a of read.absent) absent.add(a);
      bufferedThroughPage = page;
      if (buffer.length >= deps.batchSize) await flush();
      else if (state.full?.active) progress();

      if (read.seen === 0 || !read.hasMore) break;
      if (!full) {
        if (reachedKnown && stopAfter === null) stopAfter = page + deps.overlapPages;
        if (stopAfter !== null && page >= stopAfter) break;
        if (page >= deps.maxIncrementalPages) break;
      }
      page += 1;
      await deps.sleep(deps.pageDelayMs);
    }

    // 3. Resten och en rapport om att synken gick bra (uppdaterar "senast synkad").
    const report: Report = {
      state: "ok",
      fullHistory: full,
      pagesRead: summary.pagesRead,
      rowsSeen: summary.rowsSeen,
      ...(summary.source ? { mode: summary.source } : {}),
    };
    await flush();
    await binder.postBatch({ rows: [], report });
    if (state.full?.active) state.full = null;
    return finish(null);
  } catch (error) {
    if (error instanceof ReaderError && error.kind === "logged_out") {
      state.loggedOut = true;
      try {
        await flush();
        await binder.postBatch({ rows: [], report: { state: "logged_out", message: LOGGED_OUT_MESSAGE } });
      } catch {
        // Rapporten är bara information; nästa körning försöker igen.
      }
      return finish(LOGGED_OUT_MESSAGE);
    }
    if (error instanceof BinderlabError && error.kind === "auth") {
      state.tokenInvalid = true;
      return finish(error.message);
    }
    const message = errorText(error);
    try {
      await flush();
      await binder.postBatch({ rows: [], report: { state: "error", message: message.slice(0, 500) } });
    } catch {
      // Binderlab nås inte: felet syns i popupen.
    }
    return finish(message);
  }
}
