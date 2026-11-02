/**
 * Testdata för expansion och scenarier (används bara av testerna).
 *
 * Oktober 2026 (31 dagar), inga avgifter, inköp 20,00 kr per pack:
 * - s-1 Ica Nära Söder (livs, Malmö, 98 h, 400 m²): m-1 hela månaden, 2 pack à 49 kr per dag,
 *   provision 10 % → vinst 48,20 kr per dag.
 * - s-3 Coop Väster (livs, Malmö, 84 h, 350 m²): m-3 hela månaden, 1 pack per dag, provision 10 %
 *   → vinst 24,10 kr per dag.
 * - s-4 Ica Lund (livs, Lund, 98 h, 400 m²): m-4 från 20 okt. (12 dagar), 1 pack per dag.
 * - s-2 Pressbyrån C (kiosk, Malmö, 112 h, 60 m²): m-2 hela månaden, 1 pack per dag.
 * - s-5 OKQ8 (bensinstation, Lund, okänt): ingen automat.
 */

import { addDays, type OrderLine, type ProfitabilityInput } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import type { StoreProfile } from "./types";

export const OCTOBER = { start: "2026-10-01", end: "2026-10-31" } as const;

export const STORES: StoreProfile[] = [
  {
    id: "s-1",
    name: "Ica Nära Söder",
    storeType: "livs",
    city: "Malmö",
    openHoursPerWeek: 98,
    areaSqm: 400,
  },
  {
    id: "s-2",
    name: "Pressbyrån C",
    storeType: "kiosk",
    city: "Malmö",
    openHoursPerWeek: 112,
    areaSqm: 60,
  },
  {
    id: "s-3",
    name: "Coop Väster",
    storeType: "Livs ",
    city: "malmö",
    openHoursPerWeek: 84,
    areaSqm: 350,
  },
  {
    id: "s-4",
    name: "Ica Lund",
    storeType: "livs",
    city: "Lund",
    openHoursPerWeek: 98,
    areaSqm: 400,
  },
  {
    id: "s-5",
    name: "OKQ8",
    storeType: "bensinstation",
    city: "Lund",
    openHoursPerWeek: null,
    areaSqm: null,
  },
];

/**
 * `perDay` order per dag från `from` i `days` dagar. Id:n bygger på automat, titel, dag och
 * löpnummer, så att samma anrop alltid ger samma order.
 */
export function dailyOrders(
  machineId: string,
  from: string,
  days: number,
  perDay = 1,
  amountOre = 4900,
  titleId = "t-a",
): OrderLine[] {
  const out: OrderLine[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    for (let k = 0; k < perDay; k++) {
      const id = `${machineId}:${titleId}:${date}:${k}`;
      out.push({ id, externalId: id, titleId, machineId, businessDate: date, amountOre });
    }
  }
  return out;
}

/** Källorna för oktober enligt beskrivningen ovan. */
export function octoberSources(): ProfitabilityInput {
  return {
    orders: [
      ...dailyOrders("m-1", "2026-10-01", 31, 2),
      ...dailyOrders("m-3", "2026-10-01", 31),
      ...dailyOrders("m-4", "2026-10-20", 12),
      ...dailyOrders("m-2", "2026-10-01", 31),
    ],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000 }),
      agreement("s-2", "2026-01-01", null, { commissionBp: 1000 }),
      agreement("s-3", "2026-01-01", null, { commissionBp: 1000 }),
      agreement("s-4", "2026-01-01", null, { commissionBp: 1000 }),
    ],
    placements: [
      placement("m-1", "s-1", "2026-09-01", null),
      placement("m-2", "s-2", "2026-09-01", null),
      placement("m-3", "s-3", "2026-09-01", null),
      placement("m-4", "s-4", "2026-10-20", null),
    ],
    settings: NO_TAX,
    period: OCTOBER,
  };
}

/** Automat 20 000 kr + installation 1 000 kr. */
export const INVESTMENT = { purchaseOre: 2_000_000, installationOre: 100_000 } as const;
