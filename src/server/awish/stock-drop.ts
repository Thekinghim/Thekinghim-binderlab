/**
 * "Blev ett fack just tomt?" Synken jämför saldot i automaterna före och efter läsningen
 * från Awish (sync.ts). Larmen utvärderas direkt bara när något just ÄNDRADES till slut
 * eller till högst larmgränsen, inte varje gång ett fack fortfarande är tomt. Annars skulle
 * larmjobbet köras var femte minut så länge något är slut.
 *
 * Ren funktion (ingen databas): testas i stock-drop.test.ts.
 */

export interface SlotBalance {
  readonly machineId: string;
  readonly titleId: string;
  /** Pack i automaten. */
  readonly onHand: number;
  /** Larmgränsen för titeln i automaten (slot_alerts), om någon är satt. */
  readonly alertAt: number | null;
}

/** Är saldot slut eller högst larmgränsen? */
function isLow(onHand: number, alertAt: number | null): boolean {
  return onHand <= 0 || (alertAt !== null && onHand <= alertAt);
}

/**
 * Automaterna där minst en titel just gick från "finns" till "slut eller högst larmgränsen".
 * En titel som inte fanns före läsningen räknas inte (den har inte tagit slut, den är ny),
 * och en som redan var låg före räknas inte heller (larmet har redan gått).
 */
export function machinesJustLow(
  before: readonly SlotBalance[],
  after: readonly SlotBalance[],
): string[] {
  const key = (b: SlotBalance) => `${b.machineId}\u0000${b.titleId}`;
  const was = new Map(before.map((b) => [key(b), b]));
  const out = new Set<string>();
  for (const a of after) {
    const b = was.get(key(a));
    if (!b) continue;
    // Gränsen som gäller nu: en gräns som sattes under läsningen ska inte larma i efterhand.
    if (!isLow(b.onHand, a.alertAt) && isLow(a.onHand, a.alertAt)) out.add(a.machineId);
  }
  return [...out].sort();
}
