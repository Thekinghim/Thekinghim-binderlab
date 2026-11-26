/**
 * Rådgivarens förslag per sida i webbläsaren: hämtas med GET /assistent/tips (inte en server
 * action, som köar bakom sidans egna anrop) och först efter första trycket, när webbläsaren
 * har tid över. Förslagen syns ändå långt innan någon hunnit läsa sidan.
 */

import type { PageTip, TipRoute } from "@/server/assistant/page-tips";

export type PageTips = Partial<Record<TipRoute, PageTip>>;

/** Förslagen, eller inga vid fel (förslagen får aldrig stoppa något). */
export async function fetchPageTips(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PageTips> {
  try {
    const res = await fetcher("/assistent/tips", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return {};
    const data: unknown = await res.json();
    return data && typeof data === "object" && !Array.isArray(data) ? (data as PageTips) : {};
  } catch {
    return {};
  }
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

const INTERACTIONS = ["pointerdown", "keydown", "scroll"] as const;

/**
 * Kör `run` en gång: efter första trycket, tangenten eller rullningen, när webbläsaren har tid
 * över (requestIdleCallback, högst `timeoutMs` senare). Ingen interaktion: efter `fallbackMs`
 * ändå. Returnerar en funktion som avbryter.
 */
export function whenIdleAfterInteraction(
  run: () => void,
  { timeoutMs = 2_000, fallbackMs = 8_000 }: { timeoutMs?: number; fallbackMs?: number } = {},
  w: IdleWindow = window,
): () => void {
  let done = false;
  let idle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fallback = setTimeout(() => schedule(), fallbackMs);

  function cleanupListeners() {
    for (const type of INTERACTIONS) w.removeEventListener(type, schedule, { capture: true });
  }

  function schedule() {
    if (done || idle !== null || timer !== null) return;
    cleanupListeners();
    clearTimeout(fallback);
    const go = () => {
      if (done) return;
      done = true;
      run();
    };
    if (w.requestIdleCallback) idle = w.requestIdleCallback(go, { timeout: timeoutMs });
    else timer = setTimeout(go, 200);
  }

  for (const type of INTERACTIONS) {
    w.addEventListener(type, schedule, { once: true, passive: true, capture: true });
  }

  return () => {
    done = true;
    cleanupListeners();
    clearTimeout(fallback);
    if (timer !== null) clearTimeout(timer);
    if (idle !== null) w.cancelIdleCallback?.(idle);
  };
}
