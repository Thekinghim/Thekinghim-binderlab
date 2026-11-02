/**
 * Prognosmodellen för en serie (titel × automat): veckodagsjusterat, viktat glidande medel
 * med trend. Allt räknas med heltal (tusendelar av pack, bp) och `bigint` där produkter kan
 * bli stora, så att samma historik alltid ger exakt samma prognos.
 *
 * Modellen i ord (med W = antal veckor historik, standard 8):
 *
 * 1. **Dagar med data.** Bara dagar då titeln gick att köpa räknas: automaten i drift,
 *    titeln såld minst en gång tidigare och inte slutsåld. Övriga dagar räknas varken som
 *    försäljning eller som dagar (en slutsåld dag är inte efterfrågan 0).
 * 2. **Veckodagsfaktorer.** Takten per veckodag delat med snittakten, krympt mot 1,0 med
 *    k "snittdagar" per veckodag: takt_d = (sålt_d + k × snittakt) / (dagar_d + k).
 *    Faktorerna skalas så att snittet är exakt 1,0 (summa 70 000 bp, största-restmetoden).
 * 3. **Nivå.** Viktat glidande medel av veckorna, vikt 1 för den äldsta och W för den
 *    senaste, räknat på veckodagsjusterade dagar:
 *    nivå = Σ vikt × sålt / Σ vikt × (Σ veckodagsfaktor för veckans dagar med data).
 *    En vecka med bara helgdagar jämförs alltså med helgdagarnas faktor, inte med 7 dagar.
 * 4. **Trend.** Takten i den senare halvan av historiken minus takten i den tidigare,
 *    delat med avståndet mellan halvornas mittpunkter (W/2 veckor) = förändring per vecka.
 *    Räknas bara när båda halvorna har tillräckligt många dagar och pack.
 * 5. **Prognos för dag h** efter historikens slut:
 *    bas = nivå + trend × (eftersläpning + (h − ½)/7) veckor, begränsad till nivå × (1 ± maxTrend)
 *    och ≥ 0 (dagens mittpunkt ligger h − ½ dagar efter historikens slut);
 *    prognos = bas × veckodagsfaktor. Eftersläpningen är hur många veckor bakåt nivåns
 *    viktade medelpunkt ligger (ett viktat medel beskriver läget en bit tillbaka i tiden).
 */

import {
  addDays,
  allocateLargestRemainderBig,
  dayOfWeek,
  roundHalfUp,
  type IsoDate,
} from "@/domain";
import { safeNumber } from "./common";
import type { ForecastComponents, HistoryWeek } from "./types";

/** Daglig historik för en serie. */
export interface DailyHistory {
  /** Datum för index 0. */
  readonly start: IsoDate;
  /** Sålda pack per dag. */
  readonly units: readonly number[];
  /** Om dagen räknas (titeln gick att köpa). */
  readonly available: readonly boolean[];
}

/** Modellens parametrar (se `ForecastOptions`). */
export interface ModelSettings {
  readonly historyWeeks: number;
  readonly weekdayPriorDays: number;
  readonly maxTrendBp: number;
  readonly trendMinDaysPerHalf: number;
  readonly trendMinUnits: number;
}

