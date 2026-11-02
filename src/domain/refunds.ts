/**
 * Återbetalningar från kundärenden (tabellen incidents: refunded_ore, refunded_on).
 *
 * En återbetalning är pengar som gått tillbaka till en kund (t.ex. när automaten tog betalt men
 * inte matade ut något). Den räknas på återbetalningsdagen, på den automat och titel ärendet
 * gäller, och för butik på den butik automaten stod i den dagen (placeringen).
 *
 * Återbetalningen är en separat justering av lönsamheten, inte en del av profitability():
 *
 *   vinst efter återbetalningar   = vinst − återbetalt
 *   marginal efter återbetalningar = round(vinst efter återbetalningar × 10 000 / intäkt) bp
 *
 * Intäkten, inköpet, avgifterna och butiksersättningen ändras inte (ordern är fortfarande
 * betald och importerad, och provisionen beräknas på det betalda beloppet enligt avtalet).
 * Därför är profitability() och alla befintliga totaler oförändrade, och justeringen visas
 * som en egen rad. Se docs/berakningar.md, avsnitt 14.
 */

import { assertIsoDate, assertPeriod, inPeriod, monthOf } from "./dates";
import { DomainError } from "./errors";
import { assertNonNegativeInteger, ratioBp, sumOre } from "./money";
import { PlacementIndex } from "./placements";
import type { IsoDate, Period, Placement } from "./types";

/** En återbetalning (ett kundärende med återbetalt belopp > 0). */
export interface Refund {
  /** Ärendets id. */
  readonly id: string;
  readonly machineId: string | null;
  readonly titleId: string | null;
  /** Återbetalningsdagen (affärsdatum). */
  readonly refundedOn: IsoDate;
  /** Återbetalt belopp i öre, ≥ 0. */
  readonly amountOre: number;
}

/** Gruppering av återbetalningar. */
export type RefundGroupBy = "total" | "machine" | "title" | "store" | "day" | "month";

/** Nyckel för återbetalningar utan automat, titel eller butik. */
export const REFUND_NONE_KEY = "none";

/** En rad i sammanställningen. */
export interface RefundRow {
  /** Automat-, titel- eller butiks-id, datum, månad, 'total' eller REFUND_NONE_KEY. */
  readonly key: string;
  readonly count: number;
  readonly amountOre: number;
  /** Ärendenas id, sorterade. */
  readonly refundIds: string[];
}

/** Sammanställning av återbetalningar i en period. */
export interface RefundSummary {
  readonly period: Period;
  readonly groupBy: RefundGroupBy;
  /** Sorterade efter belopp (störst först), sedan nyckel. Tidsvyer i datumordning. */
  readonly rows: RefundRow[];
  readonly count: number;
  readonly amountOre: number;
}

function validate(refund: Refund): void {
  assertIsoDate(refund.refundedOn, "återbetalningsdag");
  assertNonNegativeInteger(refund.amountOre, "Återbetalt belopp");
  if (typeof refund.id !== "string" || refund.id.length === 0) {
    throw new DomainError("invalid_input", "Återbetalningen saknar id.");
  }
}

/** Återbetalningar med belopp > 0 vars dag ligger i perioden (båda ändar inräknade). */
export function refundsInPeriod(refunds: readonly Refund[], period: Period): Refund[] {
  assertPeriod(period);
  const out: Refund[] = [];
  for (const r of refunds) {
    validate(r);
    if (r.amountOre > 0 && inPeriod(r.refundedOn, period)) out.push(r);
  }
  return out;
}

/**
 * Summerar återbetalningarna i perioden per automat, titel, butik (placeringen på
 * återbetalningsdagen), dag eller månad. Summan av raderna är alltid lika med totalen.
 */
export function summarizeRefunds(
  refunds: readonly Refund[],
  period: Period,
  groupBy: RefundGroupBy,
  placements: readonly Placement[] = [],
): RefundSummary {
  const inside = refundsInPeriod(refunds, period);
  const index = groupBy === "store" ? new PlacementIndex(placements) : null;
  const keyOf = (r: Refund): string => {
    switch (groupBy) {
      case "total":
        return "total";
      case "machine":
        return r.machineId ?? REFUND_NONE_KEY;
      case "title":
        return r.titleId ?? REFUND_NONE_KEY;
      case "store":
        return (r.machineId && index?.storeOn(r.machineId, r.refundedOn)) || REFUND_NONE_KEY;
      case "day":
        return r.refundedOn;
      case "month":
        return monthOf(r.refundedOn);
    }
  };
  const groups = new Map<string, Refund[]>();
  for (const r of inside) {
    const k = keyOf(r);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  const rows: RefundRow[] = [...groups].map(([key, list]) => ({
    key,
    count: list.length,
    amountOre: sumOre(list.map((r) => r.amountOre)),
    refundIds: list.map((r) => r.id).sort(),
  }));
  const timeView = groupBy === "day" || groupBy === "month";
  rows.sort((a, b) =>
    timeView
      ? a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0
      : b.amountOre - a.amountOre || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return {
    period,
    groupBy,
    rows,
    count: inside.length,
    amountOre: sumOre(inside.map((r) => r.amountOre)),
  };
}

/** En lönsamhetsrad som justeringen läggs på (t.ex. en rad ur profitability()). */
export interface ProfitLine {
  readonly key: string;
  readonly revenueOre: number;
  readonly profitOre: number;
}

/** Lönsamhetsraden efter återbetalningar. */
export interface ProfitAfterRefunds {
  readonly key: string;
  readonly revenueOre: number;
  readonly profitOre: number;
  readonly refundOre: number;
  readonly refundCount: number;
  readonly profitAfterRefundsOre: number;
  /** null när intäkten är 0. */
  readonly marginAfterRefundsBp: number | null;
}

/** Vinst efter återbetalningar för en rad: vinst − återbetalt och marginalen på intäkten. */
export function profitAfterRefunds(
  line: ProfitLine,
  refundOre: number,
  refundCount = 0,
): ProfitAfterRefunds {
  assertNonNegativeInteger(refundOre, "Återbetalt belopp");
  const after = sumOre([line.profitOre, -refundOre]);
  return {
    key: line.key,
    revenueOre: line.revenueOre,
    profitOre: line.profitOre,
    refundOre,
    refundCount,
    profitAfterRefundsOre: after,
    marginAfterRefundsBp: ratioBp(after, line.revenueOre),
  };
}

/**
 * Lägger återbetalningarna i perioden på lönsamhetsraderna (samma gruppering och nycklar som
 * raderna, t.ex. automat-id för vyn per automat). Återbetalningar vars nyckel saknar rad får
 * en egen rad med intäkt och vinst 0, så att summan av justeringarna alltid är lika med alla
 * återbetalningar i perioden.
 */
export function applyRefunds(
  lines: readonly ProfitLine[],
  refunds: readonly Refund[],
  period: Period,
  groupBy: Exclude<RefundGroupBy, "day" | "month">,
  placements: readonly Placement[] = [],
): ProfitAfterRefunds[] {
  const summary = summarizeRefunds(refunds, period, groupBy, placements);
  const byKey = new Map(summary.rows.map((r) => [r.key, r]));
  const out = lines.map((line) => {
    const r = byKey.get(line.key);
    byKey.delete(line.key);
    return profitAfterRefunds(line, r?.amountOre ?? 0, r?.count ?? 0);
  });
  for (const r of byKey.values()) {
    out.push(profitAfterRefunds({ key: r.key, revenueOre: 0, profitOre: 0 }, r.amountOre, r.count));
  }
  return out;
}
