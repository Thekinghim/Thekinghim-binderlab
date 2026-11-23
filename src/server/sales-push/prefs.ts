/**
 * Personens knapp "Notis vid varje försäljning" (profiles.sale_push_since) och "Tyst på
 * natten" (profiles.sale_push_quiet). Körs som användaren under RLS: var och en läser och
 * ändrar sin egen rad. Av som standard (null).
 */

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";

export interface SalePushPref {
  readonly on: boolean;
  readonly quiet: boolean;
  /** Personens påslagna push-enheter (adresser). Utan någon skickas inget. */
  readonly endpoints: string[];
}

export async function loadSalePushPref(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<SalePushPref> {
  const [[profile], devices] = await Promise.all([
    tx
      .select({ since: s.profiles.salePushSince, quiet: s.profiles.salePushQuiet })
      .from(s.profiles)
      .where(and(eq(s.profiles.organizationId, orgId), eq(s.profiles.userId, userId))),
    tx
      .select({ endpoint: s.pushSubscriptions.endpoint })
      .from(s.pushSubscriptions)
      .where(
        and(
          eq(s.pushSubscriptions.organizationId, orgId),
          eq(s.pushSubscriptions.userId, userId),
          isNull(s.pushSubscriptions.disabledAt),
        ),
      ),
  ]);
  return {
    on: profile?.since != null,
    quiet: profile?.quiet ?? false,
    endpoints: devices.map((d) => d.endpoint),
  };
}

/**
 * Sparar valet i den egna profilen (profilen skapas om den saknas). På: tidpunkten sätts till
 * nu, om knappen inte redan var på (då behålls den). Av: null.
 */
export async function saveSalePushPref(
  tx: Tx,
  ctx: { orgId: string; userId: string; email: string },
  change: { readonly on?: boolean; readonly quiet?: boolean },
): Promise<void> {
  const fallbackName = ctx.email.split("@")[0]?.trim() || "Medlem";
  const since =
    change.on === undefined
      ? undefined
      : change.on
        ? sql`coalesce(${s.profiles.salePushSince}, now())`
        : sql`null`;
  await tx
    .insert(s.profiles)
    .values({
      organizationId: ctx.orgId,
      userId: ctx.userId,
      displayName: fallbackName.slice(0, 200),
      salePushSince: change.on ? sql`now()` : null,
      salePushQuiet: change.quiet ?? false,
    })
    .onConflictDoUpdate({
      target: [s.profiles.organizationId, s.profiles.userId],
      set: {
        ...(since !== undefined ? { salePushSince: since } : {}),
        ...(change.quiet !== undefined ? { salePushQuiet: change.quiet } : {}),
      },
    });
}
