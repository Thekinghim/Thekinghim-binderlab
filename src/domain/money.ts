/**
 * Heltalsaritmetik för pengar.
 *
 * Belopp är öre i `number` men alltid säkra heltal (|x| ≤ 2^53 − 1). Produkter
 * som kan bli större (t.ex. belopp × baspunkter) räknas med `bigint`, så att
 * avrundningen alltid är exakt. Om ett resultat inte ryms som säkert heltal
 * kastas `DomainError("overflow")` i stället för att ge en felaktig siffra.
 *
 * Avrundningsregel överallt: halva avrundas bort från noll ("kommersiell
 * avrundning"): 2,5 → 3, 2,4999 → 2, −2,5 → −3. För positiva belopp är det
 * detsamma som att halva öre avrundas uppåt.
 */

import { DomainError } from "./errors";

/** 10 000 baspunkter = 100 %. */
export const BP_SCALE = 10_000;

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/** Kastar om värdet inte är ett säkert heltal. */
export function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DomainError(
      "invalid_amount",
      `${label} måste vara ett heltal (öre/bp), fick ${String(value)}.`,
    );
  }
}

/** Kastar om värdet inte är ett säkert heltal ≥ 0. */
export function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  assertSafeInteger(value, label);
  if (value < 0) {
    throw new DomainError("invalid_amount", `${label} får inte vara negativt, fick ${value}.`);
  }
}

/** Kastar om värdet inte är en procentsats i bp inom [0, max]. */
export function assertBp(value: unknown, label: string, max = BP_SCALE): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new DomainError(
      "invalid_rate",
      `${label} måste vara ett heltal i baspunkter mellan 0 och ${max}, fick ${String(value)}.`,
    );
  }
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE_BIG || value < -MAX_SAFE_BIG) {
    throw new DomainError("overflow", `${what} är för stort för att räknas exakt (${value}).`);
  }
  return Number(value);
}

function roundHalfUpBig(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new DomainError("division_by_zero", "Division med noll.");
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // trunkerar mot noll
  const r = n % d; // samma tecken som n
  const twiceAbsR = (r < 0n ? -r : r) * 2n;
  if (twiceAbsR >= d) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/**
 * Heltalsdivision med avrundning, halva bort från noll.
 * roundHalfUp(5, 2) → 3, roundHalfUp(7, 3) → 2, roundHalfUp(-5, 2) → −3.
 * Tar `number` (säkra heltal) eller `bigint`; svaret är alltid ett säkert heltal.
 */
export function roundHalfUp(numerator: number | bigint, denominator: number | bigint): number {
  if (typeof numerator === "number" && typeof denominator === "number") {
    assertSafeInteger(numerator, "Täljaren");
    assertSafeInteger(denominator, "Nämnaren");
    if (denominator === 0) throw new DomainError("division_by_zero", "Division med noll.");
    let n = numerator;
    let d = denominator;
    if (d < 0) {
      n = -n;
      d = -d;
    }
    const r = n % d;
    // (n − r) är en exakt multipel av d, så kvoten är ett exakt heltal.
    const q = (n - r) / d;
    if (2 * Math.abs(r) >= d) return n < 0 ? q - 1 : q + 1;
    return q === 0 ? 0 : q; // undvik −0
  }
  const n = typeof numerator === "bigint" ? numerator : toBig(numerator, "Täljaren");
  const d = typeof denominator === "bigint" ? denominator : toBig(denominator, "Nämnaren");
  return toSafeNumber(roundHalfUpBig(n, d), "Resultatet");
}

function toBig(value: number, label: string): bigint {
  assertSafeInteger(value, label);
  return BigInt(value);
}

/**
 * round(a × b / denominator) exakt, även när a × b är större än 2^53.
 * Används för t.ex. belopp × bp / 10 000.
 */
export function mulDivRound(a: number, b: number, denominator: number): number {
  assertSafeInteger(a, "Beloppet");
  assertSafeInteger(b, "Faktorn");
  assertSafeInteger(denominator, "Nämnaren");
  const product = a * b;
  if (Math.abs(product) <= Number.MAX_SAFE_INTEGER) return roundHalfUp(product, denominator);
  return toSafeNumber(roundHalfUpBig(BigInt(a) * BigInt(b), BigInt(denominator)), "Resultatet");
}

/** Belopp × bp / 10 000, avrundat. applyBp(4900, 250) → 123 (122,5 avrundas uppåt). */
export function applyBp(amountOre: number, bp: number): number {
  return mulDivRound(amountOre, bp, BP_SCALE);
}

/** Andel i bp: round(part × 10 000 / whole). `null` när helheten är 0. */
export function ratioBp(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return mulDivRound(part, BP_SCALE, whole);
}

/** Summa av belopp, med kontroll av att varje värde och summan är säkra heltal. */
export function sumOre(values: Iterable<number>): number {
  let sum = 0;
  for (const v of values) {
    assertSafeInteger(v, "Beloppet");
    sum += v;
    if (!Number.isSafeInteger(sum)) {
      throw new DomainError("overflow", "Summan är för stor för att räknas exakt.");
    }
  }
  return sum;
}

/** Omvandlar ett `bigint` till ett säkert heltal, eller kastar `DomainError("overflow")`. */
export function fromBigInt(value: bigint, what = "Beloppet"): number {
  return toSafeNumber(value, what);
}

/** Heltalsdivision avrundad nedåt (golv) för heltal, utan flyttalsdivision. */
export function floorDiv(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, "Täljaren");
  assertSafeInteger(denominator, "Nämnaren");
  if (denominator === 0) throw new DomainError("division_by_zero", "Division med noll.");
  const big = BigInt(numerator);
  const d = BigInt(denominator);
  let q = big / d;
  if (big % d !== 0n && big < 0n !== d < 0n) q -= 1n;
  return toSafeNumber(q, "Kvoten");
}

