"use client";

import { useEffect } from "react";

/**
 * Öppnar <details id={id}> och scrollar dit när adressen slutar på #id
 * (t.ex. /datakallor#ladda-upp), även när ankaret byts på samma sida.
 */
export function OpenOnHash({ id }: { id: string }) {
  useEffect(() => {
    const go = () => {
      if (decodeURIComponent(window.location.hash.slice(1)) !== id) return;
      const el = document.getElementById(id);
      if (el instanceof HTMLDetailsElement) el.open = true;
      el?.scrollIntoView({ block: "start" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [id]);
  return null;
}
