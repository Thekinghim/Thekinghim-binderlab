/**
 * Larmjobbet: utvärderar reglerna för en organisation, sparar incidenterna och lägger
 * utskicken i kön (alert_deliveries).
 *
 *   maskinhälsa (@/analytics/health) ─┐
 *   titel nära slut                   ├→ kandidater → reconcileAlerts (samma problem = en
 *   misslyckad import                 │   incident; påminnelse, skärpning, löst) → aviseringar
 *   avvikande dag (i går)             │   → routeNotifications (prenumerationer, tysta timmar,
 *   ny automat hittad (Awish)        ─┘   tider) → utskick per användare och sändtid
 *
 * Körs som systemroll (getServiceDb) av /api/cron/larm, aldrig på uppdrag av en användare.
 * Allt läses och skrivs med organization_id i varje fråga. Två körningar samtidigt för samma
 * organisation stoppas av ett advisory-lås (den andra hoppar över).
 */

import "server-only";

import { and, eq, gte, isNull, or, sql } from "drizzle-orm";

import {
  dayAnomalyAlerts,
  discoveredMachineAlerts,
  healthAlerts,
  importAlerts,
  lowStockAlerts,
  reconcileAlerts,
  routeNotifications,
  type AlertCandidate,
  type AlertDelivery,
  type AlertIncident,
  type AlertKind,
  type AlertNotification,
  type AlertSubscription,
} from "@/analytics/alerts";
import { localDayStartMs } from "@/analytics/health";
import { retiredPairs } from "@/analytics/todos/assortment";
import { businessDateAt } from "@/analytics/todos/time";
import type { Db, Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate } from "@/domain";

import { queryNewMachines } from "@/server/machines/new-machines";
import { recordJobOutcome } from "@/server/monitoring/failures";

import { alertColumns, healthOf, knownUntil, loadHealthData, loadImportData } from "./inputs";
import { incidentChanged, incidentToColumns, isRowId, rowToIncident, type AlertRow } from "./store";
import { rowToSubscription, FIELD_KINDS, type SubscriptionRow } from "./subscriptions";

/** Dagar bakåt som stängda incidenter läses (engångslarm och fladder jämförs mot dem). */
const HISTORY_DAYS = 10;

export interface EvaluationSummary {
  readonly organizationId: string;
  readonly status: "ok" | "skipped" | "failed";
  readonly machines: number;
  readonly candidates: number;
  readonly openIncidents: number;
  readonly notifications: number;
  readonly deliveries: number;
  readonly error?: string;
}

/** Läser incidenterna som reconcileAlerts behöver: alla öppna och de senaste dagarnas stängda. */
export async function loadIncidents(tx: Tx, orgId: string, now: Date): Promise<AlertIncident[]> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const rows = (await tx
    .select(alertColumns)
    .from(s.alerts)
    .where(
      and(
        eq(s.alerts.organizationId, orgId),
        sql`${s.alerts.incidentKey} is not null`,
        or(
          eq(s.alerts.status, "open"),
          gte(s.alerts.triggeredAt, since),
          gte(s.alerts.closedAt, since),
        ),
      ),
    )) as AlertRow[];
  return rows.map(rowToIncident).filter((i): i is AlertIncident => i !== null);
}

/** Prenumerationerna i organisationen, med rollens begränsning (påfyllaren: bara automater och lager). */
export async function loadSubscriptions(tx: Tx, orgId: string): Promise<SubscriptionRow[]> {
  const rows = await tx
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
      role: s.memberships.role,
    })
    .from(s.alertSubscriptions)
    .innerJoin(
      s.memberships,
      and(
        eq(s.memberships.organizationId, s.alertSubscriptions.organizationId),
        eq(s.memberships.userId, s.alertSubscriptions.userId),
      ),
    )
    .where(
      and(eq(s.alertSubscriptions.organizationId, orgId), eq(s.alertSubscriptions.active, true)),
    );
  return rows;
}

/**
 * Kandidaterna för organisationen just nu. Returnerar också hälsan (för räkningen) och vilka
 * familjer som utvärderades (familjer utan indata lämnas orörda).
 */
