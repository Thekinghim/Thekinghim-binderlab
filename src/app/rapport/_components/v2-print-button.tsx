"use client";

import { Icon } from "@/components/ui/icon";

/** Skriv ut i V2 (öppnar webbläsarens utskrift, där även "Spara som PDF" finns). */
export function V2PrintButton({ children = "Skriv ut / spara PDF" }: { children?: string }) {
  return (
    <button type="button" className="v2-btn act touch" onClick={() => window.print()}>
      <Icon name="print" size={14} />
      {children}
    </button>
  );
}
