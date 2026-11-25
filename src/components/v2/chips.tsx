"use client";

import { useCallback, useEffect, useRef } from "react";

import { cn } from "@/lib/cn";

export type ChipOption<T extends string> = {
  value: T;
  label: string;
  /** Antalet efter etiketten ("Offline 2"). Utelämnat = inget tal. */
  count?: number;
};

/** Filterchips med antal (Automater: Alla, Behöver påfyllning, Offline …). Ett val åt gången. */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  scroll = false,
}: {
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  /** Telefon: en sidledsrad med fast höjd i stället för radbrytning (verktygsrader). */
  scroll?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const edgeRef = useEdgeFade(scroll);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      edgeRef(el);
    },
    [edgeRef],
  );
  // Sidledsraden: valt chip rullas fram helt (inte under den tonade kanten eller halvt utanför).
  useEffect(() => {
    const row = rowRef.current;
    if (!scroll || !row) return;
    const chip = row.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!chip) return;
    const left = revealLeft(row.scrollLeft, row.clientWidth, chip.offsetLeft, chip.offsetWidth);
    if (left !== row.scrollLeft) row.scrollTo({ left, behavior: "smooth" });
  }, [scroll, value]);
  return (
    <div
      ref={setRef}
      role="group"
      aria-label={ariaLabel}
      className={cn("v2-chips", scroll && "scroll", className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="n">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Tonade kanten (v2.css) är 24 px: ett chip räknas som synligt först utanför den. */
const FADE = 24;

/**
 * Var raden ska stå (scrollLeft) för att ett chip ska synas helt, utanför de tonade kanterna.
 * Oförändrat om det redan syns.
 */
export function revealLeft(
  scrollLeft: number,
  width: number,
  chipLeft: number,
  chipWidth: number,
): number {
  if (chipLeft - FADE < scrollLeft) return Math.max(0, chipLeft - FADE);
  if (chipLeft + chipWidth + FADE > scrollLeft + width) return chipLeft + chipWidth + FADE - width;
  return scrollLeft;
}

/**
 * Sidledsraden: sätter data-more-start / data-more-end medan det finns fler chips åt det hållet,
 * så att den tonade kanten (v2.css) försvinner när man rullat ända fram.
 */
function useEdgeFade(enabled: boolean) {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback(
    (el: HTMLDivElement | null) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!el || !enabled) return;
      let raf = 0;
      const mark = () => {
        const max = el.scrollWidth - el.clientWidth;
        el.toggleAttribute("data-more-start", el.scrollLeft > 2);
        el.toggleAttribute("data-more-end", el.scrollLeft < max - 2);
      };
      const onScroll = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(mark);
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
      ro?.observe(el);
      for (const c of Array.from(el.children)) ro?.observe(c);
      mark();
      cleanup.current = () => {
        cancelAnimationFrame(raf);
        el.removeEventListener("scroll", onScroll);
        ro?.disconnect();
        el.removeAttribute("data-more-start");
        el.removeAttribute("data-more-end");
      };
    },
    [enabled],
  );
}