export async function collectCandidates(
  tx: Tx,
  orgId: string,
  timeZone: string,
  now: Date,
): Promise<{ candidates: AlertCandidate[]; machines: number }> {
  const today = businessDateAt(now, timeZone);
  const data = await loadHealthData(tx, orgId, today, now);
  // Tystnaden räknas bara fram till dit försäljningen är importerad (healthInputOf).
  const health = healthOf(data, timeZone, now);
  const imports = await loadImportData(tx, orgId, now, data.coverage);
  // Avvikande dag bedömer i går: bara när försäljningen är känd hela i går (annars är en
  // fil som inte laddats upp än en "dålig dag").
  const known = knownUntil(data.coverage);
  const yesterdayKnown = known === null || known.getTime() >= localDayStartMs(today, timeZone);
  // Ny automat hittad: samma lista som Att göra (inte kopplad, inte "Inte vår").
  const discovered = await queryNewMachines(tx, orgId);
  // Titlar som gått ur automaten (Utgår på Lager) larmar inte: samma regel som Lager.
  const slots = await tx
    .select({
      machineId: s.machineSlots.machineId,
      titleId: s.machineSlots.titleId,
      validFrom: s.machineSlots.validFrom,
      validTo: s.machineSlots.validTo,
    })
    .from(s.machineSlots)
    .where(eq(s.machineSlots.organizationId, orgId));
  const retired = retiredPairs(
    slots.map((r) => ({
      machineId: r.machineId,
      titleId: r.titleId,
      validFrom: r.validFrom as IsoDate,
      validTo: (r.validTo ?? null) as IsoDate | null,
    })),
    today,
  );
  const candidates: AlertCandidate[] = [
    ...healthAlerts(health),
    ...lowStockAlerts(
      {
        orders: data.orders,
        stock: data.stock,
        machines: data.machines,
        titles: data.titles,
        retired,
        options: { timeZone },
      },
      now,
    ),
    ...importAlerts(
      { sources: imports.sources, imports: imports.imports, options: { timeZone } },
      now,
    ),
    ...(yesterdayKnown
      ? dayAnomalyAlerts(
          { orders: data.orders, machines: data.machines, options: { timeZone } },
          now,
        )
      : []),
    ...discoveredMachineAlerts(discovered),
  ];
  return { candidates, machines: data.machines.length };
}

/** Sparar incidenterna: uppdaterar ändrade rader (stängningar först), skapar nya. Ger id-bytet. */
async function saveIncidents(
  tx: Tx,
  orgId: string,
  before: readonly AlertIncident[],
  after: readonly AlertIncident[],
): Promise<Map<string, string>> {
  const prev = new Map(before.map((i) => [i.id, i]));
  const idMap = new Map<string, string>();
  const updates = after.filter((i) => isRowId(i.id) && prev.has(i.id));
  // Stängningar före öppningar, så att det unika indexet (en öppen per nyckel) håller.
  updates.sort((a, b) => (a.status === "closed" ? 0 : 1) - (b.status === "closed" ? 0 : 1));
  for (const i of updates) {
    idMap.set(i.id, i.id);
    if (!incidentChanged(prev.get(i.id)!, i)) continue;
    await tx
      .update(s.alerts)
      .set(incidentToColumns(i))
      .where(and(eq(s.alerts.organizationId, orgId), eq(s.alerts.id, i.id)));
  }
  for (const i of after) {
    if (isRowId(i.id) && prev.has(i.id)) continue;
    const [row] = await tx
      .insert(s.alerts)
      .values({ organizationId: orgId, ...incidentToColumns(i) })
      .returning({ id: s.alerts.id });
    if (row) idMap.set(i.id, row.id);
  }
  return idMap;
}

/** Lägger utskicken i kön. */
async function enqueueDeliveries(
  tx: Tx,
  orgId: string,
  deliveries: readonly AlertDelivery[],
): Promise<number> {
  for (const d of deliveries) {
    await tx.insert(s.alertDeliveries).values({
      organizationId: orgId,
      userId: d.userId,
      sendAt: new Date(d.sendAt),
      deferred: d.deferred,
      status: "pending",
      subject: d.subject.slice(0, 300) || "Larm",
      items: d.items as unknown[],
      alertIds: [...new Set(d.items.map((n) => n.incidentId).filter(isRowId))],
      results: [],
    });
  }
  return deliveries.length;
}

