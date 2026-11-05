/**
 * Marginal och utveckling: försäljning och "kvar efter inköp" per månad, per automat och
 * per butik, med förändringen mot månaden före. Ren funktion; all ekonomi kommer från
 * lönsamhetsberäkningen (@/domain profitabilityViews), samma regler som Lönsamhet och
 * Inköpspriser.
 *
 * - Försäljning = nettointäkt exkl. moms för order med inköpspris (som Lönsamhet).
 * - Kvar efter inköp = försäljning − inköp − kortavgifter − VMB-moms: hela beloppet, före
 *   butikens andel (som "Kvar per order" på Inköpspriser).
 * - Per butik visas också butikens andel (provision + hyra) och vår del = kvar − andelen.
 *   Butikens andel visas bara per butik, aldrig i totalen.
 * - Order utan inköpspris ingår inte (deras intäkt redovisas separat).
 * - Förändring = changeBp(nu, före) i bp; `null` när förra värdet är 0.
 */

import {
  addDays,
  changeBp,
  daysBetween,
  monthEnd,
  monthStart,
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  profitability,
  profitabilityViews,
  type IsoDate,
  type IsoMonth,
  type ProfitabilityInput,
  type ProfitabilityRow,
  ratioBp,
} from "@/domain";

export interface MarginMonth {
  readonly month: IsoMonth;
  /** Månaden är inte slut (räknad till och med `asOf`). */
  readonly partial: boolean;
  readonly orders: number;
  readonly revenueOre: number;
  readonly keptOre: number;
  readonly unpricedRevenueOre: number;
}

export interface MarginLine {
  /** Automatens eller butikens id, eller NO_MACHINE_KEY/NO_STORE_KEY. */
  readonly key: string;
  readonly orders: number;
  readonly revenueOre: number;
  readonly keptOre: number;
  /** Kvar efter inköp månaden före, eller `null` utan försäljning då. */
  readonly previousKeptOre: number | null;
  readonly changeBp: number | null;
}

export interface StoreMarginLine extends MarginLine {
  /** Butikens andel: provision + hyra. */
  readonly storeShareOre: number;
  /** Vår del = kvar efter inköp − butikens andel. */
  readonly ourOre: number;
}

export interface MarginResult {
  readonly month: IsoMonth;
  /** Utvecklingen, äldst först (vald månad sist). */
  readonly months: readonly MarginMonth[];
  readonly current: MarginMonth;
  /**
   * Månaden före som jämförs: hela månaden, eller samma dagar när vald månad pågår
   * (`partial`). `null` utan order då.
   */
  readonly previous: MarginMonth | null;
  readonly revenueChangeBp: number | null;
  readonly keptChangeBp: number | null;
  /** Kvar efter inköp i bp av försäljningen. */
  readonly keptMarginBp: number | null;
  readonly machines: readonly MarginLine[];
  readonly stores: readonly StoreMarginLine[];
}

/** Kvar efter inköp för en rad: försäljning − inköp − avgifter − VMB-moms. */
export function keptOf(
  row: Pick<ProfitabilityRow, "revenueOre" | "costOre" | "feesOre" | "vmbVatOre">,
): number {
  return row.revenueOre - row.costOre - row.feesOre - row.vmbVatOre;
}

function withPeriod(input: ProfitabilityInput, start: IsoDate, end: IsoDate): ProfitabilityInput {
  return { ...input, period: { start, end } };
}

function monthRange(month: IsoMonth, asOf: IsoDate): { start: IsoDate; end: IsoDate } | null {
  const start = monthStart(month);
  if (start > asOf) return null;
  const end = monthEnd(month);
  return { start, end: end > asOf ? asOf : end };
}

/**
 * `input` ska innehålla orderna för alla `months` (äldst först, vald månad sist). `asOf` är
 * sista dagen som räknas (en pågående månad räknas till och med den).
 */
