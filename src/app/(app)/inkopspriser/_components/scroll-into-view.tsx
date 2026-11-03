"use client";

import { useEffect, useRef } from "react";

/** Prisfältet i formuläret (PriceForm). */
const PRICE_INPUT = 'input[name="unitCost"]';

/**
 * Rullar fram `targetId` överst i vyn och sätter markören i prisfältet (eller i blocket,
 * när man inte får ändra). `focus: false` rullar bara, så att mobilens tangentbord inte
 * fälls upp när sidan öppnas.
 */
export function revealEditor(targetId: string, { focus = true, smooth = true } = {}) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "start", behavior: smooth && !reduce ? "smooth" : "auto" });
  if (!focus) return;
  const input = el.querySelector<HTMLInputElement>(PRICE_INPUT);
  (input ?? el).focus({ preventScroll: true });
}

/**
 * Visar prisredigeraren när en titel väljs i tabellen (titleId byts), och en gång när
 * sidan öppnats med en vald titel (t.ex. från Hem eller Att göra). Uppdateringar av samma
 * titel (nytt pris, annan period) flyttar ingenting.
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
    revealEditor(targetId, { focus: !first, smooth: !first });
  }, [targetId, titleId, active]);
  return null;
}
