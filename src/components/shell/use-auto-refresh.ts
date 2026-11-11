"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** Omladdning vid fokus om senaste är äldre än så här. */
export const FOCUS_STALE_MS = 60_000;
/** Omladdning med jämna mellanrum medan sidan syns. */
export const INTERVAL_MS = 5 * 60_000;
/** Hur ofta timern tittar efter (en överhoppad omladdning görs vid nästa tick). */
const TICK_MS = 30_000;

type DocLike = {
  visibilityState: string;
  activeElement: Element | null;
  querySelector: (selector: string) => Element | null;
};

/** Sant när användaren skriver i ett fält eller har en dialog öppen. */
export function isBusy(doc: DocLike): boolean {
  // Egna dialoger (aria-modal) och webbläsarens <dialog> (ark och rutor i enkla vyn).
  if (doc.querySelector('[aria-modal="true"], dialog[open]')) return true;
  const el = doc.activeElement as (Element & { isContentEditable?: boolean }) | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Ska sidan laddas om nu? `reason` är "focus" (fliken blev synlig) eller
 * "interval" (5-minuterstimern).
 */
export function shouldRefresh(
  reason: "focus" | "interval",
  now: number,
  last: number,
  doc: DocLike,
): boolean {
  if (doc.visibilityState !== "visible") return false;
  const age = now - last;
  if (reason === "focus" ? age <= FOCUS_STALE_MS : age < INTERVAL_MS) return false;
  return !isBusy(doc);
}

/**
 * Hämtar serverdata på nytt (router.refresh) när fliken blir synlig efter mer än
 * 60 s, och var 5:e minut medan den syns. Hoppar över när man skriver i ett fält
 * eller har en dialog öppen.
 */
export function useAutoRefresh(enabled = true) {
  const router = useRouter();
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    last.current = Date.now();
    const run = (reason: "focus" | "interval") => {
      const now = Date.now();
      if (!shouldRefresh(reason, now, last.current, document)) return;
      last.current = now;
      router.refresh();
    };
    const onVisible = () => run("focus");
    const timer = window.setInterval(() => run("interval"), TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, router]);
}
