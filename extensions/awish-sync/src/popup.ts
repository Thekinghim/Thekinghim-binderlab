/**
 * Popupen (och inställningssidan): Binderlab-adress och token, status och knapparna
 * "Synka nu" och "Läs hela historiken igen". Pratar bara med tilläggets service worker.
 */

import { chromeApi } from "./chrome.js";
import type { SyncState } from "./sync.js";

const chrome = chromeApi;

interface Snapshot {
  state: SyncState;
  settings: { binderlabUrl: string; tokenPrefix: string } | null;
  running: boolean;
  version: string;
  awishOrigin: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function when(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? dateFormat.format(d) : "–";
}

function int(n: number): string {
  return new Intl.NumberFormat("sv-SE").format(n);
}

let snapshot: Snapshot | null = null;
let filledUrl = false;

function render(s: Snapshot): void {
  snapshot = s;
  const st = s.state;
  const banner = $("banner");
  const awishHost = new URL(s.awishOrigin).host;
  banner.hidden = true;
  banner.dataset.tone = "";
  if (!s.settings) {
    banner.hidden = false;
    banner.dataset.tone = "neutral";
    banner.textContent =
      "Klistra in Binderlabs adress och en token från Datakällor i Binderlab för att börja.";
  } else if (st.tokenInvalid) {
    banner.hidden = false;
    banner.textContent = `Binderlab nekar token: ${st.lastError ?? "ogiltig eller återkallad"} Skapa en ny under Datakällor och klistra in den här.`;
  } else if (st.loggedOut) {
    banner.hidden = false;
    banner.innerHTML = "";
    banner.append(`Logga in på ${awishHost} i Chrome så fortsätter synken. `);
    const a = document.createElement("a");
    a.href = `${s.awishOrigin}/`;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = `Öppna ${awishHost}`;
    banner.append(a);
  } else if (st.lastRun?.source === "tab" && !st.lastError) {
    banner.hidden = false;
    banner.dataset.tone = "neutral";
    banner.textContent = `Awish läses ur den öppna fliken med orderlistan: bara de senaste ordrarna, inte hela historiken. Låt fliken med ${awishHost} vara öppen.`;
  }

  $("headline").textContent = s.running
    ? st.full?.active
      ? "Läser hela historiken …"
      : "Synkar …"
    : st.loggedOut
      ? "Utloggad från Awish"
      : st.lastError
        ? "Synken har problem"
        : st.lastSuccessAt
          ? "Synken är igång"
          : "Automatisk synk";
  $("last-success").textContent = when(st.lastSuccessAt);
  const run = st.lastRun;
  $("last-run").textContent = run
    ? `${when(run.finishedAt)} · ${int(run.pagesRead)} ${run.pagesRead === 1 ? "sida" : "sidor"}, ${int(run.rowsSent)} skickade`
    : "–";
  $("new-orders").textContent = run
    ? `${int(run.newOrders)} senast · ${int(st.totals.newOrders)} totalt`
    : "–";
  $("source").textContent =
    run?.source === "tab"
      ? "Öppen Awish-flik (bara senaste sidan)"
      : st.awish.api
        ? `JSON (${st.awish.apiSource === "discovered" ? "panelens API" : "XHR"})`
        : run?.source === "html"
          ? "HTML-tabellen"
          : "–";
  $("data-source").textContent = st.dataSourceName
    ? `${st.dataSourceName}${st.binderlabOrders !== null ? ` · ${int(st.binderlabOrders)} order` : ""}`
    : "–";
  $("error").textContent = st.lastError && !st.loggedOut ? st.lastError : "Inga";

  const history = $("history");
  if (st.full?.active) {
    history.hidden = false;
    history.textContent = `Hela historiken: sida ${int(st.full.nextPage)}${st.full.lastPage ? ` av ${int(st.full.lastPage)}` : ""} · ${int(st.full.rowsSent)} rader skickade. En sida i sekunden; fortsätter av sig själv.`;
  } else {
    history.hidden = true;
  }

  ($("sync-now") as HTMLButtonElement).disabled = s.running || !s.settings;
  ($("full-resync") as HTMLButtonElement).disabled = s.running || !s.settings;
  if (s.settings && !filledUrl) {
    ($("binderlab-url") as HTMLInputElement).value = s.settings.binderlabUrl;
    ($("token") as HTMLInputElement).placeholder = `${s.settings.tokenPrefix} (sparad)`;
    filledUrl = true;
  }
  $("version").textContent = s.version;
  $("awish-origin").textContent = awishHost;
}

async function refresh(): Promise<void> {
  const s = await chrome.runtime.sendMessage<Snapshot | null>({ type: "get-state" });
  if (s) render(s);
}

chrome.runtime.onMessage.addListener((message) => {
  const m = message as { type?: string; state?: SyncState };
  if (m?.type === "state-changed" && m.state && snapshot) {
    render({ ...snapshot, state: m.state, running: true });
    void refresh();
  }
  return false;
});

$("sync-now").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "sync-now" });
  if (snapshot) render({ ...snapshot, running: true });
});

