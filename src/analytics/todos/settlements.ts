/**
 * Obetalda månadsavräkningar till butikerna (tabellen store_settlements): en punkt per
 * månad med avräkningar som har ett belopp att betala ut och inte är markerade som betalda.
 *
 *   sista dag   = den 15:e månaden efter avräkningsmånaden (avtalets utbetalningsdag,
 *                 CONTRACT_PAYOUT_DAY i src/reports/contract-pdf.ts)
 *   nivå        = 'now' efter sista dagen, 'soon' 0–3 dagar kvar, annars 'later'
 *   fingerprint = antal obetalda och summan: en ny eller omräknad avräkning tar upp en
 *                 avbockad punkt igen
 *
 * Beloppen är räknade NU (src/server/settlements/live.ts). En avräkning som inte går att
 * räkna (blocked, t.ex. saknat inköpspris) har inget belopp att betala: punkten säger att
 * den ska räknas klart i stället för ett gammalt belopp.
 */

import {
  addMonths,
  daysBetween,
  monthOf,
  monthPeriod,
  type IsoDate,
  type IsoMonth,
} from "@/domain";

import { evidence, nameLookup } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { day, kr, krAuto, monthName, plural } from "./text";
import type { PaidDriftRef, SettlementRef, TodoItem, TodoLevel } from "./types";

/** Dag i månaden efter avräkningsmånaden då butiken ska ha fått pengarna (samma som avtalet). */
export const SETTLEMENT_DUE_DAY = 15;

/** Dagar före sista dagen som punkten blir 'soon'. */
const SOON_DAYS = 3;

/** Sista dagen att betala ut avräkningen för månaden. */
export function settlementDue(month: IsoMonth): IsoDate {
  return `${addMonths(month, 1)}-${String(SETTLEMENT_DUE_DAY).padStart(2, "0")}`;
}

