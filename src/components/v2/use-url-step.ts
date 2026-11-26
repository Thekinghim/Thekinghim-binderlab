"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/**
 * Ett flöde i steg (en guide) med steget i adressen (?steg=2), så att svepet bakåt och
 * tillbaka-pilen backar ett steg i stället för att lämna sidan och tappa det man skrivit.
 *
 * Adressen byts med history.pushState/replaceState, som Next läser av (useSearchParams)
 * utan att hämta sidan från servern igen. I adressen räknas stegen från 1; i koden från 0.
 */

/** Steget i adressen (0-baserat), eller null utan giltigt steg. */
export function parseStep(raw: string | null, count: number): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= count ? n - 1 : null;
}

/** Adressen med steget (null tar bort det), övriga sökparametrar kvar. */
export function stepHref(
  pathname: string,
  search: string,
  param: string,
  step: number | null,
): string {
  const params = new URLSearchParams(search);
  if (step === null) params.delete(param);
  else params.set(param, String(step + 1));
  const q = params.toString();
  return q ? `${pathname}?${q}` : pathname;
}

export interface UrlStep {
  /** Steget i adressen (0-baserat), null utan steg. */
  readonly step: number | null;
  /** Nytt steg i historiken (Nästa). */
  readonly push: (step: number | null) => void;
  /** Byt steget utan nytt steg i historiken. */
  readonly replace: (step: number | null) => void;
  /**
   * Tillbaka till `step`: som svepet bakåt (ett eller flera steg) när det steget ligger
   * före i historiken, annars byts adressen (sidan öppnades mitt i flödet).
   */
  readonly back: (step: number | null) => void;
  /** Lämna flödet: backa förbi alla steg som lagts i historiken här. */
  readonly leave: () => void;
}

export function useUrlStep(count: number, param = "steg"): UrlStep {
  const pathname = usePathname();
  const step = parseStep(useSearchParams().get(param), count);
  // Stegen i historiken som den här sidan känner till, sist det som visas nu.
  const trail = useRef<(number | null)[]>([step]);

  useEffect(() => {
    const t = trail.current;
    if (t[t.length - 1] === step) return;
    if (t.length >= 2 && t[t.length - 2] === step) t.pop();
    else t.push(step);
  }, [step]);

  const href = useCallback(
    (s: number | null) => stepHref(pathname, window.location.search, param, s),
    [pathname, param],
  );
  const push = useCallback(
    (s: number | null) => window.history.pushState(null, "", href(s)),
    [href],
  );
  const replace = useCallback(
    (s: number | null) => {
      window.history.replaceState(null, "", href(s));
      trail.current[trail.current.length - 1] = s;
    },
    [href],
  );
  const back = useCallback(
    (s: number | null) => {
      const t = trail.current;
      const at = t.lastIndexOf(s, t.length - 2);
      if (t.length < 2 || at < 0) return replace(s);
      // Listan kortas här, så att sidbytet (popstate) inte läses som ett nytt steg.
      trail.current = t.slice(0, at + 1);
      window.history.go(at - (t.length - 1));
    },
    [replace],
  );
  const leave = useCallback(() => {
    const n = trail.current.length;
    trail.current = [null];
    window.history.go(-n);
  }, []);
  return { step, push, replace, back, leave };
}
