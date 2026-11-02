"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatHotkey, useModifierKey } from "@/components/ui/command-palette";

/**
 * Tangentruta i label-storlek (11/16 mono), 1px kant, radie 2 px.
 * Ärver textfärgen så att den fungerar i både knappar och löptext.
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "label inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-current/25 px-1 tracking-normal text-current/80",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * Kortkommando med plattformens modifierare: "⌘K" på Apple, "Ctrl K" annars.
 * Renderar ingenting tills plattformen är känd, så att servern aldrig visar fel tangent.
 */
export function HotkeyHint({ letter = "K", className }: { letter?: string; className?: string }) {
  const mod = useModifierKey();
  const text = formatHotkey(mod, letter);
  if (!text) return null;
  return (
    <Kbd className={className}>
      <span className="sr-only">Kortkommando </span>
      {text}
    </Kbd>
  );
}
