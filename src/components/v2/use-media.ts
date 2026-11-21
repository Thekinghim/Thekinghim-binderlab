"use client";

import { useSyncExternalStore } from "react";

/**
 * Matchar mediefrågan? Falskt på servern och under hydreringen (sedan rätt värde direkt).
 * V2: telefon = (max-width: 900px), samma brytpunkt som skalets bottenrad.
 */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Telefonens brytpunkt i V2 (bottenraden visas, sidomenyn döljs). */
export const PHONE_QUERY = "(max-width: 900px)";

export function usePhone(): boolean {
  return useMedia(PHONE_QUERY);
}