export function marginAndTrend(
  input: ProfitabilityInput,
  months: readonly IsoMonth[],
  asOf: IsoDate,
): MarginResult {
  if (months.length === 0) throw new Error("Minst en månad behövs.");
  const month = months[months.length - 1]!;

  const monthRows: MarginMonth[] = [];
  for (const m of months) {
    const range = monthRange(m, asOf);
    if (!range) continue;
    const t = profitability(withPeriod(input, range.start, range.end), "month").totals;
    monthRows.push({
      month: m,
      partial: range.end < monthEnd(m),
      orders: t.orders,
      revenueOre: t.revenueOre,
      keptOre: keptOf(t),
      unpricedRevenueOre: t.unpricedRevenueOre,
    });
  }
  const current = monthRows.find((r) => r.month === month) ?? {
    month,
    partial: true,
    orders: 0,
    revenueOre: 0,
    keptOre: 0,
    unpricedRevenueOre: 0,
  };

  // Jämförelsen: hela månaden före. Pågår vald månad jämförs samma antal dagar i månaden
  // före (1–10 nov. mot 1–10 okt.), så att en halv månad inte ser ut som ett ras.
  const range = monthRange(month, asOf);
  const prevMonth = months.length > 1 ? months[months.length - 2]! : null;
  let prevRange = prevMonth ? monthRange(prevMonth, asOf) : null;
  if (prevRange && range && current.partial) {
    const cut = addDays(prevRange.start, daysBetween(range.start, range.end));
    if (cut < prevRange.end) prevRange = { start: prevRange.start, end: cut };
  }
  let previous: MarginMonth | null = null;
  if (prevMonth && prevRange) {
    const full = monthRows.find((r) => r.month === prevMonth) ?? null;
    if (full && prevRange.end === monthEnd(prevMonth)) previous = full;
    else {
      const t = profitability(withPeriod(input, prevRange.start, prevRange.end), "month").totals;
      previous = {
        month: prevMonth,
        partial: true,
        orders: t.orders,
        revenueOre: t.revenueOre,
        keptOre: keptOf(t),
        unpricedRevenueOre: t.unpricedRevenueOre,
      };
    }
    if (previous.orders === 0) previous = null;
  }

  const now = range
    ? profitabilityViews(withPeriod(input, range.start, range.end), ["machine", "store"])
    : null;
  const before = prevRange
    ? profitabilityViews(withPeriod(input, prevRange.start, prevRange.end), ["machine"])
    : null;
  const beforeByMachine = new Map((before?.machine.rows ?? []).map((r) => [r.key, r]));

  const isReal = (r: ProfitabilityRow) =>
    (r.kind === "item" || r.key === NO_MACHINE_KEY || r.key === NO_STORE_KEY) && r.orders > 0;

  const machines: MarginLine[] = (now?.machine.rows ?? []).filter(isReal).map((r) => {
    const prev = beforeByMachine.get(r.key);
    const kept = keptOf(r);
    const prevKept = prev && prev.orders > 0 ? keptOf(prev) : null;
    return {
      key: r.key,
      orders: r.orders,
      revenueOre: r.revenueOre,
      keptOre: kept,
      previousKeptOre: prevKept,
      changeBp: prevKept === null ? null : changeBp(kept, prevKept),
    };
  });
  machines.sort((a, b) => b.keptOre - a.keptOre || (a.key < b.key ? -1 : 1));

  const stores: StoreMarginLine[] = (now?.store.rows ?? []).filter(isReal).map((r) => {
    const kept = keptOf(r);
    return {
      key: r.key,
      orders: r.orders,
      revenueOre: r.revenueOre,
      keptOre: kept,
      previousKeptOre: null,
      changeBp: null,
      storeShareOre: r.compensationOre,
      ourOre: kept - r.compensationOre,
    };
  });
  stores.sort((a, b) => b.keptOre - a.keptOre || (a.key < b.key ? -1 : 1));

  return {
    month,
    months: monthRows,
    current,
    previous,
    revenueChangeBp: previous ? changeBp(current.revenueOre, previous.revenueOre) : null,
    keptChangeBp: previous ? changeBp(current.keptOre, previous.keptOre) : null,
    keptMarginBp: ratioBp(current.keptOre, current.revenueOre),
    machines,
    stores,
  };
}
