/**
 * Saker som ser konstiga ut kring utbetalningarna från Nayax, räknade på färdiga summor.
 * Rena funktioner. Ger samma varningskoder som payout-split.ts (texten står i gränssnittet)
 * och samma fakta till AI-sammanfattningen.
 *
 *   GAP_DAYS         dagar med försäljning mellan två utbetalningar som ingen täcker
 *   SHARE_JUMP       butikens andel av försäljningen är mer än dubbelt så stor som medianen
 *                    för de tre senaste månaderna (och minst 5 procentenheter högre)
 *   UNMAPPED_DEVICE  en automat i rapporten (serienummer) som inte finns bland våra automater
 */

import { addDays } from "./dates";
import type { IsoDate } from "./types";
import type { SplitWarning } from "./payout-split";

/** Dagar med försäljning som ligger mellan täckta perioder utan att täckas. */
export function gapWarnings(
  covered: readonly { readonly from: IsoDate; readonly to: IsoDate }[],
  salesDays: ReadonlySet<IsoDate>,
): SplitWarning[] {
  const sorted = [...covered].sort((a, b) => (a.from < b.from ? -1 : 1));
  const out: SplitWarning[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1]!.to;
    const nextStart = sorted[i]!.from;
    let gapFrom: IsoDate | null = null;
    let gapTo: IsoDate | null = null;
    for (let d = addDays(prevEnd, 1); d < nextStart; d = addDays(d, 1)) {
      if (!salesDays.has(d)) continue;
      gapFrom ??= d;
      gapTo = d;
    }
    if (gapFrom && gapTo) out.push({ code: "GAP_DAYS", from: gapFrom, to: gapTo });
  }
  return out;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Butiker vars andel (bp av försäljningen) hoppat jämfört med de senaste månaderna. */
export function shareJumpWarnings(
  stores: readonly {
    readonly storeId: string;
    readonly shareOre: number;
    readonly grossOre: number;
    /** Andel i bp för de tre senaste hela månaderna (de som finns). */
    readonly historyBp: readonly number[];
  }[],
): SplitWarning[] {
  const out: SplitWarning[] = [];
  for (const s of stores) {
    if (s.grossOre <= 0 || s.shareOre <= 0) continue;
    const med = median(s.historyBp);
    if (med === null || med <= 0) continue;
    const ratio = Math.round((s.shareOre * 10_000) / s.grossOre);
    if (ratio > med * 2 && ratio - med >= 500) {
      out.push({ code: "SHARE_JUMP", storeId: s.storeId, ratioBp: ratio, medianBp: med });
    }
  }
  return out;
}

/** Serienummer i rapporten som inte hör till någon av våra automater. */
export function unmappedDeviceWarnings(
  serials: readonly string[],
  known: ReadonlySet<string>,
): SplitWarning[] {
  const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
  const knownNorm = new Set([...known].map(norm));
  const seen = new Set<string>();
  const out: SplitWarning[] = [];
  for (const serial of serials) {
    const n = norm(serial);
    if (!n || knownNorm.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push({ code: "UNMAPPED_DEVICE", serial: serial.trim() });
  }
  return out;
}
