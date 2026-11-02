/**
 * Backtest med rullande ursprung: modellen anpassas på historiken fram till ett ursprung,
 * förutsäger de följande dagarna och jämförs med utfallet. Ursprungen ligger en vecka isär
 * (standard 6 ursprung à 7 dagar), så att träffsäkerheten mäts på data som modellen inte sett.
 *
 * Måtten (alla i bp, 10 000 = 100 %):
 * - **WAPE** = Σ |prognos − utfall| / Σ utfall över alla dagar. Tål dagar med 0 sålda.
 * - **MAPE** = snittet av |prognos − utfall| / utfall per ursprung, där prognos och utfall är
 *   summan över ursprungets dagar (en procentsats per vecka). Ursprung utan försäljning hoppas över.
 * - **Bias** = Σ (prognos − utfall) / Σ utfall. Positivt = prognosen var för hög.
 * - **Enkel jämförelse** = WAPE om man i stället gissat snittet de 7 dagarna före ursprunget.
 *
 * Bara dagar då titeln gick att köpa jämförs (en slutsåld dag har inget mätbart utfall).
 */

import { addDays, roundHalfUp } from "@/domain";
import { MILLI } from "./common";
import { fitModel, predictDay, type DailyHistory, type ModelSettings } from "./model";
import type { AccuracyMetrics, BacktestOrigin, BacktestPoint } from "./types";

/** Backtestens upplägg. */
export interface BacktestSettings {
  readonly origins: number;
  readonly horizonDays: number;
  readonly stepDays: number;
}

/**
 * Kör backtesten för en serie. Ursprung j (0, 1, …) ligger `horizonDays + j × stepDays`
 * dagar före `endIndex`, så att varje förutsagd dag har ett utfall. Ursprung utan historik
 * eller utan dagar med data hoppas över.
 */
export function backtestHistory(
  history: DailyHistory,
  endIndex: number,
  model: ModelSettings,
  bt: BacktestSettings,
): { origins: BacktestOrigin[]; points: BacktestPoint[] } {
  const origins: BacktestOrigin[] = [];
  const points: BacktestPoint[] = [];
  for (let j = bt.origins - 1; j >= 0; j--) {
    const o = endIndex - bt.horizonDays - j * bt.stepDays;
    if (o < 0) continue;
    const c = fitModel(history, o, model);
    if (!c) continue;

    // Enkel jämförelse: snittet de 7 dagarna t.o.m. ursprunget.
    let nu = 0;
    let nd = 0;
    for (let i = Math.max(0, o - 6); i <= o; i++) {
      if (!history.available[i]) continue;
      nu += history.units[i] ?? 0;
      nd += 1;
    }
    const naiveMilli = nd > 0 ? roundHalfUp(nu * MILLI, nd) : 0;

    let a = 0;
    let f = 0;
    let n = 0;
    let days = 0;
    for (let h = 1; h <= bt.horizonDays; h++) {
      const idx = o + h;
      if (!history.available[idx]) continue;
      const p = predictDay(c, h, model.maxTrendBp);
      const actual = (history.units[idx] ?? 0) * MILLI;
      points.push({
        origin: c.origin,
        date: p.date,
        actualMilli: actual,
        forecastMilli: p.unitsMilli,
        naiveMilli,
      });
      a += actual;
      f += p.unitsMilli;
      n += naiveMilli;
      days += 1;
    }
    if (days === 0) continue;
    origins.push({
      origin: c.origin,
      period: { start: addDays(c.origin, 1), end: addDays(c.origin, bt.horizonDays) },
      days,
      actualMilli: a,
      forecastMilli: f,
      naiveMilli: n,
    });
  }
  return { origins, points };
}

/**
 * Träffsäkerhet för backtestens punkter och ursprung. Måtten är `null` när utfallet är 0
 * (inget att jämföra med); MAPE räknas bara på ursprung med försäljning.
 */
export function accuracyMetrics(
  points: readonly Pick<BacktestPoint, "actualMilli" | "forecastMilli" | "naiveMilli">[],
  origins: readonly Pick<BacktestOrigin, "actualMilli" | "forecastMilli">[],
): AccuracyMetrics {
  let sumA = 0;
  let sumF = 0;
  let sumAbs = 0;
  let sumNaiveAbs = 0;
  for (const p of points) {
    sumA += p.actualMilli;
    sumF += p.forecastMilli;
    sumAbs += Math.abs(p.forecastMilli - p.actualMilli);
    sumNaiveAbs += Math.abs(p.naiveMilli - p.actualMilli);
  }
  let apeSum = 0;
  let apeCount = 0;
  for (const o of origins) {
    if (o.actualMilli <= 0) continue;
    apeSum += roundHalfUp(Math.abs(o.forecastMilli - o.actualMilli) * 10_000, o.actualMilli);
    apeCount += 1;
  }
  const rel = (x: number): number | null => (sumA > 0 ? roundHalfUp(x * 10_000, sumA) : null);
  return {
    wapeBp: rel(sumAbs),
    mapeBp: apeCount > 0 ? roundHalfUp(apeSum, apeCount) : null,
    biasBp: rel(sumF - sumA),
    naiveWapeBp: rel(sumNaiveAbs),
    points: points.length,
    origins: origins.length,
    actualMilli: sumA,
    forecastMilli: sumF,
  };
}

/**
 * Residualvariansen per dag i milli²: Σ (prognos − utfall)² / antal punkter.
 * `null` när backtesten saknar punkter.
 */
export function residualVariance(
  points: readonly Pick<BacktestPoint, "actualMilli" | "forecastMilli">[],
): number | null {
  if (points.length === 0) return null;
  let s = 0n;
  for (const p of points) {
    const e = BigInt(p.forecastMilli - p.actualMilli);
    s += e * e;
  }
  return roundHalfUp(s, BigInt(points.length));
}
