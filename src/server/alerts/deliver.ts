/**
 * Skickar köade larmutskick (alert_deliveries med status 'pending' och sändtid ≤ nu).
 *
 * Varje utskick låses med `for update skip locked` i en egen transaktion, så att två
 * samtidiga körningar aldrig skickar samma utskick två gånger. Utfallet per kanal sparas på
 * raden (results), och push-enheter som push-tjänsten säger inte finns längre stängs av.
 * Körs som systemroll av /api/cron/larm.
 *
 * Behörigheten kontrolleras igen när utskicket skickas, inte bara när det köades: ett
 * utskick som väntat under tysta timmar skickas inte till den som tagits bort ur
 * organisationen eller stängt av sina larm, och den som blivit påfyllare får bara
 * larmen om automater och lager.
 */

import "server-only";

import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import type { AlertDelivery, AlertNotification } from "@/analytics/alerts";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import {
  dispatchDelivery,
  type Channel,
  type DispatchOptions,
  type DispatchResult,
  type Recipient,
} from "@/server/notify";

import { FIELD_KINDS } from "./subscriptions";

export interface DeliverySummary {
  readonly processed: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

type Dispatcher = (
  delivery: AlertDelivery,
  recipient: Recipient,
  options: DispatchOptions,
) => Promise<DispatchResult>;

/** Ämnesrad när några larm filtrerats bort (samma form som routeNotifications). */
function subjectOf(items: readonly AlertNotification[]): string {
  const first = items[0]?.title ?? "Larm";
  return items.length > 1 ? `${items.length} larm: ${first} med flera` : first;
}

/** Användarens e-post (auth.users). Larmjobbet kör som systemroll och får läsa den. */
async function userEmail(db: Db, userId: string): Promise<string | null> {
  const rows = await db.execute(
    sql`select email::text as email from auth.users where id = ${userId}::uuid`,
  );
  const row = Array.from(rows)[0] as { email?: string | null } | undefined;
  return row?.email ?? null;
}

/**
 * Skickar alla utskick som är på tur. `baseUrl` används för länkar i e-post och sms.
 * `dispatch` kan bytas i tester.
 */
export async function deliverDue(
  db: Db,
  options: { now?: Date; baseUrl: string; limit?: number; dispatch?: Dispatcher },
): Promise<DeliverySummary> {
  const now = options.now ?? new Date();
  const dispatch = options.dispatch ?? dispatchDelivery;
  const due = await db
    .select({ id: s.alertDeliveries.id })
    .from(s.alertDeliveries)
    .where(and(eq(s.alertDeliveries.status, "pending"), lte(s.alertDeliveries.sendAt, now)))
    .orderBy(asc(s.alertDeliveries.sendAt))
    .limit(options.limit ?? 200);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const { id } of due) {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(s.alertDeliveries)
        .where(and(eq(s.alertDeliveries.id, id), eq(s.alertDeliveries.status, "pending")))
        .for("update", { skipLocked: true });
      if (!row) return null;
      if (!row.userId) {
        await tx
          .update(s.alertDeliveries)
          .set({
            status: "skipped",
            results: [
              { channel: "all", status: "skipped", detail: "Användaren finns inte längre" },
            ],
            sentAt: now,
          })
          .where(eq(s.alertDeliveries.id, id));
        return "skipped" as const;
      }
      const skip = async (detail: string) => {
        await tx
          .update(s.alertDeliveries)
          .set({
            status: "skipped",
            results: [{ channel: "all", status: "skipped", detail }],
            sentAt: now,
          })
          .where(eq(s.alertDeliveries.id, id));
        return "skipped" as const;
      };
      const [member] = await tx
        .select({ role: s.memberships.role })
        .from(s.memberships)
        .where(
          and(
            eq(s.memberships.organizationId, row.organizationId),
            eq(s.memberships.userId, row.userId),
          ),
        );
      if (!member || member.role === "store") {
        return skip("Användaren är inte längre medlem i organisationen");
      }
      let items = row.items as AlertNotification[];
      if (member.role === "refiller") {
        items = items.filter((i) => FIELD_KINDS.includes(i.kind));
        if (items.length === 0) {
          return skip("Påfyllaren får bara larm om automater och lager");
        }
      }
      const [org] = await tx
        .select({
          name: s.organizations.name,
          timezone: s.organizations.timezone,
          isDemo: s.organizations.isDemo,
        })
        .from(s.organizations)
        .where(eq(s.organizations.id, row.organizationId));
      // Inget mejl, sms eller push från en demo (Demo för kunder).
      if (org?.isDemo) {
        return skip("Demo: inget skickas");
      }
      const [sub] = await tx
        .select({
          channels: s.alertSubscriptions.channels,
          phone: s.alertSubscriptions.phone,
          active: s.alertSubscriptions.active,
        })
        .from(s.alertSubscriptions)
        .where(
          and(
            eq(s.alertSubscriptions.organizationId, row.organizationId),
            eq(s.alertSubscriptions.userId, row.userId),
          ),
        );
      if (sub && !sub.active) return skip("Användaren har stängt av sina larm");
      const devices = await tx
        .select({
          id: s.pushSubscriptions.id,
          endpoint: s.pushSubscriptions.endpoint,
          p256dh: s.pushSubscriptions.p256dh,
          auth: s.pushSubscriptions.authSecret,
        })
        .from(s.pushSubscriptions)
        .where(
          and(
            eq(s.pushSubscriptions.organizationId, row.organizationId),
            eq(s.pushSubscriptions.userId, row.userId),
            isNull(s.pushSubscriptions.disabledAt),
          ),
        );
      const delivery: AlertDelivery = {
        userId: row.userId,
        sendAt: row.sendAt.toISOString(),
        deferred: row.deferred,
        subject: items.length === (row.items as unknown[]).length ? row.subject : subjectOf(items),
        items,
      };
      const recipient: Recipient = {
        userId: row.userId,
        email: await userEmail(db, row.userId),
        phone: sub?.phone ?? null,
        channels: (sub?.channels ?? ["email"]) as Channel[],
        pushDevices: devices,
      };
      const result = await dispatch(delivery, recipient, {
        baseUrl: options.baseUrl,
        timeZone: org?.timezone ?? "Europe/Stockholm",
        organizationName: org?.name ?? "Binderlab",
        idempotencyKey: row.id,
      });
      await tx
        .update(s.alertDeliveries)
        .set({ status: result.status, results: result.results, sentAt: now })
        .where(eq(s.alertDeliveries.id, id));
      if (result.goneDevices.length > 0) {
        await tx
          .update(s.pushSubscriptions)
          .set({
            disabledAt: now,
            lastFailureAt: now,
            failureCount: sql`${s.pushSubscriptions.failureCount} + 1`,
          })
          .where(inArray(s.pushSubscriptions.id, result.goneDevices));
      }
      if (result.okDevices.length > 0) {
        await tx
          .update(s.pushSubscriptions)
          .set({ lastSuccessAt: now, failureCount: 0 })
          .where(inArray(s.pushSubscriptions.id, result.okDevices));
      }
      return result.status;
    });
    if (outcome === "sent" || outcome === "partial") sent += 1;
    else if (outcome === "failed") failed += 1;
    else if (outcome === "skipped") skipped += 1;
  }
  return { processed: due.length, sent, failed, skipped };
}