/** Påfyllaren får bara larm om automater och lager, oavsett prenumeration. */
export function allowedSubscriptions(rows: readonly SubscriptionRow[]): AlertSubscription[] {
  return rows.map((r) => {
    const sub = rowToSubscription(r);
    if (r.role !== "refiller") return sub;
    const kinds: AlertKind[] =
      sub.kinds === "all" ? [...FIELD_KINDS] : sub.kinds.filter((k) => FIELD_KINDS.includes(k));
    return { ...sub, kinds, active: sub.active !== false && kinds.length > 0 };
  });
}

/**
 * Utvärderar en organisation i en transaktion: kandidater, incidenter, utskick och en rad i
 * alert_runs. Returnerar en sammanfattning. Kastar inte för regelfel: de loggas i alert_runs.
 */
export async function evaluateOrganization(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<EvaluationSummary> {
  let summary: EvaluationSummary;
  try {
    summary = await db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`alerts/${orgId}`}, 0)) as locked`,
      );
      if (!lock?.locked) {
        return {
          organizationId: orgId,
          status: "skipped" as const,
          machines: 0,
          candidates: 0,
          openIncidents: 0,
          notifications: 0,
          deliveries: 0,
        };
      }
      const [org] = await tx
        .select({ timezone: s.organizations.timezone })
        .from(s.organizations)
        .where(and(eq(s.organizations.id, orgId), isNull(s.organizations.archivedAt)));
      if (!org) throw new Error("Organisationen finns inte eller är arkiverad.");

      const { candidates, machines } = await collectCandidates(tx, orgId, org.timezone, now);
      const previous = await loadIncidents(tx, orgId, now);
      const result = reconcileAlerts(candidates, previous, now, { timeZone: org.timezone });
      const idMap = await saveIncidents(tx, orgId, previous, result.incidents);

      const notifications: AlertNotification[] = result.notifications.map((n) => ({
        ...n,
        incidentId: idMap.get(n.incidentId) ?? n.incidentId,
      }));
      const subs = allowedSubscriptions(await loadSubscriptions(tx, orgId)).map((sub) => ({
        ...sub,
        timeZone: org.timezone,
      }));
      const deliveries = routeNotifications(notifications, subs, now);
      const queued = await enqueueDeliveries(tx, orgId, deliveries);
      const openIncidents = result.incidents.filter((i) => i.status === "open").length;

      await tx.insert(s.alertRuns).values({
        organizationId: orgId,
        ranAt: now,
        status: "ok",
        machines,
        candidates: candidates.length,
        openIncidents,
        notifications: notifications.length,
        deliveries: queued,
        healthSource: "sales",
      });
      return {
        organizationId: orgId,
        status: "ok" as const,
        machines,
        candidates: candidates.length,
        openIncidents,
        notifications: notifications.length,
        deliveries: queued,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await db.insert(s.alertRuns).values({
        organizationId: orgId,
        ranAt: now,
        status: "failed",
        error: message.slice(0, 2000),
      });
    } catch {
      // Organisationen finns inte: inget att logga.
      return failedSummary(orgId, message);
    }
    // Felövervakning: Sentry och ett systemlarm (job:larm) som syns på Drift.
    await recordJobOutcome({ db, now }, { organizationId: orgId, job: "larm", error });
    return failedSummary(orgId, message);
  }
  // Lyckad körning stänger ett tidigare jobblarm.
  if (summary.status === "ok") {
    await recordJobOutcome({ db, now }, { organizationId: orgId, job: "larm", error: null });
  }
  return summary;
}

function failedSummary(orgId: string, message: string): EvaluationSummary {
  return {
    organizationId: orgId,
    status: "failed",
    machines: 0,
    candidates: 0,
    openIncidents: 0,
    notifications: 0,
    deliveries: 0,
    error: message,
  };
}

/** Alla organisationer som inte är arkiverade. */
export async function activeOrganizations(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: s.organizations.id })
    .from(s.organizations)
    .where(isNull(s.organizations.archivedAt));
  return rows.map((r) => r.id);
}
