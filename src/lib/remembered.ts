"use client";

/**
 * Ett val som webbläsaren minns per användare (localStorage), t.ex. senaste lagret vid
 * inköp eller påfyllning. Bara en bekvämlighet: utan lagring (privat läge, blockerad
 * webbplatsdata) blir värdet null och sidan fungerar ändå.
 */

import { useCallback, useSyncExternalStore } from "react";

const EVENT = "binderlab:remembered";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** Nyckeln för ett val: per organisation och användare. */
export function rememberKey(scope: string, what: string): string {
  return `binderlab:${what}:${scope}`;
}

export function useRemembered(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const set = useCallback(
    (next: string | null) => {
      try {
        if (next === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, next);
      } catch {
        // Utan lagring: valet glöms, inget annat händer.
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, set];
}
