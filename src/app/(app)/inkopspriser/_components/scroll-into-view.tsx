"use client";

import { useEffect } from "react";

/**
 * Rullar fram sektionen `targetId` en gång när sidan öppnats med en vald titel
 * (t.ex. från Hem eller Att göra), om adressen inte redan har ett ankare.
 */
export function ScrollIntoView({ targetId, active }: { targetId: string; active: boolean }) {
  useEffect(() => {
    if (!active || window.location.hash) return;
    document.getElementById(targetId)?.scrollIntoView({ block: "start" });
  }, [targetId, active]);
  return null;
}
