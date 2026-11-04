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
import { day, kr, monthName, plural } from "./text";
import type { SettlementRef, TodoItem, TodoLevel } from "./types";

/** Dag i månaden efter avräkningsmånaden då butiken ska ha fått pengarna (samma som avtalet). */
export const SETTLEMENT_DUE_DAY = 15;

/** Dagar före sista dagen som punkten blir 'soon'. */
const SOON_DAYS = 3;

/** Sista dagen att betala ut avräkningen för månaden. */
export function settlementDue(month: IsoMonth): IsoDate {
  return `${addMonths(month, 1)}-${String(SETTLEMENT_DUE_DAY).padStart(2, "0")}`;
}

/** Sidan där avräkningarna betalas (Butiker → Butiksportal). */
export function settlementLink(month: IsoMonth): string {
  return `/butiker?vy=portal&manad=${month}`;
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
    const title = !first
      ? blocked.length === 1
        ? `Räkna klart avräkningen till ${blockedNames[0]}`
        : `Räkna klart ${plural(blocked.length, "avräkning", "avräkningar")}`
      : list.length === 1
        ? `Betala ${kr(first.amountOre)} till ${names[0]}`
        : `Betala ${kr(total)} till ${plural(list.length, "butik", "butiker")}`;
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
