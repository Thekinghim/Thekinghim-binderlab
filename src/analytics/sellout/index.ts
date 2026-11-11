/**
 * Slutdag: EN funktion som svarar på "vilken dag tar packen slut?".
 *
 * Runda 2: Att göra, besöksplanen, Automater och Mystery ska nämna samma dag. Alla anropar
 * sellOut(); ingen annan räknar en slutdag. Mappen ägs av spår T4.
 *
 *   utan veckoform ('flat'):    dag = from + tak(i lager / takt)     dagar kvar = golv(i lager / takt)
 *   med veckoform ('weekday'):  dagens försäljning = takt × 7 × veckodagens andel, stegat dag
 *                               för dag från dagen efter `from` tills packen är slut
 *
 * `from` är sista dagen som redan är dragen från saldot, samma konvention som domänens
 * `stockoutDate(asOf, …)`: Att göra skickar i går (dagens försäljning räknas inte i takten),
 * besöksplanen skickar i dag. Utan veckoform ger sellOut() exakt samma dag och dagar som
 * domänens `stockoutDate` och `daysOfStockLeft` (se index.test.ts), så ett anrop kan bytas
 * utan att någon siffra ändras.
 *
 * Rena funktioner: ingen databas, ingen klocka.
 */

import {
  addDays,
  assertIsoDate,
  ceilDiv,
  dayOfWeek,
  daysBetween,
  floorDiv,
  type IsoDate,
} from "@/domain";

/**
 * Andel av veckans försäljning per veckodag, måndag först (index = dayOfWeek(dag) − 1).
 * Behöver inte summera till exakt 1: sellOut() normerar. Sju lika andelar är samma sak som
 * det platta snittet.
 */
export type WeekShare = readonly [number, number, number, number, number, number, number];

/**
 * Takten i pack per dag. Skicka helst bråket (sålda pack / dagar i fönstret, t.ex. domänens
 * `SalesVelocity`), då räknas dagen exakt med heltal. Ett decimaltal går också.
 */
export type DailyAvg = number | { readonly units: number; readonly days: number };

export interface SellOutInput {
  /** Pack kvar. Under 0 räknas som 0. */
  readonly onHand: number;
  /** Snittförsäljning per dag (se DailyAvg). */
  readonly dailyAvg: DailyAvg;
  /** Sista dagen som redan är dragen från saldot (i går eller i dag). */
  readonly from: IsoDate;
  /** Veckans form. Saknas den, eller är den ogiltig: platt snitt. */
  readonly weekShare?: WeekShare | readonly number[] | null;
}

export interface SellOut {
  /** Dagen då sista packet väntas säljas. `from` om det redan är slut. */
  readonly date: IsoDate;
  /** Hela dagar som packen räcker efter `from`. 0 om det redan är slut. */
  readonly daysLeft: number;
  /** 'weekday' = räknat med veckans form, 'flat' = platt snitt. */
  readonly basis: "weekday" | "flat";
}

/** Sju lika andelar: veckoformen för ett platt snitt. */
export const FLAT_WEEK: WeekShare = [1 / 7, 1 / 7, 1 / 7, 1 / 7, 1 / 7, 1 / 7, 1 / 7];

/** Avrundningsfel i decimaltal räknas inte som ett pack. */
const EPS = 1e-9;

/** Längre fram än så här stegas inte: då är formen meningslös och snittet räcker. */
const MAX_STEP_DAYS = 3660;

/** Sista dagen kalendern kan skriva. En slutdag efter den räknas som "tar aldrig slut". */
const LAST_DAY = "9999-12-31";

/**
 * Veckoformen normerad till summan 1, eller null när den inte går att använda (fel antal
 * dagar, negativt eller oändligt tal, summan 0).
 */
export function normalizeWeekShare(
  share: WeekShare | readonly number[] | null | undefined,
): WeekShare | null {
  if (share === null || share === undefined || share.length !== 7) return null;
  let sum = 0;
  for (const s of share) {
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0) return null;
    sum += s;
  }
  if (!(sum > 0)) return null;
  return share.map((s) => s / sum) as unknown as WeekShare;
}

