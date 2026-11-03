/**
 * Påfyllning enligt Awish → uttag ur vårt lager (automatens "Fylls på från", annars
 * standardlagret). Ren funktion.
 *
 * Awish visar hur många pack som finns i automaten. Har en automat som redan har lästs
 * fler pack av en titel än saldot i Binderlab är ökningen en påfyllning, och packen kom
 * från vårt lager. Regeln:
 *
 * - Automatens första läsning (aldrig läst från Awish förut): inget uttag.
 * - Titelns första saldo på platsen (inget räknat saldo där än): inget uttag.
 * - Minskning eller samma antal: inget uttag (minskningar är försäljning eller svinn).
 * - Ökning: uttag = Awish antal − saldot (ett negativt saldo räknas som 0).
 *
 * En påfyllning som redan registrerats i appen (register_refill, från vårt lager) har höjt
 * saldot, så Awish visar samma antal och uttaget blir 0: samma pack dras aldrig två gånger.
 * Varje automat räknas för sig; två automater med samma titel ger två uttag.
 */

export interface DeductionLevel {
  /** Saldot på automatens plats nu (stock_levels.quantity). */
  readonly quantity: number;
  /** Sant om platsen har ett räknat saldo för titeln (last_counted_at är satt). */
  readonly counted: boolean;
}

export interface DeductionInput {
  /** Sant om automaten har lästs från Awish förut (stock_locations.awish_synced_at). */
  readonly syncedBefore: boolean;
  /** Saldot per titel på automatens plats före läsningen. */
  readonly levels: ReadonlyMap<string, DeductionLevel>;
  /** Pack per titel enligt Awish nu. */
  readonly awish: ReadonlyMap<string, number>;
}

export interface Deduction {
  readonly titleId: string;
  /** Pack som drogs ur vårt lager (alltid minst 1). */
  readonly quantity: number;
}

export function refillDeductions(input: DeductionInput): Deduction[] {
  if (!input.syncedBefore) return [];
  const out: Deduction[] = [];
  for (const [titleId, units] of input.awish) {
    const level = input.levels.get(titleId);
    if (!level || !level.counted) continue;
    const delta = units - Math.max(0, level.quantity);
    if (delta > 0) out.push({ titleId, quantity: delta });
  }
  return out.sort((a, b) => (a.titleId < b.titleId ? -1 : a.titleId > b.titleId ? 1 : 0));
}

/** Noteringen på uttaget: "Awish-påfyllning BL-002 Sega gubben". */
export const AWISH_REFILL_NOTE_PREFIX = "Awish-påfyllning ";

export function awishRefillNote(code: string, place: string): string {
  const where = place.trim();
  return `${AWISH_REFILL_NOTE_PREFIX}${code}${where ? ` ${where}` : ""}`.slice(0, 500);
}
