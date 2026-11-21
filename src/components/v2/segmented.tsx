"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

export type SegmentOption<T extends string> = { value: T; label: string };

/**
 * Segmentkontroll med glidande markering (prototypens .seg): periodval, Stad/Butik/Ingen,
 * Hemma/I automaterna. Markeringen glider vid byte men står still vid första ritningen och när
 * fönstret ändrar storlek. Rörelsen stängs av vid reducerad rörelse (CSS).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const [still, setStill] = useState(true);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const btn = el.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      setPill(btn ? { x: btn.offsetLeft, w: btn.offsetWidth } : null);
    };
    measure();
    // Första anropet kommer direkt vid observe: bara senare storleksändringar är still.
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      setStill(true);
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, options]);

  return (
    <div
      ref={root}
      role="group"
      aria-label={ariaLabel}
      className={cn("v2-seg", still && "still", className)}
    >
      {pill ? (
        <span
          className="pill"
          aria-hidden="true"
          style={{ transform: `translateX(${pill.x}px)`, width: pill.w }}
        />
      ) : null}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => {
            setStill(false);
            if (o.value !== value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
