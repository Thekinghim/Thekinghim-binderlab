/**
 * Våra egna lager (Hemma, Kontoret …) för påfyllningen: lagren, saldot per lager och
 * automaternas "Fylls på från". Läses som användaren med RLS (alla roller som ser lagret).
 */

import "server-only";

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Tx } from "@/db/client";

export interface RefillPlace {
  readonly id: string;
  readonly name: string;
  /** Standardlagret (används när inget annat är valt). */
  readonly isDefault: boolean;
}

export interface RefillSources {
  /** Aktiva egna lager, standardlagret först. */
  readonly places: RefillPlace[];
  /** Saldot per lager: platsens id → titelns id → pack. */
  readonly stock: Record<string, Record<string, number>>;
  /** Automatens valda "Fylls på från" (bara aktiva lager), per automat. */
  readonly machineSource: Record<string, string>;
  /** Standardlagrets id, eller null. */
  readonly defaultPlaceId: string | null;
}

export async function queryRefillSources(tx: Tx, orgId: string): Promise<RefillSources> {
  const [places, machineRows, levels] = await Promise.all([
    tx
      .select({
        id: s.stockLocations.id,
        name: s.stockLocations.name,
        isDefault: s.stockLocations.isCentral,
      })
      .from(s.stockLocations)
      .where(
        and(
          eq(s.stockLocations.organizationId, orgId),
          eq(s.stockLocations.kind, "warehouse"),
          isNull(s.stockLocations.archivedAt),
        ),
      )
      .orderBy(desc(s.stockLocations.isCentral), s.stockLocations.createdAt, s.stockLocations.id),
    tx
      .select({ machineId: s.stockLocations.machineId, source: s.stockLocations.refillSourceId })
      .from(s.stockLocations)
      .where(
        and(
          eq(s.stockLocations.organizationId, orgId),
          isNotNull(s.stockLocations.machineId),
          isNotNull(s.stockLocations.refillSourceId),
        ),
      ),
    tx
      .select({
        locationId: s.stockLevels.locationId,
        titleId: s.stockLevels.titleId,
        quantity: s.stockLevels.quantity,
      })
      .from(s.stockLevels)
      .innerJoin(
        s.stockLocations,
        and(
          eq(s.stockLocations.organizationId, s.stockLevels.organizationId),
          eq(s.stockLocations.id, s.stockLevels.locationId),
        ),
      )
      .where(and(eq(s.stockLevels.organizationId, orgId), eq(s.stockLocations.kind, "warehouse"))),
  ]);
  const active = new Set(places.map((p) => p.id));
  const stock: Record<string, Record<string, number>> = Object.fromEntries(
    places.map((p) => [p.id, {}]),
  );
  for (const l of levels) {
    const place = stock[l.locationId];
    if (place) place[l.titleId] = Number(l.quantity);
  }
  const machineSource: Record<string, string> = {};
  for (const m of machineRows) {
    if (m.machineId && m.source && active.has(m.source)) machineSource[m.machineId] = m.source;
  }
  return {
    places,
    stock,
    machineSource,
    defaultPlaceId: places.find((p) => p.isDefault)?.id ?? places[0]?.id ?? null,
  };
}
