/**
 * Påfyllning: titel × automat där lagret räcker kortare tid än gränsen (standard 2,5 dagar)
 * vid snittförsäljningen de senaste 14 hela dagarna (t.o.m. i går).
 *
 *   takt          = sålda pack i fönstret / dagar i fönstret (kortas vid automatens startdag)
 *   räcker        = i lager / takt (dagar)
 *   flaggas när     i lager × dagar × 100 < gräns (hundradels dagar) × sålda pack
 *   kronor i risk = intäkt per dag × (7 − räcker), dvs. intäkt som uteblir de närmaste 7 dagarna
 *   nivå          = 'now' om lagret räcker mindre än 1 dag, annars 'soon'
 *
 * Väntat slutdatum = i går + tak(räcker), domänens `stockoutDate` med asOf = i går.
 *
 * Titlar utan försäljning i fönstret flaggas inte (takten är 0). Dagens försäljning ingår
 * inte i takten (dagen är inte slut) men har redan dragits från lagret. En titel som har
 * gått ur sortimentet i automaten (`input.slotPeriods`, ./assortment.ts) fylls inte på och
 * flaggas inte, som på Lager och i besöksplanen.
 */

import {
  addDays,
  dailyUnits,
  daysOfStockLeft,
  floorDiv,
  revenue,
  roundHalfUp,
  salesVelocity,
  stockoutDate,
} from "@/domain";
import { assortmentKey, retiredPairs } from "./assortment";
import { evidence, isMachineActive, links } from "./common";
import { HORIZON_DAYS, urgencyOf, type TodoContext } from "./context";
import { day, kr, plural, ratioTenths, sentence, tenths } from "./text";
import type { AnalyticsOrder, StockLevelRef, TodoItem, TodoLevel } from "./types";

/**
 * Fingerprint för en påfyllningspunkt: nivån plus senaste påfyllning (`lastRestockedAt`).
 * En avbockning gäller då tills lagret räcker under 1 dag eller någon fyllt på.
 * Saknas `lastRestockedAt` används saldot i stället: då syns punkten igen efter nästa
 * försäljning eller påfyllning. Det är hellre en punkt för mycket än en påfyllning som döljs.
 */
export function refillFingerprint(
  level: TodoLevel,
  stock: Pick<StockLevelRef, "onHand" | "lastRestockedAt">,
): string {
  const restocked = stock.lastRestockedAt;
  return restocked !== undefined && restocked !== null && restocked !== ""
    ? `${level}|${restocked}`
    : `${level}|saldo:${stock.onHand}`;
}

/** Påfyllningspunkter. */
export function refillTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, options } = ctx;
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const asOf = addDays(today, -1);
  const windowStart = addDays(asOf, -(options.refillWindowDays - 1));

  const byPair = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    if (o.machineId === null) continue;
    if (o.businessDate < windowStart || o.businessDate > asOf) continue;
    const k = `${o.machineId}\u0000${o.titleId}`;
    const list = byPair.get(k);
    if (list) list.push(o);
    else byPair.set(k, [o]);
  }

  const retired = retiredPairs(input.slotPeriods ?? [], today);
  const out: TodoItem[] = [];
  for (const s of input.stock) {
    const machine = machines.get(s.machineId);
    if (!machine || !isMachineActive(machine, today)) continue;
    if (retired.has(assortmentKey(s.machineId, s.titleId))) continue;
    const orders = byPair.get(`${s.machineId}\u0000${s.titleId}`) ?? [];
    const v = salesVelocity(dailyUnits(orders), {
      asOf,
      days: options.refillWindowDays,
      ...(machine.activeFrom !== null ? { activeFrom: machine.activeFrom } : {}),
    });
    if (v.units === 0 || v.days === 0) continue;
    const onHand = Math.max(0, s.onHand);
    if (onHand * v.days * 100 >= options.refillThresholdCentidays * v.units) continue;

    const windowOrders = orders.filter((o) => o.businessDate >= v.start && o.businessDate <= v.end);
    const revenueOre = revenue(windowOrders, input.settings);
    const daysLeft = daysOfStockLeft(onHand, v) ?? 0;
    const daysLeftTenths = floorDiv(onHand * v.days * 10, v.units);
    const lostDaysNumerator = HORIZON_DAYS * v.units - onHand * v.days; // (7 − räcker) × units
    const atStakeOre = Math.max(0, roundHalfUp(revenueOre * lostDaysNumerator, v.days * v.units));
    const level: TodoLevel = daysLeftTenths < 10 ? "now" : "soon";
    const empty = onHand === 0;
    const titleName = ctx.titleName(s.titleId);
    const machineName = ctx.machineName(s.machineId);
    const perDay = ratioTenths(v.units, v.days);
    const revenuePerDay = kr(roundHalfUp(revenueOre, v.days));
    // Domänens konvention: saldot räknas som saldot efter asOf (i går), så sista packet
    // säljs dag asOf + tak(räcker). 2,3 dagar räknat från i går kväll → slut 4 nov. om i dag är 2 nov.
    const outDate = stockoutDate(asOf, onHand, v);

    const detail = empty
      ? `Slut i lager. Säljer i snitt ${perDay} pack och ${revenuePerDay} per dag (${v.days} dagar t.o.m. ${day(asOf)}).`
      : `${plural(onHand, "pack", "pack")} kvar räcker ca ${tenths(daysLeftTenths)} dagar vid ${perDay} pack per dag ` +
        `(${v.days} dagar t.o.m. ${day(asOf)}). ${sentence(`Väntas ta slut ${day(outDate ?? today)}`)}`;

    out.push({
      key: `refill:${s.machineId}:${s.titleId}`,
      fingerprint: refillFingerprint(level, s),
      kind: "refill",
      level,
      urgency: urgencyOf(level, atStakeOre),
      atStakeOre,
      daysLeft,
      title: empty
        ? `${titleName} är slut i ${machineName}`
        : `Fyll på ${titleName} i ${machineName}`,
      detail,
      evidence: evidence({
        rule: `Lagret räcker under ${tenths(roundHalfUp(options.refillThresholdCentidays, 10))} dagar vid snittförsäljningen de senaste ${options.refillWindowDays} dagarna.`,
        period: { start: v.start, end: v.end },
        orderIds: windowOrders.map((o) => o.id),
        dates: windowOrders.map((o) => o.businessDate),
        titleIds: [s.titleId],
        machineIds: [s.machineId],
        figures: [
          { key: "onHand", label: "I lager", value: onHand, unit: "packs" },
          { key: "unitsInWindow", label: "Sålda pack i fönstret", value: v.units, unit: "packs" },
          { key: "windowDays", label: "Dagar i fönstret", value: v.days, unit: "days" },
          { key: "revenueInWindowOre", label: "Intäkt i fönstret", value: revenueOre, unit: "ore" },
          { key: "daysLeftTenths", label: "Räcker (dagar)", value: daysLeftTenths, unit: "tenths" },
          { key: "atStakeOre", label: "Intäkt i risk 7 dagar", value: atStakeOre, unit: "ore" },
        ],
      }),
      link: links.stock(s.machineId, s.titleId),
      action: {
        kind: "register-refill",
        label: "Registrera påfyllning",
        params: { machineId: s.machineId, titleId: s.titleId },
      },
    });
  }
  return out;
}
