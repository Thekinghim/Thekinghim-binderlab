"use client";

import { Icon } from "@/components/ui/icon";

/** Skriv ut i V2 (öppnar webbläsarens utskrift, där även "Spara som PDF" finns). */
export function V2PrintButton({
  children = "Skriv ut / spara PDF",
  disabled = false,
}: {
  children?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="v2-btn act touch"
      disabled={disabled}
      onClick={() => window.print()}
      aria-label={children}
    >
      <Icon name="print" size={14} />
      {/* Telefon: bara "PDF", så att sidans rubrik inte kortas av knappen. */}
      <span className="max-[900px]:hidden">{children}</span>
      <span className="hidden max-[900px]:inline" aria-hidden="true">
        PDF
      </span>
    </button>
  );
}
