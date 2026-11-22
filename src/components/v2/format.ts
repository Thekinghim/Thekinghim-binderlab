/**
 * Hur V2-diagrammen skriver sina tal. En enhet i stället för en funktion, så att
 * serverkomponenter kan skicka den till klientdiagrammen (funktioner går inte över gränsen).
 *
 *   "ore"  öre som hela kronor: 123 456 → "1 235 kr"
 *   "kr"   hela kronor: 1 235 → "1 235 kr"
 *   "pack" heltal + " pack"
 *   "int"  heltal
 *   "bp"   baspunkter som procent med en decimal: 2 040 → "20,4 %"
 */

import { formatInt, formatKronor, NBSP } from "@/lib/format";

export type ValueUnit = "ore" | "kr" | "pack" | "int" | "bp";

export function formatValue(value: number, unit: ValueUnit): string {
  switch (unit) {
    case "ore":
      return formatKronor(value / 100, { decimals: 0 });
    case "kr":
      return formatKronor(value, { decimals: 0 });
    case "pack":
      return `${formatInt(Math.round(value))}${NBSP}pack`;
    case "bp":
      return `${(Math.round(value / 10) / 10).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}%`;
    default:
      return formatInt(Math.round(value));
  }
}

/**
 * Ett enskilt belopp i öre som kronor, som på V2-sidorna: hela kronor utan decimaler
 * (12 900 → "129 kr"), och med ören bara när de finns (12 950 → "129,50 kr").
 */
export function formatAmountOre(ore: number): string {
  return formatKronor(ore / 100, { decimals: ore % 100 === 0 ? 0 : 2 });
}
