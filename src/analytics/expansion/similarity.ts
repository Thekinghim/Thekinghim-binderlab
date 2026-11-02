/**
 * Likhet mellan butiker, för uppskattningar av nya platser.
 *
 * Fyra attribut jämförs, var och en med en vikt i bp (standard summerar till 10 000):
 *
 * | Attribut              | Standardvikt | Matchning                                              |
 * | --------------------- | ------------ | ------------------------------------------------------ |
 * | Butikstyp             | 4 000        | samma (skiftläge och mellanslag spelar ingen roll) = 100 %, annars 0 |
 * | Ort                   | 2 500        | samma = 100 %, annars 0                                |
 * | Öppettimmar per vecka | 2 000        | 100 % − |a − b| / max(a, b)                            |
 * | Yta (m²)              | 1 500        | 100 % − |a − b| / max(a, b)                            |
 *
 * Likhet = round(Σ vikt × matchning / Σ vikt), i bp. Ett okänt värde (hos någon av
 * butikerna) ger 0 för attributet. Det är försiktigt: en butik vi vet lite om liknar
 * inget särskilt.
 */

import { DomainError, roundHalfUp, BP_SCALE } from "@/domain";
import { formatInt, NBSP } from "@/lib/format";
import type { StoreAttributes, StoreProfile } from "./types";

/** Attribut som jämförs. */
export type SimilarityAttribute = "storeType" | "city" | "openHours" | "area";

/** Vikter i bp per attribut. Summan måste vara > 0. */
export interface SimilarityWeights {
  readonly storeType: number;
  readonly city: number;
  readonly openHours: number;
  readonly area: number;
}

/** Standardvikter (summa 10 000). */
export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  storeType: 4_000,
  city: 2_500,
  openHours: 2_000,
  area: 1_500,
};

/** Jämförelsen av ett attribut. */
export interface SimilarityPart {
  readonly attribute: SimilarityAttribute;
  readonly weightBp: number;
  /** Hur lika värdena är, 0–10 000 bp. 0 när något värde saknas. */
  readonly matchBp: number;
  readonly targetValue: string | number | null;
  readonly candidateValue: string | number | null;
  /** T.ex. "samma butikstyp (livs)" eller "öppet 84 h/vecka mot 98 h (86 % lika)". */
  readonly text: string;
}

/** Likheten mellan målbutiken och en befintlig butik. */
export interface StoreSimilarity {
  readonly storeId: string;
  /** Likhet 0–10 000 bp. */
  readonly scoreBp: number;
  readonly parts: SimilarityPart[];
  /** Delarna i en mening: "samma butikstyp (livs), samma ort (Malmö), …". */
  readonly text: string;
}

/** Normaliserar text för jämförelse: trimmat, gemener, ett mellanslag mellan ord. */
export function normalizeAttribute(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim().replace(/\s+/g, " ").toLocaleLowerCase("sv-SE");
  return v === "" ? null : v;
}

/**
 * Hur lika två tal är, i bp: 10 000 − round(|a − b| × 10 000 / max(a, b)).
 * Båda 0 ger 10 000. Värdena måste vara heltal ≥ 0.
 */
export function numericMatchBp(a: number, b: number): number {
  for (const v of [a, b]) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new DomainError("invalid_input", `Attributet måste vara ett heltal ≥ 0, fick ${v}.`);
    }
  }
  const max = Math.max(a, b);
  if (max === 0) return BP_SCALE;
  return BP_SCALE - roundHalfUp(Math.abs(a - b) * BP_SCALE, max);
}

function assertWeights(w: SimilarityWeights): number {
  let sum = 0;
  for (const k of ["storeType", "city", "openHours", "area"] as const) {
    const v = w[k];
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new DomainError("invalid_rate", `Vikten för ${k} måste vara ett heltal ≥ 0.`);
    }
    sum += v;
  }
  if (sum === 0) throw new DomainError("invalid_rate", "Minst en vikt måste vara större än 0.");
  return sum;
}

