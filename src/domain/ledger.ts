/**
 * Orderliggaren: ekonomin för varje order i perioden, med hyran fördelad.
 *
 * Alla vyer (per titel, automat, butik, dag, vecka, månad) summerar samma liggare.
 * Därför är totalerna identiska mellan vyerna, och raderna i varje vy summerar
 * exakt till totalen.
 *
 * Fördelning av hyra: för varje butik och kalendermånad fördelas månadens hyra
 * (rent.ts) på butikens order i den månaden inom perioden, i proportion till
 * nettointäkt × den månadshyra som gällde orderns dag, med största-restmetoden så att
 * summan stämmer på öret. En order på en dag utan hyresavtal bär alltså ingen hyra.
 * Orderna sorteras först på datum och id, så att resultatet inte beror på i vilken
 * ordning orderna kom in. Har butiken hyra men inga order på dagar med hyra den
 * månaden blir hyran "ej fördelad".
 *
 * Varje order får sin andel oavsett om den har inköpspris. Andelen på en order utan
 * pris dras ändå från vinsten, som ej fördelad hyra (se profitability.ts).
 */

import { assertPeriod } from "./dates";
import { DomainError } from "./errors";
import {
  assertOrder,
  computeOrderEconomics,
  createEconomicsContext,
  type EconomicsContext,
} from "./economics";
import { allocateLargestRemainderBig } from "./money";
import { rentByStoreMonth, type StoreMonthRent } from "./rent";
import type { IsoDate, IsoMonth, OrderLine, Period, ProfitabilityInput, Settings } from "./types";

/** En order i liggaren. Alla belopp i öre. */
export interface LedgerEntry {
  readonly order: OrderLine;
  readonly storeId: string | null;
  readonly month: IsoMonth;
  /** Sant om ordern har ett inköpspris och därmed räknas in i vinsten. */
  readonly priced: boolean;
  readonly grossOre: number;
  readonly vatOre: number;
  readonly netRevenueOre: number;
  /** Inköp (0 om pris saknas – se `priced`). */
  readonly costOre: number;
  readonly cardFeeOre: number;
  readonly commissionOre: number;
  /** Orderns andel av butikens månadshyra (även för order utan pris). */
  readonly rentOre: number;
}

/** Hyra för en butik-månad som saknade order (på dagar med hyra) att fördelas på. */
export interface UnallocatedRent {
  readonly storeId: string;
  readonly month: IsoMonth;
  readonly rentOre: number;
}

/** Saker som bör åtgärdas för att siffrorna ska bli kompletta (används t.ex. i Att göra). */
export interface LedgerDiagnostics {
  /** Order utanför perioden som filtrerades bort. */
  readonly ordersOutsidePeriod: number;
  /** Order utan kopplad automat (källans automat inte kopplad). */
  readonly ordersWithoutMachine: number;
  /** Order från en automat som inte var placerad i någon butik den dagen. */
  readonly ordersWithoutStore: number;
  /** Order i en butik som saknade avtal den dagen (ingen provision). */
  readonly ordersWithoutAgreement: number;
  readonly machinesWithoutPlacement: string[];
  readonly storesWithoutAgreement: string[];
}

/** Liggaren för en period. */
export interface Ledger {
  readonly period: Period;
  readonly settings: Settings;
  readonly entries: readonly LedgerEntry[];
  /** Hyra per butik och månad (inom perioden), fördelad eller inte. */
  readonly storeMonthRent: readonly StoreMonthRent[];
  readonly unallocatedRent: readonly UnallocatedRent[];
  readonly diagnostics: LedgerDiagnostics;
  /** Uppslagen som användes (priser, placeringar, avtal). */
  readonly context: EconomicsContext;
}

/** Månadshyran som gällde en dag i butik-månaden (0 om inget hyresavtal gällde). */
function rentRateOn(sm: StoreMonthRent, date: IsoDate): number {
  for (const seg of sm.segments)
    if (seg.start <= date && date <= seg.end) return seg.monthlyRentOre;
  return 0;
}

type MutableEntry = { -readonly [K in keyof LedgerEntry]: LedgerEntry[K] };

