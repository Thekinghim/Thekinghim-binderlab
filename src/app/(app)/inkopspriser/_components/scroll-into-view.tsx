"use client";

import { useEffect, useRef } from "react";

/**
 * Rullar fram sektionen `targetId` och flyttar fokus dit när en titel väljs i tabellen
 * (titleId byts), och en gång när sidan öppnats med en vald titel (t.ex. från Hem eller
 * Att göra). Uppdateringar av samma titel (nytt pris, annan period) flyttar ingenting.
 */
export function ScrollIntoView({
  targetId,
  titleId,
  active,
}: {
  targetId: string;
  titleId: string;
  active: boolean;
}) {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const first = shown.current === null;
    if (shown.current === titleId) return;
    shown.current = titleId;
    if (first && !active) return;
    const el = document.getElementById(targetId);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: first || reduce ? "auto" : "smooth" });
    if (!first) el.focus({ preventScroll: true });
  }, [targetId, titleId, active]);
  return null;
}
