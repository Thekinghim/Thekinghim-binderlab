/**
 * Fortnox-token i Supabase Vault ("{organisation}/fortnox"), lästa och skrivna bara av
 * systemrollen (private.fortnox_*_tokens). Token lämnar aldrig servern och skrivs aldrig i
 * loggar eller fel.
 *
 * Fortnox byter refresh-token vid varje förnyelse och den gamla gäller inte efteråt. Två
 * körningar som förnyar samtidigt med samma refresh-token skulle därför slå ut kopplingen.
 * Förnyelsen görs därför under ett lås per organisation (pg_advisory_xact_lock) i en
 * transaktion: den som kommer tvåa läser den token som ettan just sparade i stället för att
 * förnya igen.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";

import {
  FortnoxAuthError,
  refreshTokens,
  type FortnoxDeps,
  type FortnoxTokens,
  type TokenSource,
} from "./client";
import type { FortnoxConfig } from "./config";

/** Förnya när mindre än så här återstår av åtkomsttoken. */
const REFRESH_MARGIN_MS = 120_000;

export async function readTokens(tx: Db | Tx, orgId: string): Promise<FortnoxTokens | null> {
  const rows = Array.from(
    await tx.execute<{ t: unknown }>(sql`select private.fortnox_read_tokens(${orgId}::uuid) as t`),
  );
  const t = (rows[0]?.t ?? null) as Record<string, unknown> | null;
  if (
    !t ||
    typeof t.accessToken !== "string" ||
    typeof t.refreshToken !== "string" ||
    typeof t.accessExpiresAt !== "string"
  ) {
    return null;
  }
  const expires = new Date(t.accessExpiresAt);
  if (Number.isNaN(expires.getTime())) return null;
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: expires };
}

export async function saveTokens(tx: Db | Tx, orgId: string, tokens: FortnoxTokens): Promise<void> {
  await tx.execute(
    sql`select private.fortnox_save_tokens(${orgId}::uuid, ${tokens.accessToken},
          ${tokens.refreshToken}, ${tokens.accessExpiresAt.toISOString()}::timestamptz)`,
  );
}

export async function clearTokens(tx: Db | Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select private.fortnox_clear_tokens(${orgId}::uuid)`);
}

async function lock(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fortnox-token:${orgId}`}))`);
}

/**
 * Token-källan för en organisation. Kastar FortnoxAuthError('invalid_grant') när kopplingen
 * inte gäller längre; då markeras kopplingen som "behöver kopplas igen".
 */
export function tokenSource(
  db: Db,
  orgId: string,
  config: FortnoxConfig,
  deps: FortnoxDeps = {},
): TokenSource {
  const now = deps.now ?? Date.now;
  let cached: FortnoxTokens | null = null;
  const fresh = (t: FortnoxTokens) => t.accessExpiresAt.getTime() - now() > REFRESH_MARGIN_MS;

  return async (force = false) => {
    if (!force && cached && fresh(cached)) return cached.accessToken;
    const rejected = force ? (cached?.accessToken ?? null) : null;
    try {
      cached = await db.transaction(async (tx) => {
        await lock(tx, orgId);
        const stored = await readTokens(tx, orgId);
        if (!stored) {
          throw new FortnoxAuthError("invalid_grant", "Fortnox är inte kopplat.");
        }
        // Någon annan hann förnya medan vi väntade på låset: använd den.
        if (fresh(stored) && stored.accessToken !== rejected) return stored;
        const next = await refreshTokens(config, stored.refreshToken, deps);
        await saveTokens(tx, orgId, next);
        return next;
      });
    } catch (error) {
      if (error instanceof FortnoxAuthError && error.kind === "invalid_grant") {
        cached = null;
        await db.execute(sql`
          update public.fortnox_connections set status = 'needs_reconnect'
          where organization_id = ${orgId}::uuid and status <> 'needs_reconnect'`);
      }
      throw error;
    }
    return cached.accessToken;
  };
}
