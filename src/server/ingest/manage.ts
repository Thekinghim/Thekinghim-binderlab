/**
 * Datakällor → "Automatisk synk (Chrome-tillägg)": datakällor av typen Awish-tillägg,
 * synk-tokens och status. Bundet till en verifierad användare (Viewer); allt läses
 * och skrivs som användaren med RLS och bara som ägare eller admin.
 *
 * Token visas EN gång (returneras av createSyncTokenFor) och sparas bara som sha256.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "@/db/client";
import { isValidTimeZone } from "@/import/zoned";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import { SILENCE_ALERT_MINUTES } from "./limits";
import { generateToken } from "./tokens";

type Row = Record<string, unknown>;

/** Högst så många aktiva tokens per datakälla (en per dator med tillägget räcker). */
export const MAX_ACTIVE_TOKENS = 10;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

export const createExtensionSourceSchema = z.object({
  name: z.string().trim().min(1, "Ange ett namn.").max(200, "Namnet får vara högst 200 tecken."),
  sourceTimezone: z
    .string()
    .trim()
    .min(1, "Välj en tidszon.")
    .max(64)
    .refine(isValidTimeZone, "Okänd tidszon."),
});

export const createTokenSchema = z.object({
  dataSourceId: uuid,
  name: z
    .string()
    .trim()
    .min(1, "Ange vilken dator token är till.")
    .max(100, "Namnet får vara högst 100 tecken."),
});

export const revokeTokenSchema = z.object({ id: uuid });

export class ExtensionSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionSetupError";
  }
}

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, fn);
}

// ---------------------------------------------------------------------------
// Läsning
// ---------------------------------------------------------------------------

export interface SyncTokenView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  createdBy: string | null;
  lastSeenAt: string | null;
  lastBatchAt: string | null;
  lastStatus: "ok" | "logged_out" | "error" | null;
  lastError: string | null;
  clientVersion: string | null;
  revokedAt: string | null;
}

export interface ExtensionSourceView {
  id: string;
  name: string;
  sourceTimezone: string;
  status: string;
  archived: boolean;
  lastSyncedAt: string | null;
  latestOrderAt: string | null;
  orders: number;
  /** Nya order senaste dygnet (importerade av tillägget). */
  newLast24h: number;
  /** Batcher senaste dygnet, och hur många av dem som misslyckades eller hade felrader. */
  batchesLast24h: number;
  failedLast24h: number;
  errorRowsLast24h: number;
  /** Tyst längre än larmgränsen (två timmar). */
  silent: boolean;
  tokens: SyncTokenView[];
}

export interface ExtensionPanelData {
  now: string;
  silenceMinutes: number;
  sources: ExtensionSourceView[];
}