function pctText(bp: number): string {
  return `${formatInt(roundHalfUp(bp, 100))}${NBSP}%`;
}

function textPart(
  attribute: "storeType" | "city",
  weightBp: number,
  target: string | null,
  candidate: string | null,
): SimilarityPart {
  const a = normalizeAttribute(target);
  const b = normalizeAttribute(candidate);
  const noun = attribute === "storeType" ? "butikstyp" : "ort";
  let matchBp = 0;
  let text: string;
  if (a === null || b === null) text = `${noun} okänd`;
  else if (a === b) {
    matchBp = BP_SCALE;
    text = `samma ${noun} (${candidate!.trim()})`;
  } else text = `annan ${noun} (${candidate!.trim()} mot ${target!.trim()})`;
  return { attribute, weightBp, matchBp, targetValue: target, candidateValue: candidate, text };
}

function numberPart(
  attribute: "openHours" | "area",
  weightBp: number,
  target: number | null,
  candidate: number | null,
): SimilarityPart {
  const unit = attribute === "openHours" ? `${NBSP}h/vecka` : `${NBSP}m²`;
  const shortUnit = attribute === "openHours" ? `${NBSP}h` : `${NBSP}m²`;
  const noun = attribute === "openHours" ? "öppettider" : "yta";
  if (target === null || candidate === null) {
    return {
      attribute,
      weightBp,
      matchBp: 0,
      targetValue: target,
      candidateValue: candidate,
      text: `${noun} okänd`,
    };
  }
  const matchBp = numericMatchBp(target, candidate);
  const prefix = attribute === "openHours" ? "öppet " : "";
  const text =
    matchBp === BP_SCALE
      ? `${prefix}${formatInt(candidate)}${unit} som målbutiken`
      : `${prefix}${formatInt(candidate)}${unit} mot ${formatInt(target)}${shortUnit} (${pctText(matchBp)} lika)`;
  return { attribute, weightBp, matchBp, targetValue: target, candidateValue: candidate, text };
}

/**
 * Likheten mellan en målbutik (attribut) och en befintlig butik.
 *
 * storeSimilarity({ storeType: 'livs', city: 'Malmö', openHoursPerWeek: 98, areaSqm: 400 },
 *   butikA) → { scoreBp: 9 420, parts: [...], text: "samma butikstyp (livs), samma ort (Malmö), …" }
 */
export function storeSimilarity(
  target: StoreAttributes,
  candidate: StoreProfile,
  weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS,
): StoreSimilarity {
  const total = assertWeights(weights);
  const parts: SimilarityPart[] = [
    textPart("storeType", weights.storeType, target.storeType, candidate.storeType),
    textPart("city", weights.city, target.city, candidate.city),
    numberPart("openHours", weights.openHours, target.openHoursPerWeek, candidate.openHoursPerWeek),
    numberPart("area", weights.area, target.areaSqm, candidate.areaSqm),
  ];
  let sum = 0;
  for (const p of parts) sum += p.weightBp * p.matchBp;
  return {
    storeId: candidate.id,
    scoreBp: roundHalfUp(sum, total),
    parts,
    text: parts
      .filter((p) => p.weightBp > 0)
      .map((p) => p.text)
      .join(", "),
  };
}

/**
 * Alla kandidater rangordnade efter likhet, högst först. Lika likhet → butikens id i
 * stigande ordning, så att urvalet alltid blir detsamma.
 */
export function rankBySimilarity(
  target: StoreAttributes,
  candidates: readonly StoreProfile[],
  weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS,
): StoreSimilarity[] {
  return candidates
    .map((c) => storeSimilarity(target, c, weights))
    .sort((a, b) =>
      a.scoreBp !== b.scoreBp
        ? b.scoreBp - a.scoreBp
        : a.storeId < b.storeId
          ? -1
          : a.storeId > b.storeId
            ? 1
            : 0,
    );
}
