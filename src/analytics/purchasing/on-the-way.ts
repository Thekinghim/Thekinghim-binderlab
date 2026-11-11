/**
 * "På väg": det som är beställt och inte har kommit, per titel, ur inköpsplanens rader.
 * Ren och klientsäker. Visas på inköpslistan ("På väg: 36 st, väntas fredag") tills
 * leveransen kommit ("Kom fram").
 */

import { addDays, dayOfWeek, type IsoDate } from "@/domain";

import type { PurchasePlan } from "./types";

export interface OnTheWay {
  readonly titleId: string;
  /** Pack som är beställda och inte har kommit. */
  readonly quantity: number;
  /** Tidigaste väntade leverans. */
  readonly expectedOn: IsoDate;
  /** Den väntade dagen har passerat. */
  readonly late: boolean;
}

/** Det som är på väg per titel (beställt eller delvis mottaget, inte utkast). */
export function onTheWay(plan: Pick<PurchasePlan, "lines">): OnTheWay[] {
  const out: OnTheWay[] = [];
  for (const l of plan.lines) {
    const open = l.onOrder.filter(
      (o) => (o.status === "ordered" || o.status === "partially_received") && o.outstanding > 0,
    );
    if (open.length === 0) continue;
    const first = open.reduce((a, b) => (b.expectedOn < a.expectedOn ? b : a));
    out.push({
      titleId: l.titleId,
      quantity: open.reduce((sum, o) => sum + o.outstanding, 0),
      expectedOn: first.expectedOn,
      late: first.overdue,
    });
  }
  return out;
}

/**
 * När leveransen väntas, som nyckel för texten: inom en vecka veckodagen (1 = måndag …
 * 7 = söndag), "today", annars datumet.
 */
export type ExpectedWhen =
  | { readonly kind: "today" }
  | { readonly kind: "weekday"; readonly day: number }
  | { readonly kind: "date"; readonly date: IsoDate };

export function expectedWhen(expectedOn: IsoDate, today: IsoDate): ExpectedWhen {
  if (expectedOn === today) return { kind: "today" };
  for (let i = 1; i <= 7; i += 1) {
    if (addDays(today, i) === expectedOn) return { kind: "weekday", day: dayOfWeek(expectedOn) };
  }
  return { kind: "date", date: expectedOn };
}
