/**
 * Robust statistik med exakta bråk: median, MAD (median absolute deviation) och robust z.
 *
 * Medianen och MAD påverkas inte av enstaka extrema värden, till skillnad från medelvärde
 * och standardavvikelse. Därför används de för att avgöra om ett inköp är ovanligt billigt
 * eller dyrt och för att uppskatta "typisk" försäljning efter ett släpp.
 *
 *   median     = mittvärdet (snittet av de två mittersta vid jämnt antal)
 *   MAD        = median(|x − median|)
 *   robust z   = 0,6745 × (x − median) / MAD
 *
 * Konstanten 0,6745 gör att robust z motsvarar ett vanligt z-värde för normalfördelad data.
 * Gränsen 3,5 är Iglewicz och Hoaglins standard för avvikande värden.
 */

import { DomainError } from "@/domain";
import { Ratio } from "../expansion/common";

/** 0,6745 i tiotusendelar. */
export const MAD_CONSISTENCY_E4 = 6745;

function toRatio(v: number | Ratio): Ratio {
  if (v instanceof Ratio) return v;
  if (!Number.isSafeInteger(v)) {
    throw new DomainError("invalid_input", `Värdet måste vara ett heltal, fick ${String(v)}.`);
  }
  return new Ratio(v);
}

/**
 * Medianen som exakt bråk. `null` för en tom lista.
 * median([3, 1, 2]) → 2, median([1, 2, 3, 10]) → 5/2.
 */
export function median(values: readonly (number | Ratio)[]): Ratio | null {
  if (values.length === 0) return null;
  const sorted = values.map(toRatio).sort((a, b) => a.compare(b));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return sorted[mid - 1]!.add(sorted[mid]!).div(2);
}

/**
 * MAD: medianen av de absoluta avvikelserna från `center` (standard: medianen). `null` för
 * en tom lista. mad([1, 2, 3, 4, 100]) → 1 (avvikelser 2, 1, 0, 1, 97).
 */
export function medianAbsoluteDeviation(
  values: readonly (number | Ratio)[],
  center?: Ratio,
): Ratio | null {
  const c = center ?? median(values);
  if (c === null) return null;
  const dev = values.map((v) => {
    const d = toRatio(v).sub(c);
    return d.sign() < 0 ? d.mul(-1) : d;
  });
  return median(dev);
}

/**
 * Robust z = 0,6745 × (x − median) / MAD som exakt bråk. `null` när MAD är 0 (alla
 * tidigare värden lika, eller mer än hälften lika): då finns ingen spridning att jämföra med.
 */
export function robustZ(x: number | Ratio, center: Ratio, mad: Ratio): Ratio | null {
  if (mad.sign() === 0) return null;
  return toRatio(x).sub(center).mul(MAD_CONSISTENCY_E4).div(mad.mul(10_000));
}
