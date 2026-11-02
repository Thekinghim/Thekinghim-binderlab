/**
 * Datumhjälp för Marknads klientkomponenter (gränser i datumfälten). Affärsdatum
 * 'ÅÅÅÅ-MM-DD' räknas i UTC så att resultatet är samma i alla tidszoner.
 */

/** Dagen `days` dagar efter (negativt: före) `day`. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Den senaste av dagarna (null hoppas över). */
export function latestDay(...days: (string | null)[]): string | null {
  return days.reduce<string | null>(
    (max, d) => (d !== null && (max === null || d > max) ? d : max),
    null,
  );
}

/** Fackperioder som ersätts om en ny fördelning gäller från och med `from`. */
export function replacedStarts(starts: readonly string[], from: string): string[] {
  return starts.filter((s) => s >= from);
}