/** Heltalsdivision avrundad uppåt (tak) för heltal. */
export function ceilDiv(numerator: number, denominator: number): number {
  return -floorDiv(-numerator, denominator);
}

/** Kontrollerar att ett beräknat belopp fortfarande är ett säkert heltal. */
export function checkSafe(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError("overflow", `${what} är för stort för att räknas exakt.`);
  }
  return value;
}

/**
 * Fördelar `totalOre` på delar i proportion till `weights` så att summan blir exakt
 * `totalOre` (största-restmetoden, Hamiltons metod):
 *
 * 1. Varje del får heltalsdelen av total × vikt / summa av vikter.
 * 2. De öre som blir över (färre än antalet delar) går ett i taget till de delar som
 *    har störst rest. Lika rest → den som kommer först i listan.
 *
 * Vikterna ska vara heltal ≥ 0. Är alla vikter 0 fördelas beloppet lika.
 * Ett negativt belopp fördelas som det positiva och byter sedan tecken.
 *
 * allocateLargestRemainder(100, [1, 1, 1]) → [34, 33, 33]
 */
export function allocateLargestRemainder(totalOre: number, weights: readonly number[]): number[] {
  assertSafeInteger(totalOre, "Beloppet att fördela");
  for (let i = 0; i < weights.length; i++) assertNonNegativeInteger(weights[i], "Vikten");
  const fast = allocateSafe(totalOre, weights);
  if (fast) return fast;
  const w: bigint[] = new Array<bigint>(weights.length);
  for (let i = 0; i < weights.length; i++) w[i] = BigInt(weights[i]!);
  return allocateLargestRemainderBig(totalOre, w);
}

/**
 * Samma fördelning som `allocateLargestRemainderBig`, med vanliga tal, när alla
 * mellanresultat (total × vikt och summan av vikterna) är säkra heltal: då är `%` och
 * divisionen av (produkt − rest) exakta. Annars `null` (anroparen räknar med bigint).
 * Vikterna ska redan vara kontrollerade (heltal ≥ 0). Liggaren fördelar hyran med den
 * här vägen; med 100 000 order var bigint en stor del av tiden.
 */
