/**
 * Testdata för marknadsanalyserna (används bara av testerna).
 *
 * Inga avgifter. Fyra automater m-1 … m-4 i butikerna s-1 … s-4, provision 10 %, från 2026-01-01.
 */

import { addDays, type EconomicsSources, type IsoDate, type OrderLine } from "@/domain";
import type { MachineRef } from "../todos/types";

export const NO_TAX = { vatRateBp: 0, cardFeeBp: 0 } as const;

/** Placeringar och avtal för m-1 … m-4 (provision 10 %, ingen hyra). Inköpspris enligt `prices`. */
export function sources(prices: Record<string, number> = {}): EconomicsSources {
  const ids = [1, 2, 3, 4];
  return {
    settings: NO_TAX,
    prices: Object.entries(prices).map(([titleId, unitCostOre]) => ({
      titleId,
      unitCostOre,
      validFrom: "2025-01-01",
    })),
    placements: ids.map((i) => ({
      machineId: `m-${i}`,
      storeId: `s-${i}`,
      from: "2025-01-01",
      to: null,
    })),
    agreements: ids.map((i) => ({
      storeId: `s-${i}`,
      validFrom: "2025-01-01",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: null,
    })),
  };
}

/** En automat i drift från `activeFrom`. */
export function machine(
  id: string,
  activeFrom: IsoDate | null = null,
  activeTo: IsoDate | null = null,
): MachineRef {
  return { id, name: `Automat ${id.slice(2)}`, activeFrom, activeTo };
}

export const MACHINES: MachineRef[] = ["m-1", "m-2", "m-3", "m-4"].map((id) => machine(id));

/** En order. */
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
 * `perDay` order per dag i `days` dagar från `start`. Id: `<prefix>-<dag>-<n>`.
 * `perDay` kan vara en funktion av dagnumret (0, 1, …).
 */
export function daily(
  prefix: string,
  titleId: string,
  machineId: string | null,
  start: IsoDate,
  days: number,
  perDay: number | ((d: number) => number),
  amountOre: number | ((d: number) => number) = 4_900,
): OrderLine[] {
  const out: OrderLine[] = [];
  for (let d = 0; d < days; d++) {
    const n = typeof perDay === "number" ? perDay : perDay(d);
    const amount = typeof amountOre === "number" ? amountOre : amountOre(d);
    const date = addDays(start, d);
    for (let i = 0; i < n; i++)
      out.push(ord(`${prefix}-${date}-${i}`, titleId, machineId, date, amount));
  }
  return out;
}

/** Text med vanliga mellanslag i stället för hårda, för läsbara förväntningar i testerna. */
export function plain(text: string): string {
  return text.replace(/ /g, " ");
}
