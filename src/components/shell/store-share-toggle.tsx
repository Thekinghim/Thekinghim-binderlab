"use client";

import { cn } from "@/lib/cn";

import { useStoreShareView } from "./use-period";

/** Knappens text. Samma på alla sidor, så att den är lätt att känna igen. */
export const STORE_SHARE_TOGGLE_LABEL = "Visa butikernas andel";

/**
 * Vyknappen "Visa butikernas andel" (standard av). Av: sidan visar vår vinst. På: också
 * butikernas andel och vinsten före den (?andel=1, följer med mellan sidor). Valet minns
 * per användare, som "Med VMB". Bara visning: vår vinst är densamma i båda lägena.
 */
export function StoreShareToggle({
  userKey,
  className,
}: {
  userKey: string | null;
  className?: string;
}) {
  const { on, setOn } = useStoreShareView(userKey);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setOn(!on)}
      className={cn(
        "label inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-sm border border-line-strong px-2.5 transition-colors",
        on ? "bg-hover font-medium text-fg" : "text-subtle hover:text-muted",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-2 rounded-xs border border-current transition-colors",
          on ? "bg-current" : "bg-transparent",
        )}
      />
      {STORE_SHARE_TOGGLE_LABEL}
    </button>
  );
}
