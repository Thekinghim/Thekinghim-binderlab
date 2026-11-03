/**
 * Texter för ett eget lager. Rena och klientsäkra.
 *
 * "hemma" läses naturligt ("12 kvar hemma"), andra namn får "i" ("12 kvar i Kontoret").
 */

/** "hemma" · "i Kontoret" */
export function inPlace(name: string): string {
  const n = name.trim();
  return n.toLowerCase() === "hemma" ? "hemma" : `i ${n}`;
}

/** Senast valda lagret om det finns kvar, annars standardvalet. */
export function pickPlace(
  places: readonly { readonly id: string }[],
  ...candidates: readonly (string | null | undefined)[]
): string | null {
  for (const c of candidates) {
    if (c && places.some((p) => p.id === c)) return c;
  }
  return places[0]?.id ?? null;
}
