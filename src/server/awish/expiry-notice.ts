/**
 * Påminnelsen om Awish-kontots slutdag (./expiry.ts) för den inloggade: Att göra, Hem,
 * Drift och Datakällor. Bara ägare och admin (de kan förlänga och se datakällorna); andra
 * roller får null. Läses under RLS. Den tidigaste slutdagen bland organisationens
 * Awish API-källor (inte arkiverade) gäller.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

import { awishExpiryNotice, type AwishExpiryNotice } from "./expiry";

/** Påminnelsen, eller null (ingen slutdag inom 30 dagar, eller rollen ser inte datakällor). */
export async function loadAwishExpiryFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<AwishExpiryNotice | null> {
  const role = await getRoleFor(viewer.user, viewer.organization.id);
  if (role !== "owner" && role !== "admin") return null;
  const rows = await withUserDbFor(viewer.user, async (tx) =>
    Array.from(
      await tx.execute(
        sql`select min(awish_expires_at) as expires_at from public.data_sources
            where organization_id = ${viewer.organization.id}::uuid
              and provider = 'awish_grpc' and archived_at is null
              and awish_expires_at is not null`,
      ),
    ),
  );
  const raw = (rows[0] as { expires_at?: unknown } | undefined)?.expires_at ?? null;
  if (raw === null) return null;
  const at = raw instanceof Date ? raw : new Date(String(raw));
  return awishExpiryNotice(at, now, viewer.organization.timezone);
}

/** Som loadAwishExpiryFor, men ett fel ger null (påminnelsen får inte fälla sidan). */
export async function loadAwishExpirySafe(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<AwishExpiryNotice | null> {
  try {
    return await loadAwishExpiryFor(viewer, now);
  } catch (error) {
    console.error("[awish] kontots slutdag kunde inte läsas:", error);
    return null;
  }
}
