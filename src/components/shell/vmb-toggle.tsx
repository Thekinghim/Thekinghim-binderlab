"use client";

import { cn } from "@/lib/cn";

import { useVmbView } from "./use-period";

/** Knappens förklaring (title), en rad. */
export const VMB_TOGGLE_TITLE = "Visa vinst och marginal efter VMB-moms (vinstmarginalbeskattning)";

/**
 * Vyknappen "Med VMB" i kontextraden (standard av). På: alla vinst- och marginaltal räknas
 * efter VMB-moms (?vmb=1, följer med mellan sidor). Valet minns per användare.
 */
export function VmbToggle({ userKey, className }: { userKey: string; className?: string }) {
  const { on, setOn } = useVmbView(userKey);
  return (
    <button
      type="button"
      aria-pressed={on}
      title={VMB_TOGGLE_TITLE}
      onClick={() => setOn(!on)}
      className={cn(
        "label flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong px-2 transition-colors",
        on ? "bg-hover font-medium text-fg" : "text-subtle hover:text-muted",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-2 rounded-xs border border-current",
          on ? "bg-current" : "bg-transparent",
        )}
      />
      Med VMB
    </button>
  );
}
