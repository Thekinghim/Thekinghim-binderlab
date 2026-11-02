/**
 * Reglerna bakom Värt att veta. Varje regel returnerar noll eller fler kandidater med
 * poäng; computeInsights väljer bland dem. Poängen är grov men förklarbar:
 *
 *   förlust per titel        9 000 + antal order (högst 999)
 *   stillastående automat    8 000 + 10 × uteblivna pack (högst 1 999)
 *   ökning/minskning titel   5 000 + |förändring i bp| / 5 (högst 2 000) + pack (högst 999)
 *   koncentration            4 000 + (andel − 25 %) i bp / 5 (högst 1 500)
 *   veckodagsmönster         3 500 + ökning i bp / 10 (högst 1 500)
 *   bästa dag                3 000 + (kvot − 1,5) i bp / 10 (högst 1 500)
 */

import {
  addDays,
  dailyUnits,
  dayOfWeek,
  daysBetween,
  eachDay,
  monthEnd,
  monthStart,
  periodDays,
  ratioBp,
  revenue,
  roundHalfUp,
  salesVelocity,
  titleEconomics,
  type IsoDate,
  type Period,
} from "@/domain";
import { evidence, isMachineActive, links } from "../todos/common";
import {
  capitalize,
  day,
  kr,
  krExact,
  pct,
  periodText,
  plural,
  ratioTenths,
  sentence,
  tenths,
  weekdayName,
  weekdayPlural,
} from "../todos/text";
import type { AnalyticsOrder } from "../todos/types";
import type { Insight, InsightContext } from "./types";

// ---------------------------------------------------------------------------
// Gränser
// ---------------------------------------------------------------------------

/** Koncentration: minsta andel av intäkten för en titel (bp). */
export const CONCENTRATION_MIN_SHARE_BP = 2_500;
/** Koncentration: minsta antal order i perioden och sålda titlar. */
export const CONCENTRATION_MIN_ORDERS = 20;
export const CONCENTRATION_MIN_TITLES = 3;

/** Stillastående automat: minsta antal dagar utan försäljning och uteblivna pack. */
export const STALE_MIN_DAYS = 2;
export const STALE_MIN_EXPECTED_UNITS = 3;
/** Fönster för automatens normala takt före tystnaden. */
export const STALE_RATE_WINDOW_DAYS = 14;

/** Titel vecka mot vecka: minsta volym i jämförelseperioden, minsta skillnad i pack och i procent. */
export const CHANGE_MIN_BASE_UNITS = 10;
export const CHANGE_MIN_DIFF_UNITS = 5;
export const CHANGE_MIN_BP = 3_000;

/** Bästa dag: periodens minsta längd, minsta kvot mot snittdagen (bp) och minsta antal order den dagen. */
export const BEST_DAY_MIN_PERIOD_DAYS = 7;
export const BEST_DAY_MIN_RATIO_BP = 15_000;
export const BEST_DAY_MIN_ORDERS = 5;

/** Veckodagsmönster: periodens minsta längd, minsta antal order och minsta ökning (bp). */
export const WEEKDAY_MIN_PERIOD_DAYS = 28;
export const WEEKDAY_MIN_ORDERS = 40;
export const WEEKDAY_MIN_LIFT_BP = 3_000;

/** Förlust: minsta antal order för titeln i perioden. */
export const LOSS_MIN_ORDERS = 3;

function groupBy<K>(
  orders: readonly AnalyticsOrder[],
  key: (o: AnalyticsOrder) => K,
): Map<K, AnalyticsOrder[]> {
  const map = new Map<K, AnalyticsOrder[]>();
  for (const o of orders) {
    const k = key(o);
    const list = map.get(k);
    if (list) list.push(o);
    else map.set(k, [o]);
  }
  return map;
}

