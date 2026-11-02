/**
 * Seedad slumpgenerator (mulberry32) för seed-datan. Samma frö ger alltid
 * samma följd, oberoende av plattform och tidszon (bara 32-bitars heltal).
 *
 * Slumptalen används bara för att välja tider, titlar och automater. Belopp
 * räknas aldrig med flyttal.
 */

export interface Random {
  /** Heltal i [0, 2^32). */
  nextUint32(): number;
  /** Heltal i [0, n). */
  int(n: number): number;
  /** Heltal i [min, max] (båda inklusive). */
  between(min: number, max: number): number;
  /** Index i `weights` (heltal ≥ 0, summa > 0) med sannolikhet ∝ vikten. */
  weighted(weights: readonly number[]): number;
  /** Blandar en kopia av listan (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRandom(seed: number): Random {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("Fröet måste vara ett heltal.");
  }
  let state = seed >>> 0;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  // Utan modulo-snedvridning: kasta värden i den ofullständiga sista omgången.
  const int = (n: number): number => {
    if (!Number.isSafeInteger(n) || n <= 0 || n > 0x1_0000_0000) {
      throw new RangeError(`Ogiltigt intervall: ${n}`);
    }
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % n);
    for (;;) {
      const x = nextUint32();
      if (x < limit) {
        return x % n;
      }
    }
  };

  const between = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`Ogiltigt intervall: ${min}–${max}`);
    }
    return min + int(max - min + 1);
  };

  const weighted = (weights: readonly number[]): number => {
    let total = 0;
    for (const w of weights) {
      if (!Number.isSafeInteger(w) || w < 0) {
        throw new RangeError("Vikterna måste vara heltal ≥ 0.");
      }
      total += w;
    }
    if (total <= 0) {
      throw new RangeError("Summan av vikterna måste vara > 0.");
    }
    let pick = int(total);
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] ?? 0;
      if (pick < w) {
        return i;
      }
      pick -= w;
    }
    throw new Error("Ouppnåelig gren i weighted().");
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  };

  return { nextUint32, int, between, weighted, shuffle };
}
