/**
 * Aviseringar för systemlarm: när ett systemlarm (misslyckat jobb, rapportutskick,
 * månadsutkast) skapas läggs utskick i kön (alert_deliveries) till dem som prenumererar,
 * med samma regler som larmjobbets egna larm (routeNotifications: typ, lägsta allvar,
 * tysta timmar). Larmjobbet skickar kön var 10:e minut (deliverDue), även när
 * utvärderingen för organisationen misslyckas.
 *
 * Påfyllaren får aldrig systemlarm (allowedSubscriptions släpper bara automat och lager).
 * Bara en ny incident aviseras; samma öppna incident som ses igen gör det inte.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { routeNotifications, type AlertNotification } from "@/analytics/alerts";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";

import type { SystemAlertInput } from "./system-alerts";

/**
 * Lägger utskicken för ett nytt systemlarm i kön. Ger antalet utskick. `roles` begränsar
 * mottagarna till medlemmar med de rollerna (Daglig kontroll: bara ägare och admin).
 */
export async function notifySystemAlert(
  db: Db,
  alertId: string,
  input: SystemAlertInput,
  options: { readonly roles?: readonly string[] } = {},
): Promise<number> {
  // Dynamisk import: larmjobbet (evaluate) importerar själv felövervakningen.
  const { allowedSubscriptions, loadSubscriptions } = await import("@/server/alerts/evaluate");
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ timezone: s.organizations.timezone })
      .from(s.organizations)
      .where(eq(s.organizations.id, input.organizationId));
    if (!org) return 0;
    const rows = (await loadSubscriptions(tx, input.organizationId)).filter(
      (r) => !options.roles || (r.role !== undefined && options.roles.includes(r.role)),
    );
    const subs = allowedSubscriptions(rows).map((sub) => ({ ...sub, timeZone: org.timezone }));
    const notification: AlertNotification = {
      incidentId: alertId,
      key: input.key,
      kind: input.kind,
      severity: input.severity,
      reason: "new",
      machineId: null,
      titleId: null,
      title: input.title,
      detail: input.detail,
      at: now.toISOString(),
      evidence: {
        rule: input.rule,
        period: null,
        orderIds: [],
        dates: [],
        titleIds: [],
        machineIds: [],
        storeIds: [],
        recipientIds: [],
        figures: (input.figures ?? []).map((f) => ({ ...f, unit: "count" as const })),
      },
      link: input.link,
    };
    const deliveries = routeNotifications([notification], subs, now);
    for (const d of deliveries) {
      await tx.insert(s.alertDeliveries).values({
        organizationId: input.organizationId,
        userId: d.userId,
        sendAt: new Date(d.sendAt),
        deferred: d.deferred,
        status: "pending",
        subject: d.subject.slice(0, 300) || "Larm",
        items: d.items as unknown[],
        alertIds: [alertId],
        results: [],
      });
    }
    if (deliveries.length > 0) {
      await tx
        .update(s.alerts)
        .set({
          lastNotifiedAt: now,
          notifiedSeverity: input.severity,
          notifyCount: sql`${s.alerts.notifyCount} + 1`,
        })
        .where(and(eq(s.alerts.organizationId, input.organizationId), eq(s.alerts.id, alertId)));
    }
    return deliveries.length;
  });
}