function compareEntries(a: MutableEntry, b: MutableEntry): number {
  const da = a.order.businessDate;
  const db = b.order.businessDate;
  if (da !== db) return da < db ? -1 : 1;
  const ia = a.order.id;
  const ib = b.order.id;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Bygger liggaren för perioden. Kastar `DomainError` vid ogiltig indata. */
export function buildLedger(input: ProfitabilityInput): Ledger {
  assertPeriod(input.period);
  const { period } = input;
  const context = createEconomicsContext(input);

  const seen = new Set<string>();
  const entries: MutableEntry[] = [];
  let outside = 0;
  let withoutMachine = 0;
  let withoutStore = 0;
  let withoutAgreement = 0;
  const unplacedMachines = new Set<string>();
  const storesWithoutAgreement = new Set<string>();

  for (const order of input.orders) {
    assertOrder(order);
    if (seen.has(order.id)) {
      throw new DomainError(
        "duplicate_order",
        `Order ${order.externalId} (${order.id}) finns två gånger.`,
      );
    }
    seen.add(order.id);
    const date = order.businessDate;
    if (date < period.start || date > period.end) {
      outside++;
      continue;
    }
    const econ = computeOrderEconomics(order, context);
    if (order.machineId === null) withoutMachine++;
    else if (econ.storeId === null) {
      withoutStore++;
      unplacedMachines.add(order.machineId);
    } else if (econ.agreement === null) {
      withoutAgreement++;
      storesWithoutAgreement.add(econ.storeId);
    }
    entries.push({
      order,
      storeId: econ.storeId,
      month: date.slice(0, 7),
      priced: econ.costOre !== null,
      grossOre: econ.grossOre,
      vatOre: econ.vatOre,
      netRevenueOre: econ.netRevenueOre,
      costOre: econ.costOre ?? 0,
      cardFeeOre: econ.cardFeeOre,
      commissionOre: econ.commissionOre,
      rentOre: 0,
    });
  }

  // Hyra per butik-månad och fördelning på orderna.
  const storeMonthRent = rentByStoreMonth(context.agreements, period);
  const byStoreMonth = new Map<string, MutableEntry[]>();
  for (const e of entries) {
    if (e.storeId === null) continue;
    const key = `${e.storeId}\u0000${e.month}`;
    const list = byStoreMonth.get(key);
    if (list) list.push(e);
    else byStoreMonth.set(key, [e]);
  }
  const unallocatedRent: UnallocatedRent[] = [];
  for (const sm of storeMonthRent) {
    if (sm.rentOre === 0) continue;
    const list = byStoreMonth.get(`${sm.storeId}\u0000${sm.month}`);
    if (!list || list.length === 0) {
      unallocatedRent.push({ storeId: sm.storeId, month: sm.month, rentOre: sm.rentOre });
      continue;
    }
    list.sort(compareEntries);
    // Vikt = nettointäkt × den månadshyra som gällde orderns dag. Order på dagar utan
    // hyresavtal (t.ex. före ett avtalsbyte från bara provision till hyra) bär ingen hyra.
    const rates = list.map((e) => BigInt(rentRateOn(sm, e.order.businessDate)));
    let weights = list.map((e, i) => BigInt(e.netRevenueOre) * rates[i]!);
    if (weights.every((w) => w === 0n)) weights = rates; // alla netto 0 → lika per order och hyresdag
    if (weights.every((w) => w === 0n)) {
      // Inga order på dagar med hyra: hyran kan inte bäras av någon order.
      unallocatedRent.push({ storeId: sm.storeId, month: sm.month, rentOre: sm.rentOre });
      continue;
    }
    const shares = allocateLargestRemainderBig(sm.rentOre, weights);
    for (let i = 0; i < list.length; i++) list[i]!.rentOre = shares[i]!;
  }

  return {
    period,
    settings: input.settings,
    entries,
    storeMonthRent,
    unallocatedRent,
    diagnostics: {
      ordersOutsidePeriod: outside,
      ordersWithoutMachine: withoutMachine,
      ordersWithoutStore: withoutStore,
      ordersWithoutAgreement: withoutAgreement,
      machinesWithoutPlacement: [...unplacedMachines].sort(),
      storesWithoutAgreement: [...storesWithoutAgreement].sort(),
    },
    context,
  };
}
