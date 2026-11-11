/**
 * Personens knapp "Veckosammanfattning" (profiles.weekly_summary). Körs som användaren
 * under RLS: var och en läser och ändrar sin egen rad.
 *
 * null = inte valt: då följer den "Notiser i mobilen" (larmprenumerationen har push). Jobbet
 * (./job.ts, weeklyEnabled) räknar likadant.
 */

import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";

export interface WeeklyPref {
  /** Sammanfattningen skickas (valet, annars "Notiser i mobilen"). */
  readonly on: boolean;
  /** Personens eget val; null = inte valt. */
  readonly chosen: boolean | null;
  /** Personens påslagna push-enheter (adresser). Utan någon skickas inget. */
  readonly endpoints: string[];
}

export async function loadWeeklyPref(tx: Tx, orgId: string, userId: string): Promise<WeeklyPref> {
  const [[profile], [sub], devices] = await Promise.all([
    tx
      .select({ weeklySummary: s.profiles.weeklySummary })
      .from(s.profiles)
      .where(and(eq(s.profiles.organizationId, orgId), eq(s.profiles.userId, userId))),
    tx
      .select({ channels: s.alertSubscriptions.channels, active: s.alertSubscriptions.active })
      .from(s.alertSubscriptions)
      .where(
        and(
          eq(s.alertSubscriptions.organizationId, orgId),
          eq(s.alertSubscriptions.userId, userId),
        ),
      ),
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
  const chosen = profile?.weeklySummary ?? null;
  const alertPush = Boolean(sub?.active && sub.channels.includes("push"));
  return { on: chosen ?? alertPush, chosen, endpoints: devices.map((d) => d.endpoint) };
}

/** Sparar valet i den egna profilen (profilen skapas om den saknas). */
export async function saveWeeklyPref(
  tx: Tx,
  ctx: { orgId: string; userId: string; email: string },
  on: boolean,
): Promise<void> {
  const fallbackName = ctx.email.split("@")[0]?.trim() || "Medlem";
  await tx
    .insert(s.profiles)
    .values({
      organizationId: ctx.orgId,
      userId: ctx.userId,
      displayName: fallbackName.slice(0, 200),
      weeklySummary: on,
    })
    .onConflictDoUpdate({
      target: [s.profiles.organizationId, s.profiles.userId],
      set: { weeklySummary: on },
    });
}
