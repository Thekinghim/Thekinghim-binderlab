/**
 * Periodvalet i V2: 30 dagar / 7 dagar / I dag, i samma ?period som resten av appen
 * (src/components/shell/period-state.ts). Andra perioder i adressen (månad, allt, eget datum)
 * visas som "Eget" och lämnas orörda tills man väljer en av de tre.
 */

import type { PeriodKey } from "@/components/shell/period-state";

export type V2PeriodKey = "30d" | "7d" | "idag";

export const V2_PERIODS: ReadonlyArray<{ value: V2PeriodKey; label: string }> = [
  { value: "30d", label: "30 dagar" },
  { value: "7d", label: "7 dagar" },
  { value: "idag", label: "I dag" },
];

/** Den markerade knappen, eller null för en annan period ("Eget"). */
export function v2PeriodOf(key: PeriodKey): V2PeriodKey | null {
  return key === "30d" || key === "7d" || key === "idag" ? key : null;
}

/** Jämförelsetexten för perioden: "mot förra", "mot i går". */
export function v2CompareText(key: PeriodKey): string {
  return key === "idag" ? "mot i går" : "mot förra";
}
