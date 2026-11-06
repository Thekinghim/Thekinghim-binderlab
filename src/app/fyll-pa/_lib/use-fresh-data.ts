"use client";

/**
 * Håller Fyll på färsk utan att appen behöver stängas.
 *
 * Den installerade appen på iPhone laddas inte om när man går tillbaka till den: iOS visar
 * samma sida ur minnet (eller ur bfcache, "pageshow" med persisted), och datan är den som
 * hämtades när sidan först öppnades. Byte mellan listan och en automat sker i webbläsaren
 * (history.pushState) och hämtar inget från servern. Visar service workern en sparad sida
 * (nätet svarade inte inom 4 s) är datan dessutom från förra besöket.
 *
 * Därför hämtas datan om (router.refresh, högst var 30:e sekund) när sidan blir synlig igen,
 * får fokus, visas ur bfcache eller nätet kommer tillbaka, och direkt vid start om sidan
 * renderades för mer än 30 sekunder sedan (en sparad sida). Kön skickas samtidigt.
 */

import { useEffect, useRef } from "react";

import { autoRefreshDue } from "./refresh";

export function useFreshData({
  renderedAt,
  refresh,
}: {
  /** När servern renderade datan (ISO). Ändras vid varje ny hämtning. */
  renderedAt: string;
  /** Hämtar om datan (router.refresh) och skickar kön. */
  refresh: () => void;
}): void {
  const last = useRef(0);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  // Ny data från servern räknas som en hämtning.
  useEffect(() => {
    last.current = Date.now();
  }, [renderedAt]);

  useEffect(() => {
    const maybe = () => {
      if (document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const now = Date.now();
      if (!autoRefreshDue(last.current, now)) return;
      last.current = now;
      refreshRef.current();
    };
    // En sparad sida (service workern utan svar i tid) eller en sida ur bfcache: datan är gammal.
    const rendered = Date.parse(renderedAt);
    if (Number.isFinite(rendered)) last.current = Math.min(last.current, rendered);
    maybe();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) last.current = 0;
      maybe();
    };
    document.addEventListener("visibilitychange", maybe);
    window.addEventListener("focus", maybe);
    window.addEventListener("online", maybe);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", maybe);
      window.removeEventListener("focus", maybe);
      window.removeEventListener("online", maybe);
      window.removeEventListener("pageshow", onPageShow);
    };
    // Lyssnarna sätts en gång; renderedAt läses bara vid start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
