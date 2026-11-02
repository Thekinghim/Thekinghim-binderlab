/**
 * Val av källa för marknadspriser (MARKET_PRICE_SOURCE):
 *
 *   none (standard)  ingen källa; panelen visar "Ej konfigurerad"
 *   local            LocalMarketPriceSource (fil i .data, bara utanför production)
 *   tcgplayer, cardmarket, pricecharting
 *                    kandidater som beställaren ska ta ställning till. De är INTE
 *                    inkopplade: valet ger läget "unavailable" med förklaring.
 *
 * MARKET_PRICE_LOCAL_FILE anger en annan fil för den lokala källan.
 * Se docs/marknadskallor.md och docs/miljoer.md.
 */

import { LocalMarketPriceSource } from "./local";
import { MARKET_SOURCE_IDS, type MarketSourceId, type MarketSourceStatus } from "./types";

export * from "./types";
export { LocalMarketPriceSource, normalizeTitle, parseLocalPrices } from "./local";

/** Kandidaterna i docs/marknadskallor.md, med namnet som visas. */
export const MARKET_SOURCE_CANDIDATES: ReadonlyArray<{
  readonly id: Exclude<MarketSourceId, "none" | "local">;
  readonly name: string;
}> = [
  { id: "tcgplayer", name: "TCGplayer" },
  { id: "cardmarket", name: "Cardmarket" },
  { id: "pricecharting", name: "PriceCharting" },
];

type Env = Readonly<Record<string, string | undefined>>;

function isSourceId(value: string): value is MarketSourceId {
  return (MARKET_SOURCE_IDS as readonly string[]).includes(value);
}

/** Läget för marknadspriser enligt miljövariablerna. */
export function marketSourceStatus(env: Env = process.env): MarketSourceStatus {
  const raw = (env.MARKET_PRICE_SOURCE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "none") {
    return {
      kind: "not-configured",
      reason: "Ingen extern källa för marknadspriser är vald.",
    };
  }
  if (!isSourceId(raw)) {
    return {
      kind: "unavailable",
      source: "none",
      reason: `MARKET_PRICE_SOURCE har ett okänt värde (${raw}).`,
    };
  }
  if (raw === "local") {
    const appEnv = (env.APP_ENV ?? env.NODE_ENV ?? "development").trim();
    if (appEnv === "production") {
      return {
        kind: "unavailable",
        source: "local",
        reason: "Den lokala testkällan används inte i drift.",
      };
    }
    const file = env.MARKET_PRICE_LOCAL_FILE?.trim();
    return { kind: "ready", source: new LocalMarketPriceSource(file || undefined) };
  }
  const name = MARKET_SOURCE_CANDIDATES.find((c) => c.id === raw)?.name ?? raw;
  return {
    kind: "unavailable",
    source: raw,
    reason: `${name} är inte inkopplad. Källan kopplas in först när beställaren har godkänt villkor och kostnad.`,
  };
}
