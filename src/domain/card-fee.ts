/**
 * Kortavgiften med startdatum (ren logik).
 *
 * Satserna ligger som en stigande lista. Första raden är grundsatsen: den gäller också
 * före sitt datum. En ny sats "från en dag" lägger till en rad den dagen och tar bort
 * rader som börjar senare, så att den nya satsen gäller från dagen och framåt. Dagar före
 * den dagen behåller den sats de hade.
 */

import { cardFeeBpOn } from "./economics";
import type { CardFeeRate, IsoDate, Settings } from "./types";

/** Startdatum för grundsatsen när en organisation får sin första daterade ändring. */
export const CARD_FEE_BASE_FROM: IsoDate = "2000-01-01";

/**
 * Ny lista när satsen `bp` ska gälla från `from` (ÅÅÅÅ-MM-DD) och framåt. `from` = null
 * betyder alla datum (en enda sats). Dagar före `from` ändras inte.
 */
export function setCardFeeFrom(
  settings: Pick<Settings, "cardFeeBp" | "cardFeeRates">,
  from: IsoDate | null,
  bp: number,
): CardFeeRate[] {
  if (from === null) return [{ validFrom: CARD_FEE_BASE_FROM, cardFeeBp: bp }];
  const current: CardFeeRate[] = settings.cardFeeRates?.length
    ? [...settings.cardFeeRates]
    : [{ validFrom: CARD_FEE_BASE_FROM, cardFeeBp: settings.cardFeeBp }];
  const kept = current.filter((r) => r.validFrom < from);
  // Börjar listan senare än `from` behålls grundsatsen för dagarna före.
  if (kept.length === 0) {
    const before = cardFeeBpOn(settings, from);
    if (before === bp) return [{ validFrom: CARD_FEE_BASE_FROM, cardFeeBp: bp }];
    const baseFrom = from > CARD_FEE_BASE_FROM ? CARD_FEE_BASE_FROM : null;
    if (baseFrom === null) return [{ validFrom: from, cardFeeBp: bp }];
    return [
      { validFrom: baseFrom, cardFeeBp: before },
      { validFrom: from, cardFeeBp: bp },
    ];
  }
  if (kept[kept.length - 1]!.cardFeeBp === bp) return kept;
  return [...kept, { validFrom: from, cardFeeBp: bp }];
}

/** Listan som den sparas (organization_settings.card_fee_history). */
export function cardFeeHistoryJson(rates: readonly CardFeeRate[]): { from: string; bp: number }[] {
  return rates.map((r) => ({ from: r.validFrom, bp: r.cardFeeBp }));
}

/** Läser den sparade listan; ogiltiga rader hoppas över. Stigande datum. */
export function parseCardFeeHistory(value: unknown): CardFeeRate[] {
  if (!Array.isArray(value)) return [];
  const out: CardFeeRate[] = [];
  for (const e of value) {
    const from = (e as { from?: unknown } | null)?.from;
    const bp = (e as { bp?: unknown } | null)?.bp;
    if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from)) continue;
    if (typeof bp !== "number" || !Number.isInteger(bp) || bp < 0 || bp > 10_000) continue;
    out.push({ validFrom: from as IsoDate, cardFeeBp: bp });
  }
  return out.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
}
