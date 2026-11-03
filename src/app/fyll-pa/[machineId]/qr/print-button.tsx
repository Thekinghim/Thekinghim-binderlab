"use client";

import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button variant="primary" iconLeft="print" onClick={() => window.print()}>
      Skriv ut
    </Button>
  );
}