/** Sidan där avräkningarna betalas och skapas (Butiker → Utbetalning). */
export function settlementLink(month: IsoMonth): string {
  return `/butiker?vy=utbetalning&manad=${month}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}

/** En punkt per månad med obetalda avräkningar (belopp > 0). */
export function settlementTodos(ctx: TodoContext): TodoItem[] {
  const unpaid = (ctx.input.unpaidSettlements ?? []).filter((s) => s.blocked || s.amountOre > 0);
  if (unpaid.length === 0) return [];
  const storeName = nameLookup(ctx.input.stores ?? []);
  const byMonth = new Map<IsoMonth, SettlementRef[]>();
  for (const s of unpaid) {
    const month = monthOf(s.month);
    const list = byMonth.get(month);
    if (list) list.push(s);
    else byMonth.set(month, [s]);
  }

  const out: TodoItem[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const all = byMonth.get(month)!;
    const blocked = all.filter((s) => s.blocked);
    const list = all
      .filter((s) => !s.blocked)
      .sort((a, b) => b.amountOre - a.amountOre || (a.id < b.id ? -1 : 1));
    const total = list.reduce((n, s) => n + s.amountOre, 0);
    const due = settlementDue(month);
    const daysLeft = daysBetween(ctx.today, due);
    const level: TodoLevel = daysLeft < 0 ? "now" : daysLeft <= SOON_DAYS ? "soon" : "later";
    const names = list.map((s) => storeName(s.storeId));
    const blockedNames = blocked.map((s) => storeName(s.storeId));
    const first = list[0];
    // "Betala butikerna: 12 172 kr senast 15 nov." (försenad: "… försenad sedan 15 nov.").
    const deadline =
      daysLeft < 0 ? `försenad sedan ${day(due)}` : daysLeft === 0 ? "i dag" : `senast ${day(due)}`;
    const title = !first
      ? blocked.length === 1
        ? `Räkna klart avräkningen till ${blockedNames[0]}`
        : `Räkna klart ${plural(blocked.length, "avräkning", "avräkningar")}`
      : list.length === 1
        ? `Betala ${names[0]}: ${kr(first.amountOre)} ${deadline}`
        : `Betala butikerna: ${kr(total)} ${deadline}`;
    const blockedText =
      blocked.length === 0
        ? ""
        : first
          ? ` ${blockedNames.join(", ")} kan inte räknas än (inköpspris saknas).`
          : " Inköpspris saknas, så beloppet är inte klart.";
    const when =
      daysLeft < 0
        ? `Skulle ha betalats ${day(due)}.`
        : daysLeft === 0
          ? "Betala i dag."
          : `Senast ${day(due)}.`;
    out.push({
      key: `settlement:${month}`,
      fingerprint: `${list.length}|${total}${blocked.length ? `|${blocked.length}` : ""}`,
      kind: "settlement",
      level,
      urgency: urgencyOf(level, null),
      atStakeOre: null,
      daysLeft,
      title,
      detail:
        (list.length <= 1
          ? `Avräkning ${monthName(month)}. ${when}`
          : `Avräkning ${monthName(month)}: ${names.join(", ")}. ${when}`) + blockedText,
      evidence: evidence({
        rule: "Butikens andel enligt avtalet betalas ut senast den 15:e månaden efter.",
        period: monthPeriod(month),
        dates: [due],
        storeIds: all.map((s) => s.storeId),
        figures: [
          { key: "settlements", label: "Avräkningar", value: list.length, unit: "count" },
          { key: "totalOre", label: "Att betala", value: total, unit: "ore" },
          { key: "daysLeft", label: "Dagar kvar", value: daysLeft, unit: "days" },
        ],
      }),
      link: settlementLink(month),
    });
  }
  return out;
}

/**
 * Månaden är slut men avräkningarna saknas (butiker som hade en automat då): en punkt
 * "Skapa oktober-avräkningarna" som går till Utbetalning, där knappen skapar dem. Bara när
 * det inte redan finns en punkt om att betala samma månad (den säger då redan vart man går).
 *
 *   nivå        = 'now' (utbetalningen ska vara klar senast den 15:e)
 *   nyckel      = 'settlement-create:<månad>', fingerprint = antal butiker
 */
export function missingSettlementTodos(ctx: TodoContext): TodoItem[] {
  const missing = ctx.input.missingSettlements;
  if (!missing || missing.storeIds.length === 0) return [];
  const storeName = nameLookup(ctx.input.stores ?? []);
  const { month } = missing;
  const due = settlementDue(month);
  const daysLeft = daysBetween(ctx.today, due);
  const names = [...missing.storeIds].map(storeName).sort((a, b) => a.localeCompare(b, "sv"));
  const n = names.length;
  return [
    {
      key: `settlement-create:${month}`,
      fingerprint: String(n),
      kind: "settlement-create",
      level: "now",
      urgency: urgencyOf("now", null),
      atStakeOre: null,
      daysLeft,
      title: `Skapa ${monthName(month)}-avräkning${n === 1 ? "en" : "arna"}`,
      detail: `${capitalize(monthName(month))} är slut. ${names.join(", ")} saknar avräkning. Betala senast ${day(due)}.`,
      evidence: evidence({
        rule: "Varje butik som hade en automat under månaden får en avräkning när månaden är slut.",
        period: monthPeriod(month),
        dates: [due],
        storeIds: missing.storeIds,
        figures: [{ key: "stores", label: "Butiker utan avräkning", value: n, unit: "count" }],
      }),
      link: settlementLink(month),
    },
  ];
}

/**
 * En betald avräkning skiljer sig från dagens uträkning (ett inköpspris rättades efter
 * betalningen, en order kom in sent, eller ägaren betalade rapportens belopp). En punkt per
 * avräkning; den försvinner när skillnaden lagts på nästa avräkning (Utbetalning).
 *
 *   nivå        = 'now' när butiken ska ha mer, annars 'soon'
 *   nyckel      = 'settlement-drift:<avräkning>', fingerprint = skillnaden
 */
export function paidDriftTodos(ctx: TodoContext): TodoItem[] {
  const drift = (ctx.input.paidDrift ?? []).filter((d) => d.differenceOre !== 0);
  if (drift.length === 0) return [];
  const storeName = nameLookup(ctx.input.stores ?? []);
  return [...drift]
    .sort((a, b) => Math.abs(b.differenceOre) - Math.abs(a.differenceOre) || (a.id < b.id ? -1 : 1))
    .map((d: PaidDriftRef): TodoItem => {
      const month = monthOf(d.month);
      const level: TodoLevel = d.differenceOre > 0 ? "now" : "soon";
      const diff =
        d.differenceOre > 0
          ? `Butiken ska ha ${krAuto(d.differenceOre)} till.`
          : `Butiken har fått ${krAuto(-d.differenceOre)} för mycket.`;
      return {
        key: `settlement-drift:${d.id}`,
        fingerprint: String(d.differenceOre),
        kind: "settlement-drift",
        level,
        urgency: urgencyOf(level, null),
        atStakeOre: null,
        daysLeft: null,
        title: "Betald avräkning skiljer sig från dagens uträkning",
        detail: `${storeName(d.storeId)}, ${monthName(month)}: betalt ${krAuto(d.paidOre)}, dagens uträkning ${krAuto(d.liveOre)}. ${diff} Lägg skillnaden på nästa avräkning.`,
        evidence: evidence({
          rule: "Det som betalades för en månad ska vara månadens belopp med dagens underlag. En skillnad rättas som en egen rad på nästa avräkning.",
          period: monthPeriod(month),
          dates: [],
          storeIds: [d.storeId],
          figures: [
            { key: "paidOre", label: "Betalt", value: d.paidOre, unit: "ore" },
            { key: "liveOre", label: "Dagens uträkning", value: d.liveOre, unit: "ore" },
            { key: "differenceOre", label: "Skillnad", value: d.differenceOre, unit: "ore" },
          ],
        }),
        link: settlementLink(month),
      };
    });
}

/**
 * Äldre avslutade månader där en butik sålde men aldrig fick någon avräkning (den gick
 * inte att räkna i tid, eller automaten kopplades i efterhand). En punkt per månad, som
 * "Skapa oktober-avräkningarna": knappen på Utbetalning skapar dem.
 */
export function olderMissingSettlementTodos(ctx: TodoContext): TodoItem[] {
  const storeName = nameLookup(ctx.input.stores ?? []);
  const out: TodoItem[] = [];
  for (const missing of ctx.input.olderMissingSettlements ?? []) {
    if (missing.storeIds.length === 0) continue;
    const { month } = missing;
    const due = settlementDue(month);
    const names = [...missing.storeIds].map(storeName).sort((a, b) => a.localeCompare(b, "sv"));
    const n = names.length;
    out.push({
      key: `settlement-create:${month}`,
      fingerprint: String(n),
      kind: "settlement-create",
      level: "now",
      urgency: urgencyOf("now", null),
      atStakeOre: null,
      daysLeft: daysBetween(ctx.today, due),
      title: `Skapa ${monthName(month)}-avräkning${n === 1 ? "en" : "arna"}`,
      detail: `${names.join(", ")} sålde i ${monthName(month)} men har ingen avräkning. Skulle ha betalats ${day(due)}.`,
      evidence: evidence({
        rule: "Varje butik som sålde under en månad får en avräkning, också när månaden inte kunde räknas i tid.",
        period: monthPeriod(month),
        dates: [due],
        storeIds: missing.storeIds,
        figures: [{ key: "stores", label: "Butiker utan avräkning", value: n, unit: "count" }],
      }),
      link: settlementLink(month),
    });
  }
  return out;
}
