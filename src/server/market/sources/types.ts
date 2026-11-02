/**
 * Adaptergränssnitt för externa marknadspriser på förseglade produkter (booster-pack,
 * displayer, ETB). Ingen extern källa är inkopplad: beställaren ska tillfrågas först
 * (se docs/marknadskallor.md). Det som finns är gränssnittet, en lokal källa för
 * utveckling och test (fil i .data) och valet via miljövariabeln MARKET_PRICE_SOURCE.
 *
 * En adapter hämtar priser för en produkt och returnerar dem i minsta valutaenhet
 * (öre, cent) med källa, datum och länk, så att varje pris i panelen kan spåras.
 */

import type { IsoDate } from "@/domain";

/** Källor som adaptern kan väljas för. Bara 'local' har en implementation i dag. */
export const MARKET_SOURCE_IDS = [
  "none",
  "local",
  "tcgplayer",
  "cardmarket",
  "pricecharting",
] as const;
export type MarketSourceId = (typeof MARKET_SOURCE_IDS)[number];

/** Produkttyp för förseglade produkter. */
export type SealedKind = "booster-pack" | "booster-box" | "elite-trainer-box" | "other";

/** Vad som efterfrågas: en titel i panelen. */
export interface MarketPriceQuery {
  readonly titleId: string;
  /** Titelns kanoniska namn, t.ex. "Surging Sparks". */
  readonly titleName: string;
  readonly series?: string | null;
  readonly kind?: SealedKind;
}

/** Ett observerat marknadspris. */
export interface MarketPricePoint {
  readonly source: Exclude<MarketSourceId, "none">;
  /** Produktens namn hos källan. */
  readonly productName: string;
  readonly kind: SealedKind;
  /** ISO 4217, t.ex. "SEK", "EUR", "USD". */
  readonly currency: string;
  /** Pris i minsta enheten (öre, cent). */
  readonly priceMinor: number;
  /** Vilket pris det är hos källan, t.ex. "trend", "lowest", "market". */
  readonly priceType: string;
  readonly observedOn: IsoDate;
  /** Länk till produkten hos källan, om källan har en. */
  readonly url: string | null;
}

/** En källa för marknadspriser. */
export interface MarketPriceSource {
  readonly id: Exclude<MarketSourceId, "none">;
  /** Namnet som visas i panelen. */
  readonly name: string;
  /** Sant för källor som bara får användas lokalt (testdata). */
  readonly localOnly: boolean;
  /** Priser för titlarna. Titlar utan träff saknas i resultatet. */
  fetchPrices(
    queries: readonly MarketPriceQuery[],
  ): Promise<ReadonlyMap<string, readonly MarketPricePoint[]>>;
}

/** Läget som panelen visar. */
export type MarketSourceStatus =
  | { readonly kind: "not-configured"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly source: MarketSourceId; readonly reason: string }
  | { readonly kind: "ready"; readonly source: MarketPriceSource };