function byKey<T>(get: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

// ---------------------------------------------------------------------------
// Koncentration
// ---------------------------------------------------------------------------

/**
 * Koncentration: en titel står för minst 25 % av intäkten i perioden.
 * Kräver minst 20 order och minst 3 sålda titlar (annars är en hög andel självklar).
 * "30th Celebration står för 33 % av intäkten"
 */
export function concentrationRule(ctx: InsightContext): Insight[] {
  const { input, orders, period } = ctx;
  if (orders.length < CONCENTRATION_MIN_ORDERS) return [];
  const byTitle = groupBy(orders, (o) => o.titleId);
  if (byTitle.size < CONCENTRATION_MIN_TITLES) return [];
  const total = revenue(orders, input.settings);
  if (total <= 0) return [];
  const rows = [...byTitle.entries()]
    .map(([titleId, list]) => ({ titleId, list, revenueOre: revenue(list, input.settings) }))
    .sort(
      (a, b) => b.revenueOre - a.revenueOre || byKey<{ titleId: string }>((r) => r.titleId)(a, b),
    );
  const top = rows[0];
  if (!top) return [];
  const shareBp = ratioBp(top.revenueOre, total) ?? 0;
  if (shareBp < CONCENTRATION_MIN_SHARE_BP) return [];
  const name = ctx.titleName(top.titleId);
  return [
    {
      key: `concentration:${top.titleId}`,
      kind: "concentration",
      score: 4_000 + Math.min(1_500, roundHalfUp(shareBp - CONCENTRATION_MIN_SHARE_BP, 5)),
      tone: "neutral",
      text: `${name} står för ${pct(shareBp)} av intäkten`,
      detail: sentence(
        `${kr(top.revenueOre)} av ${kr(total)} och ${plural(top.list.length, "order", "order")} ` +
          `av ${plural(orders.length, "order", "order")} ${periodText(period)}`,
      ),
      evidence: evidence({
        rule: "En titel står för minst 25 % av intäkten (minst 20 order och 3 titlar i perioden).",
        period,
        orderIds: top.list.map((o) => o.id),
        dates: top.list.map((o) => o.businessDate),
        titleIds: [top.titleId],
        figures: [
          { key: "titleRevenueOre", label: `Intäkt ${name}`, value: top.revenueOre, unit: "ore" },
          { key: "totalRevenueOre", label: "All intäkt", value: total, unit: "ore" },
          { key: "shareBp", label: "Andel", value: shareBp, unit: "bp" },
          { key: "titleOrders", label: `Order ${name}`, value: top.list.length, unit: "count" },
          { key: "totalOrders", label: "Alla order", value: orders.length, unit: "count" },
        ],
      }),
      link: links.profitabilityByTitle(period),
    },
  ];
}

// ---------------------------------------------------------------------------
// Stillastående automat
// ---------------------------------------------------------------------------

/**
 * Stillastående automat: en automat i drift har inte sålt sedan sin senaste försäljningsdag,
 * minst 2 dagar räknat till periodens slut, och borde vid sin vanliga takt (14 dagar t.o.m.
 * senaste försäljningsdagen) ha sålt minst 3 pack under tiden. Är periodens slut i dag räknas
 * i dag som en dag utan försäljning.
 * "Automat 3 har inte sålt på 2 dagar"
 */
export function staleMachineRule(ctx: InsightContext): Insight[] {
  const { input, period } = ctx;
  const ref = period.end;
  const byMachine = groupBy(
    input.orders.filter((o) => o.machineId !== null && o.businessDate <= ref),
    (o) => o.machineId as string,
  );
  const candidates: Insight[] = [];
  for (const m of [...input.machines].sort(byKey((x) => x.id))) {
    if (!isMachineActive(m, ref)) continue;
    const list = byMachine.get(m.id);
    if (!list || list.length === 0) continue;
    const last = list.reduce((a, b) => (b.businessDate > a.businessDate ? b : a)).businessDate;
    const silentDays = daysBetween(last, ref);
    if (silentDays < STALE_MIN_DAYS) continue;
    const v = salesVelocity(dailyUnits(list), {
      asOf: last,
      days: STALE_RATE_WINDOW_DAYS,
      ...(m.activeFrom !== null ? { activeFrom: m.activeFrom } : {}),
    });
    if (v.days === 0) continue;
    // uteblivna pack = takt × tysta dagar = units × silentDays / days
    if (v.units * silentDays < STALE_MIN_EXPECTED_UNITS * v.days) continue;
    const expected = roundHalfUp(v.units * silentDays, v.days);
    const windowOrders = list.filter((o) => o.businessDate >= v.start && o.businessDate <= v.end);
    const silentPeriod: Period = { start: addDays(last, 1), end: ref };
    candidates.push({
      key: `stale-machine:${m.id}`,
      kind: "stale-machine",
      score: 8_000 + Math.min(1_999, expected * 10),
      tone: "negative",
      text: `${m.name} har inte sålt på ${plural(silentDays, "dag", "dagar")}`,
      detail:
        `${sentence(`Senaste försäljning ${day(last)}`)} Den brukar sälja ${ratioTenths(v.units, v.days)} pack per dag, ` +
        `så ca ${plural(expected, "pack", "pack")} har uteblivit.`,
      evidence: evidence({
        rule: "Automaten i drift har inte sålt på minst 2 dagar och borde ha sålt minst 3 pack under tiden.",
        period: silentPeriod,
        orderIds: windowOrders.map((o) => o.id),
        dates: eachDay(silentPeriod.start, silentPeriod.end),
        machineIds: [m.id],
        figures: [
          { key: "silentDays", label: "Dagar utan försäljning", value: silentDays, unit: "days" },
          { key: "unitsBefore", label: "Sålda pack före tystnaden", value: v.units, unit: "packs" },
          { key: "windowDays", label: "Dagar i fönstret", value: v.days, unit: "days" },
          { key: "expectedUnits", label: "Uteblivna pack", value: expected, unit: "packs" },
        ],
      }),
      link: links.machine(m.id, period),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Ökning och minskning per titel
// ---------------------------------------------------------------------------

/** "förra veckan", "förra månaden" eller jämförelseperioden som text. */
export function compareLabel(period: Period, compare: Period): string {
  const adjacent = compare.end === addDays(period.start, -1);
  if (adjacent && periodDays(period) === 7 && periodDays(compare) === 7) return "förra veckan";
  const wholeMonth = (p: Period) =>
    p.start === monthStart(p.start.slice(0, 7)) && p.end === monthEnd(p.start.slice(0, 7));
  if (adjacent && wholeMonth(period) && wholeMonth(compare)) return "förra månaden";
  return periodText(compare);
}

/**
 * Stark ökning eller minskning för en titel mot jämförelseperioden (vecka mot vecka när
 * perioderna är två intilliggande veckor). Antal pack jämförs per dag om perioderna är olika långa.
 *
 *   förändring = (pack nu × dagar före − pack före × dagar nu) / (pack före × dagar nu)
 *
 * Slår till när titeln sålde minst 10 pack i jämförelseperioden (mindre volym är brus),
 * skillnaden är minst 5 pack och förändringen minst 30 %. Den största ökningen och den
 * största minskningen blir var sin kandidat.
 * "Mystery Pack säljer 40 % mer än förra veckan"
 */
export function titleChangeRule(ctx: InsightContext): Insight[] {
  const { orders, compareOrders, period, compare } = ctx;
  const pd = periodDays(period);
  const cd = periodDays(compare);
  const now = groupBy(orders, (o) => o.titleId);
  const before = groupBy(compareOrders, (o) => o.titleId);
  const label = compareLabel(period, compare);

  type Row = { titleId: string; cur: number; prev: number; changeBp: number };
  const rows: Row[] = [];
  for (const [titleId, prevList] of before) {
    const prev = prevList.length;
    if (prev < CHANGE_MIN_BASE_UNITS) continue;
    const cur = now.get(titleId)?.length ?? 0;
    const diff = cur * cd - prev * pd; // i "dagar före"-skala
    if (Math.abs(diff) < CHANGE_MIN_DIFF_UNITS * cd) continue;
    const changeBp = roundHalfUp(diff * 10_000, prev * pd);
    if (Math.abs(changeBp) < CHANGE_MIN_BP) continue;
    rows.push({ titleId, cur, prev, changeBp });
  }
  const pick = (sign: 1 | -1) =>
    rows
      .filter((r) => Math.sign(r.changeBp) === sign)
      .sort(
        (a, b) => Math.abs(b.changeBp) - Math.abs(a.changeBp) || byKey<Row>((r) => r.titleId)(a, b),
      )[0];

  const out: Insight[] = [];
  for (const sign of [1, -1] as const) {
    const r = pick(sign);
    if (!r) continue;
    const name = ctx.titleName(r.titleId);
    const up = sign === 1;
    const list = [...(now.get(r.titleId) ?? []), ...(before.get(r.titleId) ?? [])];
    const perDayNote = pd === cd ? "" : ", räknat per dag";
    out.push({
      key: `title-${up ? "up" : "down"}:${r.titleId}`,
      kind: up ? "title-up" : "title-down",
      score:
        5_000 +
        Math.min(2_000, roundHalfUp(Math.abs(r.changeBp), 5)) +
        Math.min(999, r.cur + r.prev),
      tone: up ? "positive" : "negative",
      text: `${name} säljer ${pct(Math.abs(r.changeBp))} ${up ? "mer" : "mindre"} än ${label}`,
      detail: `${plural(r.cur, "pack", "pack")} mot ${plural(r.prev, "pack", "pack")} (${periodText(period)} mot ${periodText(compare)}${perDayNote}).`,
      evidence: evidence({
        rule: "Titelns försäljning ändrades minst 30 % och 5 pack mot jämförelseperioden, med minst 10 pack i jämförelseperioden.",
        period,
        orderIds: list.map((o) => o.id),
        dates: list.map((o) => o.businessDate),
        titleIds: [r.titleId],
        figures: [
          { key: "units", label: "Pack i perioden", value: r.cur, unit: "packs" },
          { key: "compareUnits", label: "Pack i jämförelseperioden", value: r.prev, unit: "packs" },
          { key: "periodDays", label: "Dagar i perioden", value: pd, unit: "days" },
          { key: "compareDays", label: "Dagar i jämförelseperioden", value: cd, unit: "days" },
          { key: "changeBp", label: "Förändring", value: r.changeBp, unit: "bp" },
        ],
      }),
      link: links.title(r.titleId, period),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bästa dag
// ---------------------------------------------------------------------------

/**
 * Bästa dag: dagen med störst intäkt i perioden (vid lika: den tidigaste), när den gav
 * minst 1,5 gånger en genomsnittlig dag (all intäkt / periodens dagar), hade minst 5 order
 * och perioden är minst 7 dagar.
 * "Lördag 31 okt. var bästa dagen med 2 340 kr"
 */
export function bestDayRule(ctx: InsightContext): Insight[] {
  const { input, orders, period } = ctx;
  const pd = periodDays(period);
  if (pd < BEST_DAY_MIN_PERIOD_DAYS || orders.length === 0) return [];
  const total = revenue(orders, input.settings);
  if (total <= 0) return [];
  const byDay = groupBy(orders, (o) => o.businessDate);
  let best: { date: IsoDate; list: AnalyticsOrder[]; revenueOre: number } | null = null;
  for (const date of [...byDay.keys()].sort()) {
    const list = byDay.get(date) ?? [];
    const r = revenue(list, input.settings);
    if (!best || r > best.revenueOre) best = { date, list, revenueOre: r };
  }
  if (!best || best.list.length < BEST_DAY_MIN_ORDERS) return [];
  const ratio = roundHalfUp(best.revenueOre * pd * 10_000, total);
  if (ratio < BEST_DAY_MIN_RATIO_BP) return [];
  const avg = roundHalfUp(total, pd);
  return [
    {
      key: `best-day:${best.date}`,
      kind: "best-day",
      score: 3_000 + Math.min(1_500, roundHalfUp(ratio - BEST_DAY_MIN_RATIO_BP, 10)),
      tone: "positive",
      text: `${capitalize(weekdayName(dayOfWeek(best.date)))} ${day(best.date)} var bästa dagen med ${kr(best.revenueOre)}`,
      detail:
        `${tenths(roundHalfUp(ratio, 1_000))} gånger en genomsnittlig dag (${kr(avg)}) ${periodText(period)}, ` +
        `${plural(best.list.length, "order", "order")}.`,
      evidence: evidence({
        rule: "Dagen med störst intäkt gav minst 1,5 gånger en genomsnittlig dag (perioden minst 7 dagar, dagen minst 5 order).",
        period,
        orderIds: best.list.map((o) => o.id),
        dates: [best.date],
        figures: [
          {
            key: "dayRevenueOre",
            label: "Intäkt bästa dagen",
            value: best.revenueOre,
            unit: "ore",
          },
          { key: "averageDayOre", label: "Genomsnittlig dag", value: avg, unit: "ore" },
          { key: "ratioBp", label: "Kvot mot snittdagen", value: ratio, unit: "bp" },
          { key: "dayOrders", label: "Order bästa dagen", value: best.list.length, unit: "count" },
        ],
      }),
      link: links.salesDay(best.date),
    },
  ];
}

// ---------------------------------------------------------------------------
// Veckodagsmönster
// ---------------------------------------------------------------------------

/**
 * Veckodagsmönster: den veckodag som i snitt ger mest intäkt, när den ger minst 30 % mer
 * än en genomsnittlig dag. Snittet per veckodag = intäkt de dagarna / antal sådana dagar i
 * perioden (även dagar utan försäljning). Kräver minst 28 dagar (minst 4 av varje veckodag)
 * och minst 40 order.
 * "Lördagar ger 45 % mer intäkt än en genomsnittlig dag"
 */
export function weekdayPatternRule(ctx: InsightContext): Insight[] {
  const { input, orders, period } = ctx;
  const pd = periodDays(period);
  if (pd < WEEKDAY_MIN_PERIOD_DAYS || orders.length < WEEKDAY_MIN_ORDERS) return [];
  const total = revenue(orders, input.settings);
  if (total <= 0) return [];
  const days = eachDay(period.start, period.end);
  const dayCount = new Array<number>(8).fill(0);
  for (const d of days) dayCount[dayOfWeek(d)] = (dayCount[dayOfWeek(d)] ?? 0) + 1;
  const byWeekday = groupBy(orders, (o) => dayOfWeek(o.businessDate));
  let best: { wd: number; sum: number; count: number; list: AnalyticsOrder[] } | null = null;
  for (let wd = 1; wd <= 7; wd++) {
    const list = byWeekday.get(wd) ?? [];
    const sum = revenue(list, input.settings);
    const count = dayCount[wd] ?? 0;
    if (count === 0) continue;
    // sum/count > best.sum/best.count  ⇔  sum × best.count > best.sum × count
    if (!best || sum * best.count > best.sum * count) best = { wd, sum, count, list };
  }
  if (!best) return [];
  const liftBp = roundHalfUp(best.sum * pd * 10_000, best.count * total) - 10_000;
  if (liftBp < WEEKDAY_MIN_LIFT_BP) return [];
  const bestWd = best.wd;
  return [
    {
      key: `weekday-pattern:${bestWd}`,
      kind: "weekday-pattern",
      score: 3_500 + Math.min(1_500, roundHalfUp(liftBp, 10)),
      tone: "neutral",
      text: `${capitalize(weekdayPlural(bestWd))} ger ${pct(liftBp)} mer intäkt än en genomsnittlig dag`,
      detail:
        `Snitt ${kr(roundHalfUp(best.sum, best.count))} per ${weekdayName(bestWd)} mot ${kr(roundHalfUp(total, pd))} ` +
        `per dag ${periodText(period)} (${plural(best.count, weekdayName(bestWd), weekdayPlural(bestWd))}).`,
      evidence: evidence({
        rule: "En veckodag ger i snitt minst 30 % mer intäkt än en genomsnittlig dag (minst 28 dagar och 40 order).",
        period,
        orderIds: best.list.map((o) => o.id),
        dates: days.filter((d) => dayOfWeek(d) === bestWd),
        figures: [
          { key: "weekday", label: "Veckodag (1 = måndag)", value: bestWd, unit: "count" },
          { key: "weekdayRevenueOre", label: "Intäkt de dagarna", value: best.sum, unit: "ore" },
          { key: "weekdayCount", label: "Antal sådana dagar", value: best.count, unit: "days" },
          { key: "totalRevenueOre", label: "All intäkt", value: total, unit: "ore" },
          { key: "periodDays", label: "Dagar i perioden", value: pd, unit: "days" },
          { key: "liftBp", label: "Mer än snittdagen", value: liftBp, unit: "bp" },
        ],
      }),
      link: links.salesWeekdays(period),
    },
  ];
}

// ---------------------------------------------------------------------------
// Titel med förlust
// ---------------------------------------------------------------------------

/**
 * Titel med förlust: med dagens inköpspris (periodens sista dag) blir det ingenting eller
 * mindre än ingenting kvar per pack efter inköp, kortavgift och provision (titleEconomics,
 * hyra exkluderad). Kräver minst 3 order. Titeln med störst total förlust väljs.
 * "Black Bolt går med förlust: −3,50 kr per pack"
 */
export function lossTitleRule(ctx: InsightContext): Insight[] {
  const { input, orders, period } = ctx;
  if (orders.length === 0) return [];
  const rows = titleEconomics({
    orders,
    period,
    prices: input.prices,
    agreements: input.agreements,
    placements: input.placements,
    settings: input.settings,
    asOf: period.end,
  }).filter((t) => t.lossWarning && t.orders >= LOSS_MIN_ORDERS && t.leftPerOrderOre !== null);
  if (rows.length === 0) return [];
  rows.sort(
    (a, b) =>
      (a.leftPerOrderOre ?? 0) * a.orders - (b.leftPerOrderOre ?? 0) * b.orders ||
      byKey<{ titleId: string }>((r) => r.titleId)(a, b),
  );
  const t = rows[0];
  if (!t) return [];
  const left = t.leftPerOrderOre ?? 0;
  const name = ctx.titleName(t.titleId);
  const list = orders.filter((o) => o.titleId === t.titleId);
  const fee = t.averageFeeOre ?? 0;
  return [
    {
      key: `loss-title:${t.titleId}`,
      kind: "loss-title",
      score: 9_000 + Math.min(999, t.orders),
      tone: "negative",
      text:
        left === 0
          ? `${name} går jämnt ut: ${krExact(0)} kvar per pack`
          : `${name} går med förlust: ${krExact(left)} per pack`,
      detail:
        `Snittpris ${krExact(t.averagePriceOre ?? 0)}, inköpspris ${krExact(t.currentUnitCostOre ?? 0)}, ` +
        `provision ${krExact(t.averageCommissionOre ?? 0)}` +
        (fee !== 0 ? `, kortavgift ${krExact(fee)}` : "") +
        ` per pack (${plural(t.orders, "order", "order")} ${periodText(period)}).`,
      evidence: evidence({
        rule: "Med aktuellt inköpspris blir högst 0 kr kvar per pack efter inköp, kortavgift och provision (minst 3 order).",
        period,
        orderIds: list.map((o) => o.id),
        dates: list.map((o) => o.businessDate),
        titleIds: [t.titleId],
        figures: [
          {
            key: "averagePriceOre",
            label: "Snittpris",
            value: t.averagePriceOre ?? 0,
            unit: "ore",
          },
          {
            key: "unitCostOre",
            label: "Inköpspris",
            value: t.currentUnitCostOre ?? 0,
            unit: "ore",
          },
          {
            key: "averageCommissionOre",
            label: "Provision per pack",
            value: t.averageCommissionOre ?? 0,
            unit: "ore",
          },
          { key: "averageFeeOre", label: "Kortavgift per pack", value: fee, unit: "ore" },
          { key: "leftPerOrderOre", label: "Kvar per pack", value: left, unit: "ore" },
          { key: "orders", label: "Order", value: t.orders, unit: "count" },
        ],
      }),
      link: links.purchasePrices(t.titleId),
    },
  ];
}

/** Alla regler i den ordning de körs. */
export const INSIGHT_RULES = [
  lossTitleRule,
  staleMachineRule,
  titleChangeRule,
  concentrationRule,
  weekdayPatternRule,
  bestDayRule,
] as const;