/** Datakällor av typen Awish-tillägg med tokens och status. Bara ägare och admin. */
export async function loadExtensionPanelFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<ExtensionPanelData> {
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const [sources, tokens] = await Promise.all([
      query(
        tx,
        sql`select ds.id, ds.name, ds.source_timezone, ds.status::text as status,
                   ds.last_synced_at, ds.archived_at,
                   (select count(*) from public.orders o
                     where o.organization_id = ds.organization_id and o.data_source_id = ds.id)::int as orders,
                   (select max(o.ordered_at) from public.orders o
                     where o.organization_id = ds.organization_id and o.data_source_id = ds.id) as latest_order_at,
                   coalesce((select sum(i.rows_new) from public.imports i
                     where i.organization_id = ds.organization_id and i.data_source_id = ds.id
                       and i.created_at >= ${since}::timestamptz), 0)::int as new_24h,
                   (select count(*) from public.imports i
                     where i.organization_id = ds.organization_id and i.data_source_id = ds.id
                       and i.created_at >= ${since}::timestamptz)::int as batches_24h,
                   (select count(*) from public.imports i
                     where i.organization_id = ds.organization_id and i.data_source_id = ds.id
                       and i.created_at >= ${since}::timestamptz and i.status = 'failed')::int as failed_24h,
                   coalesce((select sum(i.rows_error) from public.imports i
                     where i.organization_id = ds.organization_id and i.data_source_id = ds.id
                       and i.created_at >= ${since}::timestamptz), 0)::int as error_rows_24h
            from public.data_sources ds
            where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_extension'
            order by ds.archived_at nulls first, ds.created_at`,
      ),
      query(
        tx,
        sql`select t.id, t.data_source_id, t.name, t.token_prefix, t.created_at,
                   p.display_name as created_by, t.last_seen_at, t.last_batch_at, t.last_status,
                   t.last_error, t.client_version, t.revoked_at
            from public.sync_tokens t
            left join public.profiles p on p.organization_id = t.organization_id and p.user_id = t.created_by
            where t.organization_id = ${orgId}::uuid
            order by t.revoked_at nulls first, t.created_at desc`,
      ),
    ]);
    const tokensBySource = new Map<string, SyncTokenView[]>();
    for (const t of tokens) {
      const list = tokensBySource.get(String(t.data_source_id)) ?? [];
      list.push({
        id: String(t.id),
        name: String(t.name),
        prefix: String(t.token_prefix),
        createdAt: iso(t.created_at) ?? now.toISOString(),
        createdBy: typeof t.created_by === "string" ? t.created_by : null,
        lastSeenAt: iso(t.last_seen_at),
        lastBatchAt: iso(t.last_batch_at),
        lastStatus:
          t.last_status === "ok" || t.last_status === "logged_out" || t.last_status === "error"
            ? t.last_status
            : null,
        lastError: typeof t.last_error === "string" ? t.last_error : null,
        clientVersion: typeof t.client_version === "string" ? t.client_version : null,
        revokedAt: iso(t.revoked_at),
      });
      tokensBySource.set(String(t.data_source_id), list);
    }
    return {
      now: now.toISOString(),
      silenceMinutes: SILENCE_ALERT_MINUTES,
      sources: sources.map((s): ExtensionSourceView => {
        const lastSyncedAt = iso(s.last_synced_at);
        const archived = s.archived_at !== null && s.archived_at !== undefined;
        const sourceTokens = tokensBySource.get(String(s.id)) ?? [];
        const silent =
          !archived &&
          sourceTokens.some((t) => !t.revokedAt) &&
          (lastSyncedAt === null ||
            now.getTime() - new Date(lastSyncedAt).getTime() > SILENCE_ALERT_MINUTES * 60_000);
        return {
          id: String(s.id),
          name: String(s.name),
          sourceTimezone: String(s.source_timezone),
          status: String(s.status),
          archived,
          lastSyncedAt,
          latestOrderAt: iso(s.latest_order_at),
          orders: Number(s.orders ?? 0),
          newLast24h: Number(s.new_24h ?? 0),
          batchesLast24h: Number(s.batches_24h ?? 0),
          failedLast24h: Number(s.failed_24h ?? 0),
          errorRowsLast24h: Number(s.error_rows_24h ?? 0),
          silent,
          tokens: sourceTokens,
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Ändringar
// ---------------------------------------------------------------------------

/**
 * Ny datakälla av typen Awish-tillägg. Returnerar id.
 *
 * last_synced_at sätts till nu när källan skapas: larmet för utebliven hämtning (två
 * timmar utan synk) räknar då från att källan skapades, i stället för att slå till direkt
 * innan tillägget ens är installerat.
 */
export async function createExtensionSourceFor(
  viewer: Viewer,
  input: z.infer<typeof createExtensionSourceSchema>,
): Promise<string> {
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const [row] = await query<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name, source_timezone, last_synced_at)
          values (${orgId}::uuid, 'awish_extension', ${input.name}, ${input.sourceTimezone}, now())
          returning id`,
    );
    if (!row) throw new Error("Datakällan kunde inte skapas.");
    return row.id;
  });
}

export interface CreatedToken {
  id: string;
  /** Token i klartext. Visas en gång och sparas aldrig. */
  token: string;
  prefix: string;
}

/** Ny synk-token för en datakälla av typen Awish-tillägg. */
export async function createSyncTokenFor(
  viewer: Viewer,
  input: z.infer<typeof createTokenSchema>,
): Promise<CreatedToken> {
  const orgId = viewer.organization.id;
  const created = generateToken();
  return asOperator(viewer, async (tx) => {
    const [source] = await query<{ id: string }>(
      tx,
      sql`select id from public.data_sources
          where organization_id = ${orgId}::uuid and id = ${input.dataSourceId}::uuid
            and provider = 'awish_extension' and archived_at is null`,
    );
    if (!source) {
      throw new ExtensionSetupError("Datakällan finns inte eller är inte ett Awish-tillägg.");
    }
    const [active] = await query<{ n: number }>(
      tx,
      sql`select count(*)::int as n from public.sync_tokens
          where organization_id = ${orgId}::uuid and data_source_id = ${input.dataSourceId}::uuid
            and revoked_at is null`,
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_TOKENS) {
      throw new ExtensionSetupError(
        `Datakällan har redan ${MAX_ACTIVE_TOKENS} aktiva tokens. Återkalla en innan du skapar en ny.`,
      );
    }
    const [row] = await query<{ id: string }>(
      tx,
      sql`insert into public.sync_tokens (organization_id, data_source_id, name, token_hash, token_prefix)
          values (${orgId}::uuid, ${input.dataSourceId}::uuid, ${input.name}, ${created.hash}, ${created.prefix})
          returning id`,
    );
    if (!row) throw new Error("Token kunde inte skapas.");
    return { id: row.id, token: created.token, prefix: created.prefix };
  });
}

/** Återkallar en token. Den slutar fungera direkt och kan inte återställas. */
export async function revokeSyncTokenFor(
  viewer: Viewer,
  input: z.infer<typeof revokeTokenSchema>,
): Promise<void> {
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    const updated = await query(
      tx,
      sql`update public.sync_tokens set revoked_at = now()
          where organization_id = ${orgId}::uuid and id = ${input.id}::uuid and revoked_at is null
          returning id`,
    );
    if (updated.length === 0) {
      throw new ExtensionSetupError("Token finns inte eller är redan återkallad.");
    }
  });
}
