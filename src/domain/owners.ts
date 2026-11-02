/**
 * Fördelning av ett belopp (t.ex. periodens vinst) mellan ägare efter ägarandel.
 *
 * Varje ägare utom den med störst andel får belopp × andel / 10 000 avkortat till
 * helt öre (mot noll). Ägaren med störst andel får resten, så att summan alltid
 * stämmer exakt: de öre som avrundningen ger över hamnar hos den största andelen,
 * enligt datamodellen. Lika stora största andelar: den som står först i listan.
 */

import { DomainError } from "./errors";
import { assertBp, assertSafeInteger, fromBigInt, BP_SCALE } from "./money";
import type { OwnerShare } from "./types";

/** En ägares del. */
export interface OwnerAllocation {
  readonly id: string;
  readonly shareBp: number;
  readonly amountOre: number;
}

/**
 * Fördelar `amountOre` efter andelarna. Andelarna måste summera till exakt 10 000 bp.
 * allocateToOwners(100_001, [{ id: 'a', shareBp: 5000 }, { id: 'b', shareBp: 5000 }])
 * → a: 50 001 (störst och först, får öret), b: 50 000.
 */
export function allocateToOwners(
  amountOre: number,
  shares: readonly OwnerShare[],
): OwnerAllocation[] {
  assertSafeInteger(amountOre, "Beloppet att fördela");
  if (shares.length === 0) {
    throw new DomainError("invalid_shares", "Det finns inga ägarandelar att fördela på.");
  }
  let total = 0;
  const ids = new Set<string>();
  let largest = 0;
  for (let i = 0; i < shares.length; i++) {
    const s = shares[i]!;
    assertBp(s.shareBp, `Andelen för ${s.id}`);
    if (ids.has(s.id)) {
      throw new DomainError("invalid_shares", `Ägaren ${s.id} förekommer två gånger.`);
    }
    ids.add(s.id);
    total += s.shareBp;
    if (s.shareBp > shares[largest]!.shareBp) largest = i;
  }
  if (total !== BP_SCALE) {
    throw new DomainError(
      "invalid_shares",
      `Ägarandelarna summerar till ${total} bp, men måste vara exakt ${BP_SCALE} bp (100 %).`,
    );
  }
  const out: OwnerAllocation[] = shares.map((s) => ({
    id: s.id,
    shareBp: s.shareBp,
    amountOre: 0,
  }));
  let rest = amountOre;
  for (let i = 0; i < shares.length; i++) {
    if (i === largest) continue;
    // bigint-division avkortar mot noll.
    const part = fromBigInt((BigInt(amountOre) * BigInt(shares[i]!.shareBp)) / BigInt(BP_SCALE));
    out[i] = { ...out[i]!, amountOre: part };
    rest -= part;
  }
  out[largest] = { ...out[largest]!, amountOre: rest };
  return out;
}
