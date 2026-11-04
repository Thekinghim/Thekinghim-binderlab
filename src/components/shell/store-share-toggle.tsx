"use client";

import { MOBILE_MENU_ITEM } from "@/components/ui/more-menu";
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
  menuItem = false,
}: {
  userKey: string | null;
  className?: string;
  /** Står i en MobileMore-meny: under md en hel rad på 44 px (från md oförändrad). */
  menuItem?: boolean;
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
        menuItem && cn(MOBILE_MENU_ITEM, "max-md:gap-3"),
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