function allocateSafe(totalOre: number, weights: readonly number[]): number[] | null {
  const n = weights.length;
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += weights[i]!;
    if (!Number.isSafeInteger(sum)) return null;
  }
  const w = sum === 0 ? new Array<number>(n).fill(1) : weights;
  if (sum === 0) sum = n;
  const negative = totalOre < 0;
  const total = negative ? -totalOre : totalOre;
  if (total !== 0 && sum > Math.floor(Number.MAX_SAFE_INTEGER / total)) return null;
  const base = new Array<number>(n);
  const rest = new Array<number>(n);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const p = total * w[i]!;
    const r = p % sum;
    base[i] = (p - r) / sum;
    rest[i] = r;
    allocated += base[i]!;
  }
  let leftover = total - allocated; // 0 ≤ leftover < n
  if (leftover > 0) {
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => {
      const ra = rest[a]!;
      const rb = rest[b]!;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
    for (let k = 0; k < n && leftover > 0; k++, leftover--) {
      const i = order[k]!;
      base[i] = base[i]! + 1;
    }
  }
  if (negative) for (let i = 0; i < n; i++) base[i] = base[i] === 0 ? 0 : -base[i]!;
  return base;
}

/**
 * Som `allocateLargestRemainder` men med vikter som `bigint` (≥ 0), för vikter som är
 * produkter och kan bli större än 2^53 (t.ex. nettointäkt × månadshyra).
 */
export function allocateLargestRemainderBig(
  totalOre: number,
  weights: readonly bigint[],
): number[] {
  assertSafeInteger(totalOre, "Beloppet att fördela");
  const n = weights.length;
  if (n === 0) {
    if (totalOre === 0) return [];
    throw new DomainError("invalid_input", "Det finns inget att fördela beloppet på.");
  }
  let weightSum = 0n;
  const w: bigint[] = new Array<bigint>(n);
  for (let i = 0; i < n; i++) {
    const v = weights[i]!;
    if (v < 0n) throw new DomainError("invalid_input", "Vikten får inte vara negativ.");
    w[i] = v;
    weightSum += v;
  }
  if (weightSum === 0n) {
    w.fill(1n);
    weightSum = BigInt(n);
  }
  const negative = totalOre < 0;
  const total = BigInt(negative ? -totalOre : totalOre);

  const base: bigint[] = new Array<bigint>(n);
  const rest: bigint[] = new Array<bigint>(n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const p = total * w[i]!;
    base[i] = p / weightSum;
    rest[i] = p % weightSum;
    allocated += base[i]!;
  }
  let leftover = Number(total - allocated); // 0 ≤ leftover < n
  if (leftover > 0) {
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => {
      const ra = rest[a]!;
      const rb = rest[b]!;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
    for (let k = 0; k < n && leftover > 0; k++, leftover--) {
      const i = order[k]!;
      base[i] = base[i]! + 1n;
    }
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = Number(base[i]!);
    out[i] = negative ? (v === 0 ? 0 : -v) : v;
  }
  return out;
}

/**
 * Fördelar `totalOre` i proportion till vikter som får vara negativa (t.ex. varje orders
 * vinst): andel_i = total × v_i / Σv, avrundat nedåt, och resten (0..n−1 öre) läggs ett öre
 * i taget på de största resterna. Summan blir exakt `totalOre`. Är Σv = 0 används
 * `fallbackWeights` (icke-negativa) med största-restmetoden.
 */
export function allocateSignedProportional(
  totalOre: number,
  weights: readonly number[],
  fallbackWeights: readonly number[],
): number[] {
  assertSafeInteger(totalOre, "Beloppet att fördela");
  const n = weights.length;
  let sum = 0n;
  for (let i = 0; i < n; i++) {
    assertSafeInteger(weights[i], "Vikten");
    sum += BigInt(weights[i]!);
  }
  if (sum === 0n) return allocateLargestRemainder(totalOre, fallbackWeights);
  // Normalisera så att nämnaren är positiv: total × v / Σv = (−total) × v / (−Σv).
  const sign = sum < 0n ? -1n : 1n;
  const total = BigInt(totalOre) * sign;
  const den = sum * sign;
  const base: bigint[] = new Array<bigint>(n);
  const rest: bigint[] = new Array<bigint>(n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const num = total * BigInt(weights[i]!);
    let q = num / den;
    let r = num % den;
    if (r < 0n) {
      q -= 1n;
      r += den;
    }
    base[i] = q;
    rest[i] = r;
    allocated += q;
  }
  let left = BigInt(totalOre) - allocated;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    rest[b]! > rest[a]! ? 1 : rest[b]! < rest[a]! ? -1 : a - b,
  );
  for (let k = 0; left > 0n; k++, left--) base[order[k % n]!]! += 1n;
  return base.map((v) => Number(v));
}
