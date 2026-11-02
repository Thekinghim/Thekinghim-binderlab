/**
 * Byggare för testerna i src/analytics. Används bara av testerna.
 */

import { addDays, type IsoDate, type Placement, type StoreAgreement } from "@/domain";
import type { AnalyticsOrder, MachineRef, TitleRef, TodoInput } from "./types";

let seq = 0;

/** En order. Id genereras om det saknas; standardbelopp 49,00 kr. */
export function order(
  p: Partial<AnalyticsOrder> & { titleId: string; businessDate: IsoDate },
): AnalyticsOrder {
  seq++;
  const id = p.id ?? `o${String(seq).padStart(6, "0")}`;
  return {
    id,
    externalId: p.externalId ?? id,
    titleId: p.titleId,
    machineId: p.machineId === undefined ? "m1" : p.machineId,
    businessDate: p.businessDate,
    amountOre: p.amountOre ?? 4_900,
    ...(p.orderedAt !== undefined ? { orderedAt: p.orderedAt } : {}),
  };
}

/** `perDay` order per dag i `days` dagar från `start`. */
export function daily(
  titleId: string,
  machineId: string | null,
  start: IsoDate,
  days: number,
  perDay: number,
  amountOre = 4_900,
): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      out.push(order({ titleId, machineId, businessDate: addDays(start, d), amountOre }));
    }
  }
  return out;
}

/** `n` order samma dag. */
export function many(
  n: number,
  p: Partial<AnalyticsOrder> & { titleId: string; businessDate: IsoDate },
): AnalyticsOrder[] {
  return Array.from({ length: n }, () => order(p));
}

export function machine(id: string, name: string, p: Partial<MachineRef> = {}): MachineRef {
  return { id, name, activeFrom: null, activeTo: null, ...p };
}

export function title(id: string, name: string, p: Partial<TitleRef> = {}): TitleRef {
  return { id, name, ...p };
}

export const PLACEMENT: Placement = {
  machineId: "m1",
  storeId: "s1",
  from: "2026-01-01",
  to: null,
};
export const AGREEMENT: StoreAgreement = {
  storeId: "s1",
  validFrom: "2026-01-01",
  validTo: null,
  commissionBp: 1_000,
  monthlyRentOre: null,
};

/** Tom indata med en automat (m1, "Automat 1") i butik s1. */
export function input(p: Partial<TodoInput> = {}): TodoInput {
  return {
    orders: [],
    titles: [],
    machines: [machine("m1", "Automat 1")],
    stock: [],
    stores: [{ id: "s1", name: "ICA Nära" }],
    reportRecipients: [],
    reportDeliveries: [],
    prices: [],
    agreements: [AGREEMENT],
    placements: [PLACEMENT],
    settings: { vatRateBp: 0, cardFeeBp: 0 },
    ...p,
  };
}

/** Tidpunkten som används som "nu" i testerna: 2 nov. 2026 11:00 svensk tid. */
export const NOW = "2026-11-02T10:00:00Z";
export const TODAY = "2026-11-02";
