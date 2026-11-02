/**
 * Tilläggets service worker: alarmet var 10:e minut, meddelanden från popupen och
 * innehållsskripten, och HTML-tolkningen via offscreen-dokumentet.
 *
 * Läget (inställningar, synkens läge, hela historikens framsteg) sparas i
 * chrome.storage.local, så att en service worker som Chrome stängt fortsätter där den
 * slutade vid nästa alarm. Bara Awish-panelen och Binderlab-adressen anropas.
 */

import {
  ALARM_NAME,
  API_PROBE_INTERVAL_MS,
  AWISH_ORIGIN,
  AWISH_PAGE_SIZE,
  BATCH_SIZE,
  MAX_INCREMENTAL_PAGES,
  ORDERS_PATH,
  OVERLAP_PAGES,
  PAGE_DELAY_MS,
  SYNC_INTERVAL_MINUTES,
  VERSION,
} from "./config.js";
import { AwishReader } from "./awish.js";
import { extractDocument } from "./extract-dom.js";
import { normalizeBaseUrl } from "./binderlab.js";
import { chromeApi, type MessageSender } from "./chrome.js";
import { extractHtml } from "./extract-html.js";
import { isOrdersApiPath, ReaderError, type ExtractedPage } from "./reader.js";
import { initialState, runSync, type Settings, type SyncDeps, type SyncState } from "./sync.js";

const chrome = chromeApi;

async function loadSettings(): Promise<Settings | null> {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings as Partial<Settings> | undefined;
  return s?.binderlabUrl && s.token ? { binderlabUrl: s.binderlabUrl, token: s.token } : null;
}

async function loadState(): Promise<SyncState> {
  const { state } = await chrome.storage.local.get("state");
  return { ...initialState(), ...((state as Partial<SyncState> | undefined) ?? {}) };
}

async function saveState(state: SyncState): Promise<void> {
  await chrome.storage.local.set({ state });
}

// ---------------------------------------------------------------------------
// HTML via offscreen-dokumentet (DOMParser), med tokeniseraren som reserv.
// ---------------------------------------------------------------------------

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<boolean> {
  if (!chrome.offscreen) return false;
  const url = chrome.runtime.getURL("offscreen.html");
  const existing =
    (await chrome.runtime.getContexts?.({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    })) ?? [];
  if (existing.length > 0) return true;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Tolka Awish orderlista (HTML) för att läsa ordrarna.",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
  return true;
}

async function parseHtml(html: string): Promise<ExtractedPage> {
  try {
    if (await ensureOffscreen()) {
      const res = await chrome.runtime.sendMessage<{ ok: boolean; page?: ExtractedPage }>({
        target: "offscreen",
        type: "parse-html",
        html,
      });
      if (res?.ok && res.page) return res.page;
    }
  } catch {
    // Faller tillbaka på tokeniseraren nedan.
  }
  return extractHtml(html);
}

// ---------------------------------------------------------------------------
// Reserv: den färdigritade orderlistan i en öppen Awish-flik
// ---------------------------------------------------------------------------

/**
 * Läser orderlistan i en öppen flik på Awish (chrome.scripting, isolerad värld: bara
 * DOM:en läses, sidans skript och inloggning rörs inte). Bara flikar på Awish-panelens
 * orderlista; ingen flik öppnas eller laddas om.
 */
async function readOpenTab(): Promise<{ page: ExtractedPage; url: string } | null> {
  if (!chrome.scripting) return null;
  const tabs = await chrome.tabs.query({ url: `${AWISH_ORIGIN}/*` });
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    let url: URL;
    try {
      url = new URL(tab.url);
    } catch {
      continue;
    }
    if (url.origin !== AWISH_ORIGIN || !isOrdersApiPath(url.pathname, ORDERS_PATH)) continue;
    const [first] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractDocument as () => ExtractedPage,
    });
    if (first?.result) return { page: first.result, url: tab.url };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Synken
// ---------------------------------------------------------------------------

let running: Promise<SyncState> | null = null;
/**
 * Något ändrades medan en körning pågick (nya inställningar): kör en gång till efteråt.
 * "Läs hela historiken igen" sparas under en egen nyckel (fullRequested) i stället för i
 * läget, som den pågående körningen skriver över när den sparar.
 */
let rerun = false;

async function setBadge(state: SyncState): Promise<void> {
  const problem = state.loggedOut || state.tokenInvalid || Boolean(state.lastError);
  await chrome.action.setBadgeText({ text: problem ? "!" : state.full?.active ? "…" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: problem ? "#d9480f" : "#3b3b3b" });
  await chrome.action.setTitle({
    title: state.loggedOut
      ? "Binderlab: logga in på dash.awish.vip"
      : state.lastError
        ? `Binderlab: ${state.lastError}`
        : "Binderlab Awish-synk",
  });
}

function broadcast(state: SyncState): void {
  chrome.runtime.sendMessage({ type: "state-changed", state }).catch(() => undefined);
}

function deps(): SyncDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    parseHtml,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    awishOrigin: AWISH_ORIGIN,
    ordersPath: ORDERS_PATH,
    pageSize: AWISH_PAGE_SIZE,
    apiProbeIntervalMs: API_PROBE_INTERVAL_MS,
    readOpenTab,
    version: VERSION,
    pageDelayMs: PAGE_DELAY_MS,
    batchSize: BATCH_SIZE,
    overlapPages: OVERLAP_PAGES,
    maxIncrementalPages: MAX_INCREMENTAL_PAGES,
    saveState,
    onProgress: broadcast,
  };
}

