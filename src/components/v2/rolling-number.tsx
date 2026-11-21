"use client";

import NumberFlow, { continuous, type Format } from "@number-flow/react";

import { cn } from "@/lib/cn";

/**
 * Rullande siffror (NumberFlow) med svensk formatering. Bara för vinsten och lagret totalt
 * (byggplanen 4.1): annars ska tal stå still. Av vid reducerad rörelse (NumberFlow respekterar
 * prefers-reduced-motion själv). Talet är alltid det riktiga (inget räknas upp från 0 vid
 * första ritningen: animated först efter monteringen).
 *
 * `unit`: "kr" tar öre och visar hela kronor ("123 675 kr"), "pack" heltal + " pack",
 * "pct" baspunkter som procent med en decimal, "int" ett heltal.
 */
export function RollingNumber({
  value,
  unit = "int",
  className,
  ariaLabel,
}: {
  value: number;
  unit?: "kr" | "pack" | "pct" | "int";
  className?: string;
  ariaLabel?: string;
}) {
  const { n, format, suffix } = numberFor(value, unit);
  return (
    <NumberFlow
      className={cn("v2-roll", className)}
      value={n}
      locales="sv-SE"
      format={format}
      suffix={suffix}
      plugins={[continuous]}
      willChange
      aria-label={ariaLabel}
    />
  );
}

export function numberFor(
  value: number,
  unit: "kr" | "pack" | "pct" | "int",
): { n: number; format: Format; suffix?: string } {
  switch (unit) {
    case "kr":
      return { n: Math.round(value / 100), format: { maximumFractionDigits: 0 }, suffix: " kr" };
    case "pack":
      return { n: Math.round(value), format: { maximumFractionDigits: 0 }, suffix: " pack" };
    case "pct":
      return {
        n: Math.round(value / 10) / 10,
        format: { minimumFractionDigits: 1, maximumFractionDigits: 1 },
        suffix: " %",
      };
    default:
      return { n: Math.round(value), format: { maximumFractionDigits: 0 } };
  }
}
