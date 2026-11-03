"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Senast visade värde per nyckeltal under sessionen (sida + nyckel). */
const seen = new Map<string, number>();
/** Sant när första sidan är hydrerad: därefter monteras nyckeltal på klienten. */
let hydrated = false;

/**
 * Var räkningen börjar när ett nyckeltal monteras.
 * - Visat förut: från förra värdet (samma värde = ingen räkning).
 * - Första visningen: från 0, men bara vid klientmontering. Vid hydrering
 *   står slutvärdet redan i HTML:en och får aldrig hoppa ner till 0.
 */
export function countUpStart(
  value: number,
  previous: number | undefined,
  isHydrating: boolean,
): number {
  if (previous !== undefined) return previous;
  return isHydrating ? value : 0;
}

/** En bildruta: tiden klämd till [0, 1], sista rutan exakt, aldrig utanför start–mål eller "−0". */
export function countUpFrame(
  start: number,
  value: number,
  elapsedMs: number,
  durationMs: number,
): { n: number; done: boolean } {
  const p = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  if (p === 1) return { n: value, done: true };
  const eased = 1 - Math.pow(1 - p, 3);
  const n = Math.round(start + (value - start) * eased);
  const clamped = Math.min(Math.max(start, value), Math.max(Math.min(start, value), n));
  return { n: clamped === 0 ? 0 : clamped, done: false };
}

/**
 * Räknar ett heltal till `value`: från 0 första gången nyckeltalet visas,
 * från föregående värde när det ändras, inte alls när det är oförändrat.
 * Utan rörelse (prefers-reduced-motion) visas värdet direkt.
 */
export function CountUp({
  value,
  format,
  id,
  durationMs = 650,
  className,
}: {
  value: number;
  format: (n: number) => string;
  /** Nyckel inom sidan, t.ex. etiketten. Utan nyckel räknas bara värdebyten. */
  id?: string;
  durationMs?: number;
  className?: string;
}) {
  const pathname = usePathname();
  const key = id ? `${pathname}|${id}` : undefined;
  const [shown, setShown] = useState(() =>
    typeof window === "undefined"
      ? value
      : countUpStart(value, key ? seen.get(key) : value, !hydrated),
  );
  const current = useRef(shown);

  useEffect(() => {
    current.current = shown;
  });

  useEffect(() => {
    hydrated = true;
    if (key) seen.set(key, value);
    const start = current.current;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    if (reduce || start === value) {
      if (start !== value) raf = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(raf);
    }
    let t0: number | undefined;
    const tick = (t: number) => {
      t0 ??= t;
      const f = countUpFrame(start, value, t - t0, durationMs);
      current.current = f.n;
      setShown(f.n);
      if (!f.done) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, key]);

  return (
    <span className={className} data-value={value}>
      {format(shown)}
    </span>
  );
}
