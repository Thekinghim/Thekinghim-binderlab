"use client";

import { useVmbView } from "./use-period";

/** Knappens förklaring (title), en rad. */
export const VMB_TOGGLE_TITLE = "Visa vinst och marginal efter VMB-moms (vinstmarginalbeskattning)";

/** Texten på knappen: säger alltid hur siffrorna räknas just nu. */
export function vmbToggleLabel(on: boolean): string {
  return on ? "Med VMB" : "Utan VMB";
}

/**
 * Vyknappen i kontextraden (standard av). Av: "Utan VMB" (vit chip), siffrorna räknas utan
 * VMB-moms. På: "Med VMB" (mörk chip), alla vinst- och marginaltal räknas efter VMB-moms
 * (?vmb=1, följer med mellan sidor). Valet minns per användare.
 */
export function VmbToggle({ userKey, className }: { userKey: string; className?: string }) {
  const { on, setOn } = useVmbView(userKey);
  // V2-chip (som Chips): vit med kant, mörk när VMB räknas.
  return (
    <span className="v2-chips shrink-0">
      <button
        type="button"
        aria-pressed={on}
        title={VMB_TOGGLE_TITLE}
        onClick={() => setOn(!on)}
        className={className}
      >
        {vmbToggleLabel(on)}
      </button>
    </span>
  );
}
