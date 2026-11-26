"use client";

import { describeThrown, type ClientErrorSource } from "@/lib/client-error";

import { loadedBuildId } from "./refresh-app";

/**
 * Skickar fel som telefonen eller webbläsaren själv kastade till POST /api/klientfel
 * (private.client_errors), så att det riktiga felet går att läsa utan skärmdumpar.
 *
 * - Varje fel skickas en gång (samma objekt från felrutan och från window räknas en gång).
 * - Fel som inte nådde någon felruta (window "error"/"unhandledrejection"): högst 5 per
 *   sidladdning. Allt som allt högst 20 per sidladdning, så att en loop aldrig spammar.
 * - Kastar aldrig: utan nät, utloggad eller med fel svar händer ingenting.
 */

const ENDPOINT = "/api/klientfel";
const MAX_WINDOW = 5;
const MAX_TOTAL = 20;

const seenObjects = new WeakSet<object>();
const seenText = new Set<string>();
let windowCount = 0;
let totalCount = 0;

/** Brus som inte säger något om appen (Safari och Chrome skickar dem i onödan). */
const IGNORED = [/ResizeObserver loop/i];

function firstTime(thrown: unknown, key: string): boolean {
  if (thrown && typeof thrown === "object") {
    if (seenObjects.has(thrown)) return false;
    seenObjects.add(thrown);
    return true;
  }
  if (seenText.has(key)) return false;
  seenText.add(key);
  return true;
}

function standalone(): boolean {
  try {
    return (
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  } catch {
    return false;
  }
}

/** Det som skickas (utan nätverk; används också av testerna). */
export function clientErrorPayload(
  thrown: unknown,
  source: ClientErrorSource,
  fallbackStack = "",
): Record<string, unknown> {
  const { message, stack, digest } = describeThrown(thrown);
  return {
    path: window.location.pathname,
    message,
    stack: stack || fallbackStack,
    digest,
    buildId: loadedBuildId(),
    userAgent: navigator.userAgent,
    extra: {
      source,
      online: navigator.onLine,
      standalone: standalone(),
      visibility: document.visibilityState,
    },
  };
}

/** Rapporterar felet en gång. Kastar aldrig och väntar aldrig på svaret. */
export function reportClientError(
  thrown: unknown,
  source: ClientErrorSource,
  fallbackStack = "",
): void {
  try {
    if (typeof window === "undefined") return;
    const payload = clientErrorPayload(thrown, source, fallbackStack);
    const message = String(payload.message);
    if (IGNORED.some((re) => re.test(message))) return;
    if (!firstTime(thrown, `${message}\n${String(payload.stack)}`)) return;
    if (totalCount >= MAX_TOTAL) return;
    if (source !== "boundary") {
      if (windowCount >= MAX_WINDOW) return;
      windowCount += 1;
    }
    totalCount += 1;
    void fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      cache: "no-store",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Rapporten får aldrig ge ett nytt fel.
  }
}

const VIEWPORT_KEY = "binderlab:vp-report";
let viewportLast: number | null = null;

/**
 * Skickar ViewportPins mått (se viewport-pin-telemetry.ts) som en rad i klientfelen, med
 * message "ViewportPin: <orsak>", raderna i stack och i extra.vp. `due` avgör om det är dags
 * (en gång per tio minuter, mätt i sessionStorage och i minnet). Kastar aldrig.
 */
export function reportViewportSample(
  reason: string,
  vp: { cols: string; screen: number; rows: string[] },
  due: (last: number | null, now: number) => boolean,
): void {
  try {
    if (typeof window === "undefined") return;
    const now = Date.now();
    let last = viewportLast;
    try {
      const raw = Number(window.sessionStorage.getItem(VIEWPORT_KEY));
      if (raw > 0 && (last === null || raw > last)) last = raw;
    } catch {
      // Utan sessionStorage gäller tiden i minnet.
    }
    if (!due(last, now)) return;
    viewportLast = now;
    try {
      window.sessionStorage.setItem(VIEWPORT_KEY, String(now));
    } catch {
      // Utan sessionStorage gäller tiden i minnet.
    }
    const payload = {
      path: window.location.pathname,
      message: `ViewportPin: ${reason.replace(/[^a-z0-9 -]/gi, "").slice(0, 40)}`,
      stack: [vp.cols, ...vp.rows].join("\n"),
      digest: null,
      buildId: loadedBuildId(),
      userAgent: navigator.userAgent,
      extra: {
        source: "viewport" satisfies ClientErrorSource,
        online: navigator.onLine,
        standalone: standalone(),
        visibility: document.visibilityState,
        vp,
      },
    };
    void fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      cache: "no-store",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Mätningen får aldrig ge ett fel.
  }
}

let listening = false;

/**
 * Lyssnar på fel som inte fångades av någon felruta (en gång per sidladdning). Anropas från
 * skalet (ClientErrorListener i src/components/shell/frame-root.tsx).
 */
export function listenForUncaughtErrors(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  try {
    window.addEventListener("error", (event: ErrorEvent) => {
      // Fel när en bild eller ett skript inte kunde hämtas har ingen message: de hoppas över.
      if (!event.error && !event.message) return;
      const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "";
      reportClientError(event.error ?? event.message, "error", where);
    });
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      reportClientError(event.reason, "unhandledrejection");
    });
  } catch {
    // Utan lyssnare fungerar appen som förut.
  }
}
