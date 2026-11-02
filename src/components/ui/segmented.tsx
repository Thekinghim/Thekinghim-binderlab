"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

export type SegmentOption<T extends string> = { value: T; label: string };

type SegmentedProps<T extends string> = {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Tillgängligt namn på gruppen */
  label: string;
  size?: "sm" | "md";
  className?: string;
};

/**
 * Segmentväljare som radiogroup: piltangenter flyttar och väljer,
 * bara det valda segmentet ligger i tabbordningen. Markören glider
 * mellan lägen på 150 ms.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[activeIndex];
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const parent = refs.current[0]?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [activeIndex, options.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    let next = -1;
    if (delta) next = (activeIndex + delta + options.length) % options.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const opt = options[next];
    if (opt) {
      onChange(opt.value);
      refs.current[next]?.focus();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative inline-flex w-fit max-w-full [scrollbar-width:none] overflow-x-auto rounded-sm border border-line-strong bg-bg p-0.5",
        className,
      )}
    >
      {indicator ? (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-xs border border-line-strong bg-raised transition-[left,width] duration-[150ms] ease-instrument"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "label relative z-10 shrink-0 rounded-xs px-2.5 whitespace-nowrap transition-colors duration-[120ms] focus-visible:outline-offset-0",
              size === "sm" ? "h-6" : "h-7",
              selected ? "text-fg" : "text-subtle hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
