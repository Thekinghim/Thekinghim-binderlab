/**
 * Offscreen-dokumentet: tolkar Awish HTML med DOMParser åt service workern (som inte har
 * någon DOM). Tar bara emot meddelanden från tillägget självt och svarar med tabellerna,
 * länkarna och om sidan är en inloggningssida. Ingen data lämnar tillägget härifrån.
 */

import { chromeApi } from "./chrome.js";
import { extractDocument } from "./extract-dom.js";

chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { target?: string; type?: string; html?: unknown };
  if (m?.target !== "offscreen" || m.type !== "parse-html" || sender.id !== chromeApi.runtime.id) {
    return false;
  }
  try {
    const html = typeof m.html === "string" ? m.html : "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    sendResponse({ ok: true, page: extractDocument(doc) });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return false;
});