function ratePerDay(avg: DailyAvg): number {
  if (typeof avg === "number") return Number.isFinite(avg) && avg > 0 ? avg : 0;
  if (!(avg.units > 0) || !(avg.days > 0)) return 0;
  return avg.units / avg.days;
}

function flat(onHand: number, avg: DailyAvg, from: IsoDate): SellOut | null {
  let ahead: number;
  let daysLeft: number;
  if (
    typeof avg !== "number" &&
    Number.isSafeInteger(onHand) &&
    Number.isSafeInteger(avg.units) &&
    Number.isSafeInteger(avg.days) &&
    Number.isSafeInteger(onHand * avg.days)
  ) {
    // Exakt med heltal, som domänens stockoutDate och daysOfStockLeft.
    ahead = ceilDiv(onHand * avg.days, avg.units);
    daysLeft = floorDiv(onHand * avg.days, avg.units);
  } else {
    const days = onHand / ratePerDay(avg);
    const nearest = Math.round(days);
    const whole = Math.abs(days - nearest) < EPS;
    ahead = whole ? nearest : Math.ceil(days);
    daysLeft = whole ? nearest : Math.floor(days);
  }
  // Så långsam takt att dagen hamnar utanför kalendern: packen tar i praktiken aldrig slut.
  if (!Number.isSafeInteger(ahead) || ahead > daysBetween(from, LAST_DAY)) return null;
  return { date: addDays(from, ahead), daysLeft, basis: "flat" };
}

/**
 * Dagen då packen tar slut.
 *
 * sellOut({ onHand: 5, dailyAvg: 1, from: "2026-11-11" })
 *   → { date: "2026-11-16", daysLeft: 5, basis: "flat" }       (onsdag + 5 dagar = måndag)
 * sellOut({ onHand: 5, dailyAvg: 1, from: "2026-11-11", weekShare })  med en stark lördag
 *   → { date: "2026-11-14", daysLeft: 3, basis: "weekday" }    (slut redan på lördag)
 *
 * Returnerar null när takten är 0: packen tar aldrig slut i den takten. Samma sak när takten
 * är så låg att dagen hamnar efter år 9999 (aldrig ett fel). Tomt fack (0 pack) med en takt
 * ger `from` och 0 dagar.
 */
export function sellOut(input: SellOutInput): SellOut | null {
  assertIsoDate(input.from, "Startdagen");
  const rate = ratePerDay(input.dailyAvg);
  if (rate === 0) return null;
  const share = normalizeWeekShare(input.weekShare);
  const basis: SellOut["basis"] = share === null ? "flat" : "weekday";
  const onHand = Number.isFinite(input.onHand) ? Math.max(0, input.onHand) : 0;
  if (onHand === 0) return { date: input.from, daysLeft: 0, basis };
  if (share === null) return flat(onHand, input.dailyAvg, input.from);

  // Hela veckor säljer takt × 7 oavsett form: hoppa över dem, men lämna alltid minst en
  // veckas pack kvar så att stegningen hittar rätt dag.
  const perWeek = rate * 7;
  const weeks = Math.max(0, Math.ceil(onHand / perWeek - EPS) - 1);
  // Mer än tio år fram: platt snitt, och svaret säger det (basis 'flat').
  if (weeks * 7 > MAX_STEP_DAYS) return flat(onHand, input.dailyAvg, input.from);
  let left = onHand - weeks * perWeek;
  let days = weeks * 7;
  let date = days === 0 ? input.from : addDays(input.from, days);
  // Högst en vecka kvar: sju steg räcker (ett åttonde bara för avrundningsfel).
  for (let step = 0; step < 8; step++) {
    date = addDays(date, 1);
    left -= perWeek * share[dayOfWeek(date) - 1]!;
    if (left < -EPS) return { date, daysLeft: days, basis };
    days += 1;
    if (left <= EPS) return { date, daysLeft: days, basis };
  }
  return { date, daysLeft: days, basis };
}
