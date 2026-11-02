"use client";

import { useRef, type KeyboardEvent } from "react";
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
 * bara det valda segmentet ligger i tabbordningen.
 *
 * En ram, 1px avdelare mellan lägena och ingen flytande platta: valt
 * läge markeras statiskt med ett 2px indexstreck, fylld yta, förgrundstext
 * och fetare vikt, så det syns redan i serverrenderad HTML. Hover på ett
 * ovalt läge går bara till muted, så det aldrig ser valt ut.
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
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

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
        "inline-flex w-fit max-w-full [scrollbar-width:none] divide-x divide-line-strong overflow-x-auto rounded-sm border border-line-strong",
        size === "sm" ? "h-7" : "h-8",
        className,
      )}
    >
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
              "label relative shrink-0 whitespace-nowrap transition-[background-color,color] duration-fast ease-instrument focus-visible:-outline-offset-2",
              size === "sm" ? "px-2.5" : "px-3",
              // Valt läge bärs av form, inte bara färg: ett 2px indexstreck i
              // förgrundsfärg längs underkanten, inuti ramen.
              selected
                ? "bg-hover font-medium text-fg after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg"
                : "text-subtle hover:text-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