async function sync(options: { full?: boolean } = {}): Promise<SyncState> {
  if (options.full) await chrome.storage.local.set({ fullRequested: true });
  if (running) {
    if (options.full) rerun = true;
    return running;
  }
  running = (async () => {
    const settings = await loadSettings();
    const state = await loadState();
    const { fullRequested } = await chrome.storage.local.get("fullRequested");
    const runOptions = fullRequested === true ? { ...options, full: true } : options;
    if (fullRequested === true) await chrome.storage.local.set({ fullRequested: false });
    // Ett JSON-API som panelen själv anropade (./discover.ts) används från nästa körning.
    const { discoveredApi } = await chrome.storage.local.get("discoveredApi");
    if (typeof discoveredApi === "string") {
      new AwishReader(deps(), state.awish).useDiscoveredApi(discoveredApi);
      await chrome.storage.local.set({ discoveredApi: null });
    }
    const next = await runSync(deps(), settings, state, runOptions);
    await saveState(next);
    await setBadge(next).catch(() => undefined);
    broadcast(next);
    return next;
  })().finally(() => {
    running = null;
    if (rerun) {
      rerun = false;
      void sync();
    }
  });
  return running;
}

/**
 * "Testa avläsningen": läser sida 1 i Awish som synken gör, men skickar ingenting till
 * Binderlab och sparar inget. Visar vad tillägget hittar (sätt, sökväg, kolumner, de
 * första raderna), för att kontrollera avläsningen mot den riktiga panelen.
 */
async function diagnose(): Promise<unknown> {
  const state = await loadState();
  const memory = structuredClone(state.awish);
  const { discoveredApi } = await chrome.storage.local.get("discoveredApi");
  const reader = new AwishReader(deps(), memory);
  if (typeof discoveredApi === "string") reader.useDiscoveredApi(discoveredApi);
  try {
    const read = await reader.readPage(1);
    return {
      ok: true,
      mode: read.mode,
      path: read.path,
      api: memory.api ? new URL(memory.api.url).pathname : null,
      columns: read.columns,
      seen: read.seen,
      skipped: read.skipped,
      hasMore: read.hasMore,
      lastPage: read.lastPage,
      sample: read.rows.slice(0, 3).map((r) => ({
        externalId: r.externalId,
        title: r.title,
        machine: r.machine,
        amount: r.amount,
        isPaid: r.isPaid,
        paidAt: r.paidAt,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      kind: error instanceof ReaderError ? error.kind : "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: SYNC_INTERVAL_MINUTES,
      delayInMinutes: 1,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void sync();
});

// ---------------------------------------------------------------------------
// Meddelanden
// ---------------------------------------------------------------------------

type Message =
  | { type: "get-state" }
  | { type: "sync-now" }
  | { type: "full-resync" }
  | { type: "diagnose" }
  | { type: "save-settings"; binderlabUrl: string; token: string }
  | { type: "awish-api"; url: string };

/** Popupen eller inställningssidan (tilläggets egna sidor, även öppnade i en flik). */
function fromExtension(sender: MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""))
  );
}

function fromAwishTab(sender: MessageSender): boolean {
  try {
    return (
      sender.id === chrome.runtime.id &&
      new URL(sender.url ?? sender.tab?.url ?? "").origin === AWISH_ORIGIN
    );
  } catch {
    return false;
  }
}

async function handle(message: Message, sender: MessageSender): Promise<unknown> {
  switch (message.type) {
    case "get-state": {
      if (!fromExtension(sender)) return null;
      const settings = await loadSettings();
      return {
        state: await loadState(),
        settings: settings
          ? { binderlabUrl: settings.binderlabUrl, tokenPrefix: `${settings.token.slice(0, 11)}…` }
          : null,
        running: running !== null,
        version: VERSION,
        awishOrigin: AWISH_ORIGIN,
      };
    }
    case "sync-now":
      if (!fromExtension(sender)) return null;
      void sync();
      return { ok: true };
    case "full-resync":
      if (!fromExtension(sender)) return null;
      void sync({ full: true });
      return { ok: true };
    case "diagnose":
      if (!fromExtension(sender)) return null;
      return diagnose();
    case "save-settings": {
      if (!fromExtension(sender)) return null;
      const binderlabUrl = normalizeBaseUrl(message.binderlabUrl);
      // "__keep__": bara adressen ändras, den sparade token behålls.
      const token =
        message.token === "__keep__" ? ((await loadSettings())?.token ?? "") : message.token.trim();
      if (!/^blsync_[A-Za-z0-9_-]{43}$/.test(token)) {
        return {
          ok: false,
          error: "Token har fel form. Kopiera den på nytt från Datakällor i Binderlab.",
        };
      }
      await chrome.storage.local.set({ settings: { binderlabUrl, token } });
      if (running) {
        // Den pågående körningen skriver över läget när den sparar: kör igen efteråt
        // (med de nya inställningarna), vilket också rättar flaggorna nedan.
        rerun = true;
        return { ok: true };
      }
      const state = await loadState();
      state.tokenInvalid = false;
      state.lastError = null;
      await saveState(state);
      void sync();
      return { ok: true };
    }
    case "awish-api": {
      if (!fromAwishTab(sender) || typeof message.url !== "string") return null;
      const discovered = new URL(message.url);
      if (discovered.origin !== AWISH_ORIGIN) return null;
      if (!isOrdersApiPath(discovered.pathname, ORDERS_PATH)) return null;
      await chrome.storage.local.set({ discoveredApi: message.url });
      return { ok: true };
    }
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { type?: unknown; target?: unknown };
  if (m?.target === "offscreen" || typeof m?.type !== "string" || m.type === "state-changed")
    return false;
  handle(message as Message, sender)
    .then(sendResponse)
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
});
