/**
 * Notiser i mobilen: läs och spara personens egen rad i alert_subscriptions (det enkla
 * läget, ./notices.ts). Körs som användaren under RLS; var och en ändrar bara sin egen rad.
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";

import { applyNoticeChange, noticeState, type NoticeChange, type NoticeState } from "./notices";
import type { SubscriptionRow } from "./subscriptions";

export async function loadOwnSubscription(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select({
      userId: s.alertSubscriptions.userId,
      kinds: s.alertSubscriptions.kinds,
      machineIds: s.alertSubscriptions.machineIds,
      minSeverity: s.alertSubscriptions.minSeverity,
      channels: s.alertSubscriptions.channels,
      phone: s.alertSubscriptions.phone,
      quietStart: s.alertSubscriptions.quietStart,
      quietEnd: s.alertSubscriptions.quietEnd,
      deliveryWindows: s.alertSubscriptions.deliveryWindows,
      criticalDuringQuiet: s.alertSubscriptions.criticalDuringQuiet,
      notifyResolved: s.alertSubscriptions.notifyResolved,
      reminders: s.alertSubscriptions.reminders,
      active: s.alertSubscriptions.active,
    })
    .from(s.alertSubscriptions)
    .where(
      and(eq(s.alertSubscriptions.organizationId, orgId), eq(s.alertSubscriptions.userId, userId)),
    );
  return row ?? null;
}

/** Sparar en ändring av knappen eller typerna. Ger det nya läget, eller ett fel att visa. */
export async function saveNoticeChange(
  tx: Tx,
  ctx: { orgId: string; userId: string; role: string },
  change: NoticeChange,
): Promise<{ ok: true; state: NoticeState } | { ok: false; error: string }> {
  const current = await loadOwnSubscription(tx, ctx.orgId, ctx.userId);
  const next = applyNoticeChange(current, change, { userId: ctx.userId, role: ctx.role });
  if (!next.ok) return next;
  const r = next.row;
  const values = {
    kinds: r.kinds,
    machineIds: r.machineIds,
    minSeverity: r.minSeverity,
    channels: r.channels,
    phone: r.phone,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    deliveryWindows: r.deliveryWindows,
    criticalDuringQuiet: r.criticalDuringQuiet,
    notifyResolved: r.notifyResolved,
    reminders: r.reminders,
    active: r.active,
  };
  await tx
    .insert(s.alertSubscriptions)
    .values({ organizationId: ctx.orgId, userId: ctx.userId, ...values })
    .onConflictDoUpdate({
      target: [s.alertSubscriptions.organizationId, s.alertSubscriptions.userId],
      set: values,
    });
  return { ok: true, state: noticeState(r, ctx.role) };
}
