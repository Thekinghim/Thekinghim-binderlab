"use client";

import { MOBILE_MENU_ITEM } from "@/components/ui/more-menu";
import { cn } from "@/lib/cn";

import { storeShareHint } from "./period-state";
import { useStoreShareView } from "./use-period";

/** Knappens text. Samma på alla sidor, så att den är lätt att känna igen. */
export const STORE_SHARE_TOGGLE_LABEL = "Visa butikernas andel";

/**
 * Vyknappen "Visa butikernas andel" (standard av). Av: vår vinst och marginal räknas FÖRE
 * butikernas andel. På: varje butiks andel enligt dess avtal dras (Butikernas andel, Vår
 * del). Valet sparas i en kaka och gäller på alla sidor (?andel=1 följer också med).
 * `on` = serverns läge för förfrågan (requestStoreShareView), samma som siffrorna.
 */
export function StoreShareToggle({
  on: serverOn,
  className,
  menuItem = false,
  hint = true,
}: {
  on: boolean;
  className?: string;
  /** Står i en MobileMore-meny: under md en hel rad på 44 px (från md oförändrad). */
  menuItem?: boolean;
  /** Visa "Före/Efter butikernas andel" efter knappen. */
  hint?: boolean;
}) {
  const { on, setOn } = useStoreShareView(serverOn);
  const button = (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setOn(!on)}
      title={`Vår vinst och marginal visas ${storeShareHint(on).toLowerCase()}`}
      className={cn(
        "label inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-sm border border-line-strong px-2.5 transition-colors",
        on ? "bg-hover font-medium text-fg" : "text-subtle hover:text-muted",
        menuItem && cn(MOBILE_MENU_ITEM, "max-md:gap-3"),
        !hint && className,
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
  if (!hint) return button;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-2 self-start",
        menuItem && "max-md:w-full max-md:flex-col max-md:items-stretch max-md:gap-0",
        className,
      )}
    >
      {button}
      <span
        className={cn("label whitespace-nowrap text-subtle", menuItem && "max-md:hidden")}
        data-testid="store-share-hint"
      >
        {storeShareHint(on)}
      </span>
    </span>
  );
}
