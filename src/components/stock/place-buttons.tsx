"use client";

import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

export interface PlaceOption {
  readonly id: string;
  readonly name: string;
  /** Pack på platsen (visas under namnet), eller utelämnat. */
  readonly count?: number | null;
  readonly disabled?: boolean;
}

/**
 * Stora knappar för att välja ett lager ("Hemma · 12 pack"). En radiogrupp: valt lager är
 * fyllt. Används i Vårt lager (Vilket lager?, Flytta, Inköp), Fyll på och Påfyllning.
 */
export function PlaceButtons({
  places,
  value,
  onChange,
  label,
  compact = false,
  countText,
}: {
  places: readonly PlaceOption[];
  value: string | null;
  onChange: (id: string) => void;
  /** Gruppens namn för skärmläsare ("Från", "Till", "Vilket lager?"). */
  label: string;
  /** Lägre knappar (inne i ett formulär på en rad). */
  compact?: boolean;
  /** Antalet som text (standard "12 pack"). */
  countText?: (n: number) => string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
      {places.map((p) => {
        const on = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={p.disabled}
            onClick={() => onChange(p.id)}
            className={cn(
              "flex flex-col items-start justify-center rounded-md border px-4 text-left transition-colors duration-fast ease-instrument disabled:border-dashed disabled:text-disabled",
              compact ? "min-h-11 py-1.5" : "min-h-16 py-2",
              on
                ? "border-inverse bg-inverse text-on-inverse"
                : "border-line-strong bg-surface text-fg hover:bg-hover active:bg-hover",
            )}
          >
            <span className={cn("truncate font-medium", compact ? "text-md" : "text-lg")}>
              {p.name}
            </span>
            {p.count !== undefined && p.count !== null ? (
              <span className={cn("meta tnum", on ? "text-on-inverse/80" : "text-subtle")}>
                {countText ? countText(p.count) : `${formatInt(p.count)}${NBSP}pack`}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
