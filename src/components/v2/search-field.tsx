"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/cn";

/**
 * Sökfält med Ctrl K (⌘K på Mac). Med `hotkey` fokuserar Ctrl K det här fältet i stället för
 * att öppna kommandomenyn (Automater: listans sök). Escape tömmer fältet.
 */
export function SearchField({
  value,
  onChange,
  placeholder = "Sök",
  hotkey = false,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hotkey?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Kommandomenyn lyssnar också: den här lyssnaren går först (capture) och stoppar den.
        e.stopImmediatePropagation();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [hotkey]);

  return (
    <label className={cn("v2-search", className)}>
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10.5 17.5a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4.5-4.5" />
      </svg>
      <input
        ref={input}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
      />
      {hotkey ? <kbd aria-hidden="true">Ctrl K</kbd> : null}
    </label>
  );
}
