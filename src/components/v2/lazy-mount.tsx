"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Ritar innehållet först när det närmar sig skärmen (en skärmhöjd före). Tunga delar längre
 * ner på en sida (värmekartan, långa staplar) kostar då inget när sidan öppnas på telefonen.
 * Utan IntersectionObserver ritas det direkt. `minHeight` håller platsen så att sidan inte
 * hoppar när innehållet kommer.
 */
export function LazyMount({
  children,
  minHeight,
  label,
}: {
  children: ReactNode;
  /** Ungefärlig höjd i px innan innehållet ritats. */
  minHeight: number;
  /** Text för skärmläsare medan innehållet inte ritats. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- gammal webbläsare: rita direkt
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  if (shown) return <>{children}</>;
  return (
    <div ref={ref} style={{ minHeight }} aria-busy="true">
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
