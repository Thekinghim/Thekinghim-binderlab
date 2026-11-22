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
        "label inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-current/25 px-1 tracking-normal text-current",
        // V2: Google Sans Code, bara här (Ctrl K-tipset), och ingen ram.
        "v2:rounded-v2-sm v2:border-0 v2:bg-v2-sel v2:font-v2-code! v2:text-[11px]! v2:font-normal! v2:text-v2-mute",
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
