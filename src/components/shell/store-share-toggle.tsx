"use client";

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
  // V2-chip (som Chips på Automater): vit med kant, mörk när den är på. I en MobileMore-meny
  // under md en hel rad på 44 px.
  const button = (
    <span
      className={cn(
        "v2-chips shrink-0 self-start",
        menuItem && "max-md:w-full",
        !hint && className,
      )}
    >
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setOn(!on)}
        title={storeShareHint(on)}
        className={
          menuItem ? "max-md:h-11 max-md:w-full max-md:justify-start max-md:rounded-v2" : undefined
        }
      >
        {STORE_SHARE_TOGGLE_LABEL}
      </button>
    </span>
  );
  if (!hint) return button;
  return (
    <span
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1 self-start md:shrink-0 md:flex-nowrap",
        menuItem && "max-md:w-full max-md:flex-col max-md:items-stretch max-md:gap-0",
        className,
      )}
    >
      {button}
      <span
        className={cn("text-v2-xs whitespace-nowrap text-v2-mute", menuItem && "max-md:hidden")}
        data-testid="store-share-hint"
      >
        {storeShareHint(on)}
      </span>
    </span>
  );
}
