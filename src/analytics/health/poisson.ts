/**
 * Poissonfördelningen för antal sålda pack under en tid.
 *
 * Om automaten i genomsnitt säljer λ pack under en viss tid (räknat från samma veckodagar och
 * timmar i historiken) och köpen kommer oberoende av varandra, är antalet köp Poisson(λ):
 *
 *   P(X = 0)  = e^−λ
 *   P(X ≤ k)  = Σ_{i=0..k} e^−λ λ^i / i!
 *   P(X ≥ k)  = 1 − P(X ≤ k − 1)
 *
 * Sannolikheterna är statistik, inte pengar, och räknas med flyttal. Resultatet avrundas till
 * hela bp innan det visas eller jämförs med en gräns i bp, så att samma indata alltid ger
 * samma svar. Summorna räknas i logaritmer för att inte tappa precision vid stora λ.
 */

import { BP_SCALE, DomainError } from "@/domain";

function assertLambda(lambda: number): void {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new DomainError("invalid_input", `Förväntat antal måste vara ≥ 0, fick ${lambda}.`);
  }
}

function assertK(k: number): void {
  if (!Number.isSafeInteger(k)) {
    throw new DomainError("invalid_input", `Antalet måste vara ett heltal, fick ${k}.`);
  }
}

/** Sannolikheten för noll händelser: e^−λ. poissonZero(4.6) ≈ 0,01. */
export function poissonZero(lambda: number): number {
  assertLambda(lambda);
  return Math.exp(-lambda);
}

/** P(X ≤ k). poissonCdf(0, λ) = e^−λ; k < 0 ger 0. */
export function poissonCdf(k: number, lambda: number): number {
  assertLambda(lambda);
  assertK(k);
  if (k < 0) return 0;
  if (lambda === 0) return 1;
  // log(e^−λ λ^i / i!) räknas stegvis: term_i = term_{i−1} + log λ − log i.
  let logTerm = -lambda;
  let sum = Math.exp(logTerm);
  const logLambda = Math.log(lambda);
  for (let i = 1; i <= k; i++) {
    logTerm += logLambda - Math.log(i);
    sum += Math.exp(logTerm);
  }
  return Math.min(1, sum);
}

/**
 * P(X ≥ k). k ≤ 0 ger 1. När k > λ summeras svansen direkt (från k och uppåt) i stället för
 * 1 − P(X ≤ k − 1), så att små sannolikheter inte försvinner i avrundningen.
 */
export function poissonSf(k: number, lambda: number): number {
  assertLambda(lambda);
  assertK(k);
  if (k <= 0) return 1;
  if (lambda === 0) return 0;
  if (k <= lambda) return Math.max(0, 1 - poissonCdf(k - 1, lambda));
  const logLambda = Math.log(lambda);
  let logTerm = -lambda;
  for (let i = 1; i <= k; i++) logTerm += logLambda - Math.log(i);
  let sum = 0;
  for (let i = k; i < k + 10_000; i++) {
    if (i > k) logTerm += logLambda - Math.log(i);
    const term = Math.exp(logTerm);
    sum += term;
    if (term < sum * 1e-15) break;
  }
  return Math.min(1, sum);
}

/** Sannolikhet (0–1) → hela bp, avrundat: 0,00234 → 23. */
export function probabilityToBp(p: number): number {
  return Math.round(p * BP_SCALE);
}
