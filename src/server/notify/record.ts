/**
 * Sparar ett utskicks utfall per push-enhet: lyckad (räknaren nollas), misslyckad (räknaren
 * ökar och push-tjänstens svar sparas) eller borta (enheten stängs av). Körs som systemroll.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import * as s from "@/db/schema";

import type { DispatchResult } from "./index";

export async function recordPushOutcome(
  db: Db | Tx,
  organizationId: string,
  result: Pick<DispatchResult, "okDevices" | "goneDevices" | "failedDevices">,
  now: Date,
): Promise<void> {
  const inOrg = (ids: string[]) =>
    and(
      eq(s.pushSubscriptions.organizationId, organizationId),
      inArray(s.pushSubscriptions.id, ids),
    );
  if (result.okDevices.length > 0) {
    await db
      .update(s.pushSubscriptions)
      .set({ lastSuccessAt: now, failureCount: 0, lastFailureDetail: null })
      .where(inOrg(result.okDevices));
  }
  if (result.goneDevices.length > 0) {
    await db
      .update(s.pushSubscriptions)
      .set({
        disabledAt: now,
        lastFailureAt: now,
        lastFailureDetail: "Enheten finns inte längre (HTTP 404/410)",
        failureCount: sql`${s.pushSubscriptions.failureCount} + 1`,
      })
      .where(inOrg(result.goneDevices));
  }
  for (const failed of result.failedDevices) {
    await db
      .update(s.pushSubscriptions)
      .set({
        lastFailureAt: now,
        lastFailureDetail: failed.detail.slice(0, 120),
        failureCount: sql`${s.pushSubscriptions.failureCount} + 1`,
      })
      .where(inOrg([failed.id]));
  }
}
