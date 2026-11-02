/**
 * Innehållsskript (isolerad värld) i Awish-panelen: tar emot adressen som ./discover.ts
 * hittade och lämnar den till tilläggets service worker. Bara meddelanden från samma
 * fönster och ursprung, med rätt form, skickas vidare.
 *
 * Klassiskt skript (inte modul): byggskriptet tar bort raden "export {}".
 */

(() => {
  const runtime = (globalThis as unknown as { chrome?: { runtime?: { sendMessage(m: unknown): Promise<unknown> } } })
    .chrome?.runtime;
  if (!runtime) return;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { source?: unknown; type?: unknown; url?: unknown } | null;
    if (!data || data.source !== "binderlab-awish-sync" || data.type !== "awish-api") return;
    if (typeof data.url !== "string" || data.url.length > 2000) return;
    runtime.sendMessage({ type: "awish-api", url: data.url }).catch(() => undefined);
  });
})();

export {};
