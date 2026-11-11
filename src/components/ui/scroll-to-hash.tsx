"use client";

import { useEffect } from "react";

/**
 * Rullar till avsnittet `id` när adressen slutar på #id (t.ex. /lonsamhet#prisrad från
 * Att göra). Webbläsaren och Next rullar själva vid en hel sidladdning, men vid en länk
 * inne i appen visas först sidans skelett, och då finns avsnittet inte än: rullningen
 * hamnar fel när det riktiga innehållet kommer. Den här komponenten ligger i avsnittet och
 * rullar därför först när avsnittet finns, och en gång till när sidan har satt sig
 * (diagram som får sin höjd). Rör användaren sidan under tiden görs ingenting mer.
 */
export function ScrollToHash({ id }: { id: string }) {
  useEffect(() => {
    let touched = false;
    const stop = () => {
      touched = true;
    };
    const go = () => {
      if (touched || decodeURIComponent(window.location.hash.slice(1)) !== id) return;
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    };
    go();
    const timers = [100, 400, 1000].map((ms) => window.setTimeout(go, ms));
    const onHash = () => {
      touched = false;
      go();
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [id]);
  return null;
}
