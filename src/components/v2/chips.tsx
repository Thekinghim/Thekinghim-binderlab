"use client";

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
}: {
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("v2-chips", className)}>
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
