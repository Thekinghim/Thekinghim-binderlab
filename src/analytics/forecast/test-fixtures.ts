/**
 * Testdata för prognos, förlorad försäljning och inköp (används bara av testerna).
 */

import { addDays, type IsoDate, type OrderLine, type Settings } from "@/domain";
import type { StockEventRef } from "../lost-sales/stock";
import type { MachineRef } from "../todos/types";

export const NO_TAX: Settings = { vatRateBp: 0, cardFeeBp: 0 };

/** En order (ett pack). */
export function ord(
  id: string,
  titleId: string,
  machineId: string | null,
  businessDate: IsoDate,
  amountOre = 4_900,
): OrderLine {
  return { id, externalId: id, titleId, machineId, businessDate, amountOre };
}

/**
 * Order dag för dag från `start` i `days` dagar; `perDay(d, date)` ger antal pack dag d (0-baserat).
 * Id:n är `${prefix}-${d}-${n}`.
 */
export function dailyOrders(
  prefix: string,
  titleId: string,
  machineId: string | null,
  start: IsoDate,
  days: number,
  perDay: number | ((d: number, date: IsoDate) => number),
  amountOre = 4_900,
): OrderLine[] {
  const out: OrderLine[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const n = typeof perDay === "number" ? perDay : perDay(d, date);
    for (let k = 0; k < n; k++)
      out.push(ord(`${prefix}-${d}-${k}`, titleId, machineId, date, amountOre));
  }
  return out;
}

/** En automat. */
export function machine(
  id: string,
  activeFrom: IsoDate | null = null,
  activeTo: IsoDate | null = null,
): MachineRef {
  return { id, name: `Automat ${id.slice(2)}`, activeFrom, activeTo };
}

/** En lagerhändelse i en automat. */
export function ev(
  id: string,
  machineId: string | null,
  titleId: string,
  kind: StockEventRef["kind"],
  quantity: number,
  businessDate: IsoDate,
  extra: Partial<StockEventRef> = {},
): StockEventRef {
  return {
    id,
    locationId: machineId ?? "central",
    machineId,
    titleId,
    kind,
    quantity,
    businessDate,
    ...extra,
  };
}

/** Försäljningshändelser (`sale`, −1) för orderna, som databasens trigger skapar dem. */
export function saleEvents(orders: readonly OrderLine[]): StockEventRef[] {
  return orders
    .filter((o) => o.machineId !== null)
    .map((o) => ev(`s-${o.id}`, o.machineId, o.titleId, "sale", -1, o.businessDate));
}

/** Deterministisk pseudoslump (LCG) för brusiga serier. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}
