"use client";

import { Icon } from "@/components/ui/icon";

export function PrintButton() {
  return (
    <button type="button" className="v2-btn act touch" onClick={() => window.print()}>
      <Icon name="print" size={14} />
      Skriv ut
    </button>
  );
}
