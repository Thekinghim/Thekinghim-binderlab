"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Räknar upp ett tal från föregående värde (0 första gången) till `value`.
 * Formateringen görs av `format`, så öre/kr/procent stämmer exakt i sista
 * bildrutan. Utan rörelse (prefers-reduced-motion) visas värdet direkt.
 */
export function CountUp({
  value,
  format,
  durationMs = 650,
  className,
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const start = started.current ? from.current : 0;
    started.current = true;
    if (reduce || start === value) {
      setShown(value);
      from.current = value;
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(p === 1 ? value : start + (value - start) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, durationMs]);

  return (
    <span className={className} data-value={value}>
      {format(Math.round(shown))}
    </span>
  );
}
