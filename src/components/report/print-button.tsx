"use client";

import { Button, type ButtonProps } from "@/components/ui/button";

/** Öppnar webbläsarens utskriftsdialog. Där väljs även "Spara som PDF". */
export function PrintButton({
  children = "Skriv ut / spara PDF",
  ...rest
}: Omit<ButtonProps, "onClick">) {
  return (
    <Button variant="primary" size="sm" iconLeft="print" onClick={() => window.print()} {...rest}>
      {children}
    </Button>
  );
}
