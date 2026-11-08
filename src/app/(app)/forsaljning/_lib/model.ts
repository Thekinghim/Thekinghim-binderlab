/**
 * Försäljning i den enkla vyn: sålt och tjänat i dag, den här veckan och den här månaden,
 * och per automat den här månaden. Ren och klientsäker (testas i model.test.ts).
 *
 * Vinsten är "vår vinst" FÖRE butikernas andel (samma regel som resten av appen: andelen
 * dras bara med knappen "Visa butikernas andel" eller en vald butik, och den enkla vyn har
 * ingetdera). Försäljningen är nettot utan moms, alla köp (även de utan inköpspris).
 */

import { addDays, monthOf, monthStart, weekStart, type IsoDate, type Period } from "@/domain";

/** Det som behövs ur en rad från profitability (belopp i öre). */
export interface SalesRow {
  readonly key: string;
  readonly orders: number;
  readonly revenueOre: number;
  readonly unpricedRevenueOre: number;
  readonly unpricedOrders: number;
  readonly profitBeforeShareOre: number;
}

export interface SalesFigures {
  readonly packs: number;
  /** Försäljning utan moms (alla köp). */
  readonly salesOre: number;
  /** Vår vinst före butikernas andel (köp med inköpspris). */
  readonly profitOre: number;
  /** Köp utan inköpspris (räknas inte i vinsten). */
  readonly unpriced: number;
}

export const NO_SALES: SalesFigures = { packs: 0, salesOre: 0, profitOre: 0, unpriced: 0 };

export function figuresOf(rows: readonly SalesRow[]): SalesFigures {
  return rows.reduce<SalesFigures>(
    (acc, r) => ({
      packs: acc.packs + r.orders,
      salesOre: acc.salesOre + r.revenueOre + r.unpricedRevenueOre,
      profitOre: acc.profitOre + r.profitBeforeShareOre,
      unpriced: acc.unpriced + r.unpricedOrders,
    }),
    NO_SALES,
  );
}

/** Perioderna räknat från dagens affärsdatum: i dag, veckan (från måndag) och månaden. */
export function salesPeriods(today: IsoDate): {
  today: Period;
  week: Period;
  month: Period;
  /** Allt som behöver läsas: från den tidigaste av veckans och månadens start. */
  all: Period;
} {
  const week = { start: weekStart(today), end: today };
  const month = { start: monthStart(monthOf(today)), end: today };
  const start = week.start < month.start ? week.start : month.start;
  return { today: { start: today, end: today }, week, month, all: { start, end: today } };
}

/** Raderna per dag (nyckel 'ÅÅÅÅ-MM-DD') inom perioden. */
export function daysIn<T extends { readonly key: string }>(rows: readonly T[], p: Period): T[] {
  return rows.filter((r) => r.key >= p.start && r.key <= p.end);
}

/** Dagen före (för tester och rubriker). */
export const yesterdayOf = (d: IsoDate): IsoDate => addDays(d, -1);

export interface MachineSales extends SalesFigures {
  readonly id: string;
  readonly name: string;
}

/** Per automat, mest sålda först (namn vid lika). Automater utan köp kommer sist. */
export function machineSales(
  rows: readonly SalesRow[],
  machines: readonly { readonly id: string; readonly name: string; readonly archived?: boolean }[],
): MachineSales[] {
  const byId = new Map(rows.map((r) => [r.key, r]));
  return machines
    .filter((m) => !m.archived || byId.has(m.id))
    .map((m) => ({ id: m.id, name: m.name, ...figuresOf(byId.has(m.id) ? [byId.get(m.id)!] : []) }))
    .sort((a, b) => b.salesOre - a.salesOre || a.name.localeCompare(b.name, "sv"));
}
