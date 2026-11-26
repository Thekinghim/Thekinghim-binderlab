"use client";

import { useEffect, useRef, useState } from "react";

/** Checklistan vid ett offline-stopp (Rutt och Fyll på i ruttläget). */
export const CHECKLIST = [
  "Har automaten ström? Kolla kontakten och säkringen.",
  "Har den nät? Starta om routern om lampan är släckt.",
  "Starta om automaten. Vänta tills skärmen visar facken.",
  "Syns den i Awish igen?",
] as const;

/** Nycklarna i webbläsarens minne: per person (scope = "<org>:<användare>") och dag. */
export const dayKeys = (scope: string, date: string) => ({
  /** Packlistan: titlar som är packade. */
  pack: `v2-rutt-pack:${scope}:${date}`,
  /** Checklistan: "<automat>:<rad>". */
  check: `v2-rutt-check:${scope}:${date}`,
  /** Offline-stopp som är kollade ("Stoppet klart"): automatens id. Bara i telefonen. */
  checked: `v2-rutt-klar:${scope}:${date}`,
});

/**
 * Bockar som sparas i den här webbläsaren för dagen (packlistan, checklistan och kollade
 * offline-stopp). Fungerar utan nät; servern får inget (inget låtsas vara sparat där).
 */
export function useDayChecks(
  key: string,
): [ReadonlySet<string>, (id: string, on?: boolean) => void] {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // Det senaste läget, så att ett tryck sparas direkt (också när skärmen byts i samma tryck,
  // t.ex. Stoppet klart → nästa stopp) och två snabba tryck räknas båda.
  const current = useRef<ReadonlySet<string>>(checked);
  useEffect(() => {
    let read: ReadonlySet<string> = new Set();
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) read = new Set(JSON.parse(raw) as string[]);
    } catch {
      /* privat läge: inga sparade bockar */
    }
    current.current = read;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- läser webbläsarens minne efter hydrering
    setChecked(read);
  }, [key]);
  const toggle = (id: string, on?: boolean) => {
    const next = new Set(current.current);
    if (on ?? !next.has(id)) next.add(id);
    else next.delete(id);
    current.current = next;
    try {
      window.localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      /* inget minne: bocken gäller bara nu */
    }
    setChecked(next);
  };
  return [checked, toggle];
}