/** Veckodagens index 0 (måndag) … 6 (söndag) för index `i` i historiken. */
function weekdayIndex(startWeekday: number, i: number): number {
  return (((startWeekday - 1 + i) % 7) + 7) % 7;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * Anpassar modellen på de `historyWeeks` × 7 dagar som slutar med index `endIndex`
 * (inklusive). Dagar före index 0 räknas som dagar utan data.
 * Ger `null` när historiken saknar dagar med data.
 */
export function fitModel(
  history: DailyHistory,
  endIndex: number,
  settings: ModelSettings,
): ForecastComponents | null {
  const W = settings.historyWeeks;
  const span = 7 * W;
  const firstIndex = endIndex - span + 1;
  const startWeekday = dayOfWeek(history.start);

  // 1–2. Takt per veckodag.
  const unitsByDay = [0, 0, 0, 0, 0, 0, 0];
  const daysByDay = [0, 0, 0, 0, 0, 0, 0];
  let U = 0;
  let N = 0;
  for (let i = Math.max(0, firstIndex); i <= endIndex; i++) {
    if (!history.available[i]) continue;
    const u = history.units[i] ?? 0;
    const d = weekdayIndex(startWeekday, i);
    unitsByDay[d] = unitsByDay[d]! + u;
    daysByDay[d] = daysByDay[d]! + 1;
    U += u;
    N += 1;
  }
  if (N === 0) return null;

  let factors: number[];
  if (U === 0) {
    factors = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
  } else {
    const k = BigInt(settings.weekdayPriorDays);
    const bigU = BigInt(U);
    const bigN = BigInt(N);
    // takt_d i miljondelar: (sålt_d × N + k × U) / (N × (dagar_d + k)).
    const rates = unitsByDay.map((u, d) => {
      const n = BigInt(daysByDay[d]!);
      const den = bigN * (n + k);
      if (den === 0n) return (1_000_000n * bigU) / bigN;
      return (1_000_000n * (BigInt(u) * bigN + k * bigU)) / den;
    });
    factors = allocateLargestRemainderBig(70_000, rates);
  }

  // 3. Nivå per vecka.
  const weeks: HistoryWeek[] = [];
  const weekUnits: number[] = [];
  const weekFactorDays: number[] = [];
  const weekAvail: number[] = [];
  for (let k = 1; k <= W; k++) {
    const last = endIndex - 7 * (W - k);
    const first = last - 6;
    let u = 0;
    let f = 0;
    let n = 0;
    for (let i = Math.max(0, first); i <= last; i++) {
      if (!history.available[i]) continue;
      u += history.units[i] ?? 0;
      f += factors[weekdayIndex(startWeekday, i)]!;
      n += 1;
    }
    weekUnits.push(u);
    weekFactorDays.push(f);
    weekAvail.push(n);
    weeks.push({
      start: addDays(history.start, first),
      end: addDays(history.start, last),
      units: u,
      availableDays: n,
      weight: k,
    });
  }

  let levelNum = 0n;
  let levelDen = 0n;
  let lagNum = 0n;
  for (let k = 1; k <= W; k++) {
    const kb = BigInt(k);
    const f = BigInt(weekFactorDays[k - 1]!);
    levelNum += kb * BigInt(weekUnits[k - 1]!);
    levelDen += kb * f;
    // Veckans mittpunkt ligger (W − k + ½) veckor före slutet.
    lagNum += kb * f * BigInt(2 * W - 2 * k + 1);
  }
  const levelMilli = levelDen > 0n ? roundHalfUp(levelNum * 10_000_000n, levelDen) : 0;
  let lagDen = 2n * levelDen;
  if (lagDen === 0n) {
    lagNum = 0n;
    lagDen = 1n;
  } else {
    const g = gcd(lagNum, lagDen);
    if (g > 1n) {
      lagNum /= g;
      lagDen /= g;
    }
  }

  // 4. Trend: senare halvan mot tidigare halvan.
  const half = Math.floor(W / 2);
  let uOld = 0;
  let fOld = 0;
  let dOld = 0;
  let uNew = 0;
  let fNew = 0;
  let dNew = 0;
  for (let k = 1; k <= W; k++) {
    if (k <= half) {
      uOld += weekUnits[k - 1]!;
      fOld += weekFactorDays[k - 1]!;
      dOld += weekAvail[k - 1]!;
    } else {
      uNew += weekUnits[k - 1]!;
      fNew += weekFactorDays[k - 1]!;
      dNew += weekAvail[k - 1]!;
    }
  }
  let trendMilliPerWeek = 0;
  let trendNote: string | null = null;
  if (half < 1) {
    trendNote = "För kort historik för trend (minst 2 veckor).";
  } else if (dOld < settings.trendMinDaysPerHalf || dNew < settings.trendMinDaysPerHalf) {
    trendNote = `Trenden räknas inte: färre än ${settings.trendMinDaysPerHalf} dagar med data i någon halva av historiken.`;
  } else if (uOld + uNew < settings.trendMinUnits) {
    trendNote = `Trenden räknas inte: färre än ${settings.trendMinUnits} sålda pack i historiken.`;
  } else if (fOld === 0 || fNew === 0) {
    trendNote = "Trenden räknas inte: veckodagarna med data saknar försäljning.";
  } else {
    // (takt_ny − takt_gammal) / (W/2) i tusendelar per vecka.
    const num = 2n * 10_000_000n * (BigInt(uNew) * BigInt(fOld) - BigInt(uOld) * BigInt(fNew));
    const den = BigInt(W) * BigInt(fNew) * BigInt(fOld);
    trendMilliPerWeek = roundHalfUp(num, den);
  }

  let units = 0;
  let availableDays = 0;
  for (let k = 0; k < W; k++) {
    units += weekUnits[k]!;
    availableDays += weekAvail[k]!;
  }

  return {
    origin: addDays(history.start, endIndex),
    history: { start: addDays(history.start, firstIndex), end: addDays(history.start, endIndex) },
    levelMilli,
    weekdayFactorsBp: factors,
    trendMilliPerWeek,
    trendApplied: trendNote === null,
    trendNote,
    levelLagWeeks: {
      num: safeNumber(lagNum, "Eftersläpningen"),
      den: safeNumber(lagDen, "Eftersläpningen"),
    },
    weeks,
    units,
    availableDays,
    excludedDays: span - availableDays,
  };
}

/** Prognosen för en dag. */
export interface DayPrediction {
  readonly date: IsoDate;
  readonly weekday: number;
  readonly baseMilli: number;
  readonly trendMilli: number;
  readonly factorBp: number;
  readonly unitsMilli: number;
}

/**
 * Prognosen för dag `h` (1 = dagen efter historikens slut):
 * bas = nivå + trend × (eftersläpning + (h − ½)/7), begränsad till nivå × (1 ± maxTrendBp) och ≥ 0,
 * prognos = bas × veckodagsfaktor / 10 000.
 */
export function predictDay(c: ForecastComponents, h: number, maxTrendBp: number): DayPrediction {
  const date = addDays(c.origin, h);
  const weekday = dayOfWeek(date);
  const level = c.levelMilli;
  let trend = 0;
  if (c.trendApplied && c.trendMilliPerWeek !== 0) {
    const ln = BigInt(c.levelLagWeeks.num);
    const ld = BigInt(c.levelLagWeeks.den);
    // Dag h har sin mittpunkt h − ½ dagar efter slutet:
    // trend × (num/den + (2h − 1)/14) = trend × (14·num + (2h − 1)·den) / (14·den)
    trend = roundHalfUp(
      BigInt(c.trendMilliPerWeek) * (14n * ln + BigInt(2 * h - 1) * ld),
      14n * ld,
    );
  }
  const lo = roundHalfUp(level * Math.max(0, 10_000 - maxTrendBp), 10_000);
  const hi = roundHalfUp(level * (10_000 + maxTrendBp), 10_000);
  const base = Math.max(0, Math.min(hi, Math.max(lo, level + trend)));
  const factorBp = c.weekdayFactorsBp[weekday - 1] ?? 10_000;
  return {
    date,
    weekday,
    baseMilli: base,
    trendMilli: base - level,
    factorBp,
    unitsMilli: roundHalfUp(base * factorBp, 10_000),
  };
}
