/**
 * Marknad för sidor och server actions: sessionens användare som Viewer och laddaren,
 * memoiserad per förfrågan. Logiken ligger i ./service (databas) och ./model (beräkning).
 */

import "server-only";

import { cache } from "react";

import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

import { loadMarketDataFor, type Viewer } from "./service";
import { marketSourceStatus, type MarketPricePoint, type MarketSourceStatus } from "./sources";
import type { MarketData } from "./types";

export type { MarketData } from "./types";

/** Den inloggade användaren och den aktiva organisationen. */
export const currentMarketViewer = cache(async (): Promise<Viewer> => {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (!organization) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  return { user, organization };
});

/** Allt /marknad räknar på (ägare, admin och läsare). */
export const loadMarket = cache(async (): Promise<MarketData> =>
  loadMarketDataFor(await currentMarketViewer()),
);

/** Externa marknadspriser per titel, om en källa är vald. */
export interface MarketReferences {
  readonly status: MarketSourceStatus;
  readonly prices: ReadonlyMap<string, readonly MarketPricePoint[]>;
  /** Felet om källan inte kunde läsas. */
  readonly error: string | null;
}

export async function loadMarketReferences(
  data: MarketData,
  titleIds: readonly string[],
): Promise<MarketReferences> {
  const status = marketSourceStatus();
  if (status.kind !== "ready" || titleIds.length === 0) {
    return { status, prices: new Map(), error: null };
  }
  const titles = new Map(data.titles.map((t) => [t.id, t]));
  try {
    const prices = await status.source.fetchPrices(
      titleIds.flatMap((id) => {
        const t = titles.get(id);
        return t ? [{ titleId: id, titleName: t.name, series: t.series }] : [];
      }),
    );
    return { status, prices, error: null };
  } catch (error) {
    return {
      status,
      prices: new Map(),
      error: error instanceof Error ? error.message : "Källan kunde inte läsas.",
    };
  }
}
