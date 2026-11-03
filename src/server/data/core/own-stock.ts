/**
 * "Vårt lager" = summan av alla egna lager (stock_locations kind 'warehouse': Hemma,
 * Kontoret …). Ren och klientsäker. Allt som läser vårt lager (Prognos & inköp, besöks-
 * planen, Att göra, dagar kvar, AI-verktygen, lagervärdet) räknar med summan per titel,
 * om inte en plats är vald.
 */

import type { StockRow } from "./types";

/** Saldot i vårt lager för en titel: summan över alla egna lager. */
export interface OwnStockRow {
  readonly titleId: string;
  /** Summan av lagrens saldon (kan vara negativ om ett lager inte är räknat). */
  readonly onHand: number;
  /** Senaste inventeringen i något av lagren. */
  readonly lastCountedAt: string | null;
  readonly lastEventAt: string | null;
  readonly lastRestockedAt: string | null;
}

const later = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** Summan per titel över alla egna lager, i titelordningen raderna kom i. */
export function sumOwnStock(
  rows: readonly Pick<
    StockRow,
    "locationKind" | "titleId" | "onHand" | "lastCountedAt" | "lastEventAt" | "lastRestockedAt"
  >[],
): OwnStockRow[] {
  const out = new Map<string, OwnStockRow>();
  for (const r of rows) {
    if (r.locationKind !== "warehouse") continue;
    const cur = out.get(r.titleId);
    out.set(
      r.titleId,
      cur
        ? {
            titleId: r.titleId,
            onHand: cur.onHand + r.onHand,
            lastCountedAt: later(cur.lastCountedAt, r.lastCountedAt),
            lastEventAt: later(cur.lastEventAt, r.lastEventAt),
            lastRestockedAt: later(cur.lastRestockedAt, r.lastRestockedAt),
          }
        : {
            titleId: r.titleId,
            onHand: r.onHand,
            lastCountedAt: r.lastCountedAt,
            lastEventAt: r.lastEventAt,
            lastRestockedAt: r.lastRestockedAt,
          },
    );
  }
  return [...out.values()];
}

/** Bara titel och antal (för inköpsplanen, besöksplanen och värderingen). */
export function ownStockTotals(
  rows: Parameters<typeof sumOwnStock>[0],
): { titleId: string; onHand: number }[] {
  return sumOwnStock(rows).map((r) => ({ titleId: r.titleId, onHand: r.onHand }));
}

/** Sant om någon rad är ett eget lager. */
export function hasOwnStockRows(rows: readonly Pick<StockRow, "locationKind">[]): boolean {
  return rows.some((r) => r.locationKind === "warehouse");
}
