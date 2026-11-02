/**
 * Testhjälp för rapporterna: små byggare och ett gemensamt scenario. Används bara av testerna.
 */

import type { OrderLine, Placement, PurchasePrice, Settings, StoreAgreement } from "@/domain";
import type { ReportSources } from "../types";

export const NO_TAX: Settings = { vatRateBp: 0, cardFeeBp: 0 };
export const VAT_25: Settings = { vatRateBp: 2500, cardFeeBp: 0 };

let seq = 1000;

/** Nollställer ordernumreringen (anropas i beforeEach när numren spelar roll). */
export function resetOrderNumbers(start = 1000): void {
  seq = start;
}

/** En order. Ordernumret räknas upp om det inte anges. */
export function ord(
  businessDate: string,
  p: {
    amountOre?: number;
    titleId?: string;
    machineId?: string | null;
    externalId?: string;
    id?: string;
  } = {},
): OrderLine {
  seq++;
  const externalId = p.externalId ?? String(seq);
  return {
    id: p.id ?? `o-${externalId}-${businessDate}`,
    externalId,
    titleId: p.titleId ?? "t-a",
    machineId: p.machineId === undefined ? "m-1" : p.machineId,
    businessDate,
    amountOre: p.amountOre ?? 4900,
  };
}

export function price(titleId: string, unitCostOre: number, validFrom: string): PurchasePrice {
  return { titleId, unitCostOre, validFrom };
}

export function agreement(
  storeId: string,
  validFrom: string,
  validTo: string | null,
  terms: { commissionBp?: number | null; monthlyRentOre?: number | null },
): StoreAgreement {
  return {
    storeId,
    validFrom,
    validTo,
    commissionBp: terms.commissionBp ?? null,
    monthlyRentOre: terms.monthlyRentOre ?? null,
  };
}

export function placement(
  machineId: string,
  storeId: string,
  from: string,
  to: string | null,
): Placement {
  return { machineId, storeId, from, to };
}

/** Källor med namn för tre butiker, tre automater och tre titlar. */
export function sources(p: Partial<ReportSources> = {}): ReportSources {
  return {
    orders: [],
    prices: [],
    agreements: [],
    placements: [placement("m-1", "s-1", "2025-01-01", null)],
    settings: NO_TAX,
    stores: [
      { id: "s-1", name: "Nordstan" },
      { id: "s-2", name: "Mobilia" },
      { id: "s-3", name: "Väla" },
    ],
    machines: [
      { id: "m-1", name: "Nordstan entré", code: "BL-001" },
      { id: "m-2", name: "Mobilia plan 2", code: "BL-002" },
      { id: "m-3", name: "Reserv", code: "BL-003" },
    ],
    titles: [
      { id: "t-a", name: "30th Celebration" },
      { id: "t-b", name: "Prismatic Evolutions" },
      { id: "t-c", name: "Surging Sparks" },
    ],
    ...p,
  };
}

/** Fem order à 49 kr och en à 59 kr i oktober 2026 (exemplet i docs/berakningar.md avsnitt 3). */
export function octoberExample(): ReportSources {
  return sources({
    orders: [
      ord("2026-10-05", { id: "o1" }),
      ord("2026-10-10", { id: "o2" }),
      ord("2026-10-15", { id: "o3" }),
      ord("2026-10-16", { id: "o4" }),
      ord("2026-10-20", { id: "o5" }),
      ord("2026-10-31", { id: "o6", amountOre: 5900 }),
    ],
    prices: [price("t-a", 2000, "2026-09-01"), price("t-a", 2500, "2026-10-16")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
    ],
  });
}
