/**
 * Periodvalet i V2: snabbvalen 30 dagar / 7 dagar / I går / I dag i samma ?period som resten av
 * appen (src/components/shell/period-state.ts), och "Datum…" för Denna månad, Förra månaden och
 * ett eget intervall. Andra perioder visas med sitt namn på datumknappen.
 */

import { compareText, type PeriodKey, type ResolvedPeriod } from "@/components/shell/period-state";

export type V2PeriodKey = "30d" | "7d" | "igar" | "idag";

export const V2_PERIODS: ReadonlyArray<{ value: V2PeriodKey; label: string }> = [
  { value: "30d", label: "30 dagar" },
  { value: "7d", label: "7 dagar" },
  { value: "igar", label: "I går" },
  { value: "idag", label: "I dag" },
];

/** Telefonens korta etiketter (fem knappar på en rad). */
export const V2_PERIODS_SHORT: ReadonlyArray<{ value: V2PeriodKey; label: string }> = [
  { value: "30d", label: "30 d" },
  { value: "7d", label: "7 d" },
  { value: "igar", label: "I går" },
  { value: "idag", label: "I dag" },
];

/** Den markerade snabbknappen, eller null för en annan period (datumknappen visar den). */
export function v2PeriodOf(key: PeriodKey): V2PeriodKey | null {
  return key === "30d" || key === "7d" || key === "igar" || key === "idag" ? key : null;
}

/** Jämförelsetexten för perioden: "mot i går", "mot dagen innan", "mot förra 7 dagarna". */
export function v2CompareText(p: Pick<ResolvedPeriod, "key" | "range" | "previous">): string {
  return compareText(p) ?? "mot förra";
}
