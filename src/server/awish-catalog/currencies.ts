/** Valutorna i Awish-kontot (Currencies, bara läsning). */

import "server-only";

import type { AwishCurrencyInfo } from "@/server/awish/control/types";
import type { Viewer } from "@/server/data/core/loaders";

import { withReadClient, type CatalogDeps } from "./common";

/** SEK bland Awishs valutor, eller null. */
export function sekCurrency(currencies: readonly AwishCurrencyInfo[]): AwishCurrencyInfo | null {
  return currencies.find((c) => c.code.trim().toUpperCase() === "SEK") ?? null;
}

/** "SEK · kr" */
export function currencyLabel(c: AwishCurrencyInfo): string {
  return [c.code, c.symbol].filter((s) => s.trim() !== "").join(" · ") || c.name;
}

export async function currenciesFor(
  viewer: Viewer,
  deps: CatalogDeps = {},
): Promise<AwishCurrencyInfo[]> {
  return withReadClient(viewer, deps, ({ api }) => api.currencies());
}
