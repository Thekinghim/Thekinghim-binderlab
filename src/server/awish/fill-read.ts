/**
 * Uppdatera i Fyll på: läser automaternas fack i Awish nu (readFillStock i ./sync) för
 * alla som fyller på (ägare, admin, påfyllare), inte bara ägare/admin som "Hämta nu" i
 * Datakällor. Rollen kontrolleras mot databasen; läsningen körs sedan som systemrollen
 * med organisationen ur den kontrollerade sessionen (aldrig ur förfrågan). Bara facken:
 * inga order, inga inloggningsuppgifter eller belopp i svaret.
 *
 * Spärr per organisation (högst en läsning per 20 s, se FILL_READ_INTERVAL_MS): ett
 * tryck inom spärren läser inte Awish, sidan hämtar bara om datan.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { requireRoleFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { FIELD_REFILL_ROLES } from "@/server/data/field-refills";
import { isDemoFor } from "@/server/demo/guard";

import type { AwishApi, AwishCredentials } from "./grpc-client";
import { readFillStock, type AwishConnectOptions, type FillReadResult } from "./sync";

export interface FillRefreshResult {
  /** none: ingen Awish API-källa. demo: Demo för kunder (inga anrop till Awish). */
  readonly status: FillReadResult["status"] | "none" | "demo";
  /** Senaste Awish-läsningen av någon automat i organisationen (ISO), efter försöket. */
  readonly lastReadAt: string | null;
}

export interface FillRefreshDeps {
  serviceDb?: Db;
  connect?: (creds: AwishCredentials, options?: AwishConnectOptions) => AwishApi;
  now?: () => Date;
}

async function lastReadAt(db: Db, orgId: string): Promise<string | null> {
  const [row] = Array.from(
    await db.execute(
      sql`select max(awish_synced_at) as at from public.stock_locations
          where organization_id = ${orgId}::uuid and machine_id is not null
            and archived_at is null`,
    ),
  ) as { at: Date | string | null }[];
  if (!row?.at) return null;
  const d = row.at instanceof Date ? row.at : new Date(row.at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export async function refreshFillStockFor(
  viewer: Viewer,
  deps: FillRefreshDeps = {},
): Promise<FillRefreshResult> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, FIELD_REFILL_ROLES);
  const db = deps.serviceDb ?? getServiceDb();
  if (await isDemoFor(viewer.user, orgId)) {
    return { status: "demo", lastReadAt: await lastReadAt(db, orgId) };
  }
  const [source] = Array.from(
    await db.execute(
      sql`select id from public.data_sources
          where organization_id = ${orgId}::uuid and provider = 'awish_grpc'
            and archived_at is null
          order by created_at
          limit 1`,
    ),
  ) as { id: string }[];
  if (!source) return { status: "none", lastReadAt: await lastReadAt(db, orgId) };
  const r = await readFillStock(
    { db, connect: deps.connect, now: deps.now },
    { dataSourceId: source.id },
  );
  return { status: r.status, lastReadAt: await lastReadAt(db, orgId) };
}