const FIELD_LABELS: Record<string, string> = {
  externalId: "Ordernummer",
  title: "Produkt",
  machine: "Automat",
  amount: "Belopp",
  isPaid: "Betald",
  paidAt: "Betaltid",
  paymentMethod: "Betalsätt",
  rowId: "ID",
  orderDate: "Datum",
};

interface Diagnosis {
  ok: boolean;
  error?: string;
  kind?: string;
  mode?: string;
  path?: string;
  api?: string | null;
  columns?: Record<string, string>;
  seen?: number;
  skipped?: number;
  hasMore?: boolean;
  lastPage?: number | null;
  sample?: Array<Record<string, string>>;
}

function describeDiagnosis(d: Diagnosis): string {
  if (!d.ok) return `Fel (${d.kind ?? "okänt"}): ${d.error ?? ""}`;
  const mode = d.mode === "json" ? "JSON-API" : d.mode === "tab" ? "öppen flik" : "HTML-tabellen";
  const lines = [
    `Läser via: ${mode} · ${d.path ?? "–"}`,
    `Rader på sida 1: ${d.seen ?? 0}${d.skipped ? ` (${d.skipped} utan ordernummer)` : ""}`,
    `Fler sidor: ${d.hasMore ? "ja" : "nej"}${d.lastPage ? ` · sista sidan ${d.lastPage}` : ""}`,
    "",
    "Kolumner:",
    ...Object.entries(d.columns ?? {}).map(
      ([field, name]) => `  ${FIELD_LABELS[field] ?? field} ← ${name}`,
    ),
  ];
  if (d.sample && d.sample.length > 0) {
    lines.push("", "Första raderna:");
    for (const r of d.sample) {
      lines.push(
        `  ${r.externalId} · ${r.title} · ${r.machine} · ${r.amount} · ${r.isPaid} · ${r.paidAt}`,
      );
    }
  }
  return lines.join("\n");
}

$("diagnose").addEventListener("click", async () => {
  const out = $("diagnosis");
  const button = $("diagnose") as HTMLButtonElement;
  out.hidden = false;
  out.textContent = "Läser första sidan i Awish …";
  button.disabled = true;
  try {
    const d = await chrome.runtime.sendMessage<Diagnosis | null>({ type: "diagnose" });
    out.textContent = d ? describeDiagnosis(d) : "Inget svar från tillägget.";
  } finally {
    button.disabled = false;
  }
});

$("full-resync").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "full-resync" });
  if (snapshot) render({ ...snapshot, running: true });
});

$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const saved = $("saved");
  const binderlabUrl = ($("binderlab-url") as HTMLInputElement).value.trim();
  const tokenInput = $("token") as HTMLInputElement;
  const token = tokenInput.value.trim();
  if (!token && !snapshot?.settings) {
    saved.textContent = "Klistra in en token.";
    return;
  }
  let origin = "";
  try {
    origin = new URL(binderlabUrl).origin;
  } catch {
    saved.textContent = "Adressen är inte giltig.";
    return;
  }
  // Behörighet för Binderlabs adress (valfri: utan den går anropen via CORS, som
  // Binderlab tillåter för chrome-extension://). Väntar inte på svaret.
  try {
    chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => undefined);
  } catch {
    // Behörigheten är inte nödvändig.
  }
  const result = await chrome.runtime.sendMessage<{ ok: boolean; error?: string }>({
    type: "save-settings",
    binderlabUrl,
    token: token || "__keep__",
  });
  if (result?.ok) {
    saved.textContent = "Sparat. Synken startar.";
    tokenInput.value = "";
    filledUrl = false;
    await refresh();
  } else {
    saved.textContent = result?.error ?? "Kunde inte spara.";
  }
});

void refresh();
setInterval(() => void refresh(), 2000);
