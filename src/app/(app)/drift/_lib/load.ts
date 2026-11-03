/**
 * Laddare för Drift (/drift och undersidorna). Allt läses som den inloggade användaren med
 * RLS (withUserDb) efter att rollen kontrollerats (requireRoute). Påfyllaren ser automater,
 * lager, larm om automater och lager, och sina egna prenumerationer; aldrig belopp.
 * Siffrorna räknas av @/analytics (health, alerts, visits); här formas bara data.
 */

import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";

import type { AlertIncident } from "@/analytics/alerts";
import {
  machineTimeline,
  type MachineHealth,
  type MachineIncident,
  type MachineStockEvent,
  type TimelineEntry,
} from "@/analytics/health";
import { compareChannels, type VisitPlan } from "@/analytics/visits";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays } from "@/domain";
import { alertColumns, healthOf, loadHealthData, type HealthData } from "@/server/alerts/inputs";
import { rowToIncident, type AlertRow } from "@/server/alerts/store";
import { defaultSubscription, type SubscriptionRow } from "@/server/alerts/subscriptions";
import { channelStatus, type ChannelStatus } from "@/server/notify";
import { queryStock } from "@/server/data/core/queries";
import type { AppContext } from "@/server/data/core";
import { querySlotPeriods, type SlotPeriod } from "@/server/data/assortment";
import { querySlotCapacities, type SlotCapacityRow } from "@/server/data/core/slot-capacity";
import { weeklyVisitPlan } from "@/server/data/visit-plan";
import { withUserDb } from "@/server/session";
import { ownStockTotals } from "@/server/data/core/own-stock";
import { queryRefillSources } from "@/server/data/core/places";

/** Senaste körningen av larmjobbet. */
export interface AlertRunInfo {
  readonly ranAt: string;
  readonly status: string;
  readonly candidates: number;
  readonly openIncidents: number;
  readonly notifications: number;
  readonly error: string | null;
}

/** Ett larm som det visas: incidenten plus vem som kvitterat. */
export interface AlertView extends AlertIncident {
  readonly acknowledgedByName: string | null;
}

export interface DriftOverview {
  readonly data: HealthData;
  readonly health: MachineHealth[];
  readonly openAlerts: AlertView[];
  readonly recentAlerts: AlertView[];
  readonly lastRun: AlertRunInfo | null;
  readonly plan: VisitPlan;
  /** Kapacitet per automat och titel från Awish (fyllnadsgraden). Tom före första synken. */
  readonly capacities: SlotCapacityRow[];
}

async function names(tx: Tx, orgId: string, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({ userId: s.profiles.userId, name: s.profiles.displayName })
    .from(s.profiles)
    .where(and(eq(s.profiles.organizationId, orgId), inArray(s.profiles.userId, userIds)));
  const out = new Map<string, string>();
  for (const r of rows) if (r.userId && r.name) out.set(r.userId, r.name);
  return out;
}

async function loadAlerts(
  tx: Tx,
  orgId: string,
  now: Date,
  machineId?: string,
): Promise<{ open: AlertView[]; recent: AlertView[] }> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = (await tx
    .select(alertColumns)
    .from(s.alerts)
    .where(
      and(
        eq(s.alerts.organizationId, orgId),
        ...(machineId ? [eq(s.alerts.machineId, machineId)] : []),
        or(eq(s.alerts.status, "open"), gte(s.alerts.triggeredAt, since)),
        isNull(s.alerts.suppressedBy),
      ),
    )
    .orderBy(desc(s.alerts.triggeredAt))
    .limit(200)) as AlertRow[];
  const incidents = rows.map(rowToIncident).filter((i): i is AlertIncident => i !== null);
  const who = await names(tx, orgId, [
    ...new Set(incidents.map((i) => i.acknowledgedBy).filter((x): x is string => !!x)),
  ]);
  const view = (i: AlertIncident): AlertView => ({
    ...i,
    acknowledgedByName: i.acknowledgedBy ? (who.get(i.acknowledgedBy) ?? "Okänd användare") : null,
  });
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  const open = incidents
    .filter((i) => i.status === "open")
    .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.openedAt < b.openedAt ? 1 : -1))
    .map(view);
  const recent = incidents.filter((i) => i.status === "closed" && i.notifyCount > 0).map(view);
  return { open, recent };
}

async function loadLastRun(tx: Tx, orgId: string): Promise<AlertRunInfo | null> {
  const [row] = await tx
    .select({
      ranAt: s.alertRuns.ranAt,
      status: s.alertRuns.status,
      candidates: s.alertRuns.candidates,
      openIncidents: s.alertRuns.openIncidents,
      notifications: s.alertRuns.notifications,
      error: s.alertRuns.error,
    })
    .from(s.alertRuns)
    .where(and(eq(s.alertRuns.organizationId, orgId), ne(s.alertRuns.status, "skipped")))
    .orderBy(desc(s.alertRuns.ranAt))
    .limit(1);
  return row ? { ...row, ranAt: row.ranAt.toISOString() } : null;
}

/** Veckans besöksplan: samma funktion, samma takt (gårdagens) och samma sortiment som Lager. */
function buildPlan(
  data: HealthData,
  health: readonly MachineHealth[],
  warehouse: { titleId: string; onHand: number }[] | null,
  slotPeriods: readonly SlotPeriod[],
  capacities: readonly SlotCapacityRow[],
  ctx: AppContext,
): VisitPlan {
  return weeklyVisitPlan({
    orders: data.orders,
    machines: data.machines.filter((m) => !m.archived),
    titles: data.titles,
    stock: data.stock,
    warehouseStock: warehouse,
    health,
    slotPeriods,
    capacities,
    today: ctx.today,
    timeZone: ctx.timeZone,
    now: new Date(ctx.now),
  });
}

/** Översikten på /drift: hälsa per automat, larm, senaste körning och veckans besök. */
export async function loadDriftOverview(ctx: AppContext): Promise<DriftOverview> {
  const now = new Date(ctx.now);
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const data = await loadHealthData(tx, orgId, ctx.today, new Date(ctx.now));
    const health = healthOf(data, ctx.timeZone, now);
    const alerts = await loadAlerts(tx, orgId, now);
    const lastRun = ctx.canSeeEconomy ? await loadLastRun(tx, orgId) : null;
    const stockRows = await queryStock(tx, orgId);
    const warehouse = ownStockTotals(stockRows);
    const slotPeriods = await querySlotPeriods(tx, orgId);
    const capacities = await querySlotCapacities(tx, orgId, now);
    const plan = buildPlan(
      data,
      health,
      warehouse.length > 0 ? warehouse : null,
      slotPeriods,
      capacities,
      ctx,
    );
    return {
      data,
      health,
      openAlerts: alerts.open,
      recentAlerts: alerts.recent,
      lastRun,
      plan,
      capacities,
    };
  });
}

/** Besöksplanen (/drift/besok) med hälsan som skäl till extra besök. */
export async function loadVisitPlan(
  ctx: AppContext,
): Promise<{ data: HealthData; health: MachineHealth[]; plan: VisitPlan; hasWarehouse: boolean }> {
  const now = new Date(ctx.now);
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const data = await loadHealthData(tx, orgId, ctx.today, new Date(ctx.now));
    const health = healthOf(data, ctx.timeZone, now);
    const stockRows = await queryStock(tx, orgId);
    const warehouse = ownStockTotals(stockRows);
    const slotPeriods = await querySlotPeriods(tx, orgId);
    const capacities = await querySlotCapacities(tx, orgId, now);
    const plan = buildPlan(
      data,
      health,
      warehouse.length > 0 ? warehouse : null,
      slotPeriods,
      capacities,
      ctx,
    );
    return { data, health, plan, hasWarehouse: warehouse.length > 0 };
  });
}

export interface MachineTimelineData {
  readonly health: MachineHealth | null;
  readonly machine: HealthData["machines"][number];
  readonly entries: TimelineEntry[];
  readonly alerts: AlertView[];
  readonly from: string;
  readonly to: string;
  readonly days: number;
  /** Facken enligt Awish, en rad per titel, sorterade efter fack. Tom utan kapacitet. */
  readonly slots: MachineSlotView[];
}

/** En titel i automatens fack (Awish): fack, saldo och kapacitet. */
export interface MachineSlotView {
  readonly titleId: string;
  readonly titleName: string;
  readonly channels: readonly string[];
  readonly onHand: number;
  readonly capacity: number;
}

/** Tidslinjen för en automat de senaste `days` dagarna: försäljning, lager, ärenden, larm. */
export async function loadMachineTimeline(
  ctx: AppContext,
  machineId: string,
  days: number,
): Promise<MachineTimelineData | null> {
  const now = new Date(ctx.now);
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const data = await loadHealthData(tx, orgId, ctx.today, new Date(ctx.now));
    const machine = data.machines.find((m) => m.id === machineId);
    if (!machine) return null;
    const health = healthOf(data, ctx.timeZone, now).find((h) => h.machineId === machineId) ?? null;
    const from = new Date(now.getTime() - days * 86_400_000);

    const stockRows = await tx
      .select({
        id: s.stockEvents.id,
        titleId: s.stockEvents.titleId,
        kind: s.stockEvents.kind,
        quantity: s.stockEvents.quantity,
        occurredAt: s.stockEvents.occurredAt,
        performedBy: s.stockEvents.performedBy,
        note: s.stockEvents.note,
      })
      .from(s.stockEvents)
      .innerJoin(
        s.stockLocations,
        and(
          eq(s.stockLocations.id, s.stockEvents.locationId),
          eq(s.stockLocations.organizationId, s.stockEvents.organizationId),
        ),
      )
      .where(
        and(
          eq(s.stockEvents.organizationId, orgId),
          eq(s.stockLocations.machineId, machineId),
          ne(s.stockEvents.kind, "sale"),
          gte(s.stockEvents.occurredAt, from),
          lt(s.stockEvents.occurredAt, now),
        ),
      )
      .orderBy(asc(s.stockEvents.occurredAt));
    const stockEvents: MachineStockEvent[] = stockRows.map((r) => ({
      id: r.id,
      machineId,
      titleId: r.titleId,
      kind: r.kind,
      quantity: r.quantity,
      occurredAt: r.occurredAt.toISOString(),
      performedBy: r.performedBy,
      note: r.note,
    }));

    // Ärenden (kundärenden). Påfyllaren får inga rader (RLS).
    const incidentRows = await tx
      .select({
        id: s.incidents.id,
        kind: s.incidents.kind,
        startedAt: s.incidents.startedAt,
        endedAt: s.incidents.endedAt,
        description: s.incidents.description,
        actionTaken: s.incidents.actionTaken,
      })
      .from(s.incidents)
      .where(
        and(
          eq(s.incidents.organizationId, orgId),
          eq(s.incidents.machineId, machineId),
          or(
            gte(s.incidents.startedAt, from),
            gte(s.incidents.endedAt, from),
            isNull(s.incidents.endedAt),
          ),
        ),
      );
    const incidents: MachineIncident[] = incidentRows.map((r) => ({
      id: r.id,
      machineId,
      kind: r.kind,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      description: r.description,
      actionTaken: r.actionTaken,
    }));

    const entries = machineTimeline(
      {
        machineId,
        orders: data.orders.filter((o) => o.machineId === machineId),
        stockEvents,
        signals: data.signals.filter((x) => x.machineId === machineId),
        incidents,
        titles: data.titles.map((t) => ({ id: t.id, name: t.name })),
      },
      {
        from: from.toISOString(),
        to: now.toISOString(),
        timeZone: ctx.timeZone,
        salesGrouping: days > 7 ? "day" : "hour",
        order: "desc",
      },
    );
    const alerts = await loadAlerts(tx, orgId, new Date(now.getTime()), machineId);
    const capacities = (await querySlotCapacities(tx, orgId, now)).filter(
      (c) => c.machineId === machineId,
    );
    const titleName = new Map(data.titles.map((t) => [t.id, t.name]));
    const onHand = new Map<string, number>();
    for (const st of data.stock) {
      if (st.machineId === machineId) {
        onHand.set(st.titleId, (onHand.get(st.titleId) ?? 0) + st.onHand);
      }
    }
    const slots: MachineSlotView[] = capacities
      .map((c) => ({
        titleId: c.titleId,
        titleName: titleName.get(c.titleId) ?? "Okänd titel",
        channels: [...c.channels].sort(compareChannels),
        onHand: Math.max(0, onHand.get(c.titleId) ?? 0),
        capacity: c.capacity,
      }))
      .sort(
        (a, b) =>
          compareChannels(a.channels[0] ?? "\uffff", b.channels[0] ?? "\uffff") ||
          a.titleName.localeCompare(b.titleName, "sv"),
      );
    return {
      health,
      machine,
      entries,
      alerts: [...alerts.open, ...alerts.recent],
      from: from.toISOString(),
      to: now.toISOString(),
      days,
      slots,
    };
  });
}

// ---------------------------------------------------------------------------
// Larminställningar
// ---------------------------------------------------------------------------

export interface PushDeviceView {
  readonly id: string;
  readonly endpointHost: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastSuccessAt: string | null;
  readonly disabledAt: string | null;
  /** Hela endpoint-adressen, för att känna igen den här webbläsarens enhet. */
  readonly endpoint: string;
}

export interface DeliveryView {
  readonly id: string;
  readonly sendAt: string;
  readonly status: string;
  readonly subject: string;
  readonly items: number;
  readonly results: { channel: string; status: string; detail: string }[];
}

export interface AlertSettings {
  readonly subscription: SubscriptionRow;
  readonly saved: boolean;
  readonly devices: PushDeviceView[];
  readonly deliveries: DeliveryView[];
  readonly channels: ChannelStatus;
  readonly machines: { id: string; code: string; name: string }[];
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "okänd";
  }
}

/** Den inloggades prenumeration, push-enheter och senaste utskick. */
export async function loadAlertSettings(ctx: AppContext): Promise<AlertSettings> {
  const channels = await channelStatus();
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const userId = ctx.user.id;
    const [sub] = await tx
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
        and(
          eq(s.alertSubscriptions.organizationId, orgId),
          eq(s.alertSubscriptions.userId, userId),
        ),
      );
    const devices = await tx
      .select({
        id: s.pushSubscriptions.id,
        endpoint: s.pushSubscriptions.endpoint,
        userAgent: s.pushSubscriptions.userAgent,
        createdAt: s.pushSubscriptions.createdAt,
        lastSuccessAt: s.pushSubscriptions.lastSuccessAt,
        disabledAt: s.pushSubscriptions.disabledAt,
      })
      .from(s.pushSubscriptions)
      .where(
        and(eq(s.pushSubscriptions.organizationId, orgId), eq(s.pushSubscriptions.userId, userId)),
      )
      .orderBy(desc(s.pushSubscriptions.createdAt));
    const deliveries = await tx
      .select({
        id: s.alertDeliveries.id,
        sendAt: s.alertDeliveries.sendAt,
        status: s.alertDeliveries.status,
        subject: s.alertDeliveries.subject,
        items: s.alertDeliveries.items,
        results: s.alertDeliveries.results,
      })
      .from(s.alertDeliveries)
      .where(and(eq(s.alertDeliveries.organizationId, orgId), eq(s.alertDeliveries.userId, userId)))
      .orderBy(desc(s.alertDeliveries.sendAt))
      .limit(20);
    const machines = await tx
      .select({ id: s.machines.id, code: s.machines.code, name: s.machines.name })
      .from(s.machines)
      .where(and(eq(s.machines.organizationId, orgId), isNull(s.machines.archivedAt)))
      .orderBy(asc(s.machines.code));
    return {
      subscription: sub ?? defaultSubscription(userId, ctx.role),
      saved: Boolean(sub),
      devices: devices.map((d) => ({
        id: d.id,
        endpoint: d.endpoint,
        endpointHost: hostOf(d.endpoint),
        userAgent: d.userAgent,
        createdAt: d.createdAt.toISOString(),
        lastSuccessAt: d.lastSuccessAt ? d.lastSuccessAt.toISOString() : null,
        disabledAt: d.disabledAt ? d.disabledAt.toISOString() : null,
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        sendAt: d.sendAt.toISOString(),
        status: d.status,
        subject: d.subject,
        items: Array.isArray(d.items) ? d.items.length : 0,
        results: (Array.isArray(d.results) ? d.results : []) as DeliveryView["results"],
      })),
      channels,
      machines,
    };
  });
}

/** Stamdata och lager för påfyllningsformuläret (alla roller som fyller på). */
export async function loadRefillData(ctx: AppContext) {
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const data = await loadHealthData(tx, orgId, ctx.today, new Date(ctx.now));
    const stockRows = await queryStock(tx, orgId);
    const since = addDays(ctx.today, -14);
    const recent = await tx
      .select({
        clientId: s.fieldSubmissions.clientId,
        machineId: s.fieldSubmissions.machineId,
        titleId: s.fieldSubmissions.titleId,
        quantity: s.fieldSubmissions.quantity,
        occurredAt: s.fieldSubmissions.occurredAt,
        receivedAt: s.fieldSubmissions.receivedAt,
      })
      .from(s.fieldSubmissions)
      .where(
        and(
          eq(s.fieldSubmissions.organizationId, orgId),
          eq(s.fieldSubmissions.submittedBy, ctx.user.id),
          gte(s.fieldSubmissions.occurredAt, new Date(`${since}T00:00:00Z`)),
        ),
      )
      .orderBy(desc(s.fieldSubmissions.occurredAt))
      .limit(20);
    return {
      machines: data.machines
        .filter((m) => !m.archived)
        .map((m) => ({ id: m.id, code: m.code, name: m.name })),
      titles: data.titles.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name })),
      stock: stockRows
        .filter((r) => r.locationKind === "machine" && r.machineId !== null)
        .map((r) => ({ machineId: r.machineId as string, titleId: r.titleId, onHand: r.onHand })),
      warehouse: ownStockTotals(stockRows),
      sources: await queryRefillSources(tx, orgId),
      recent: recent.map((r) => ({
        ...r,
        occurredAt: r.occurredAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
      })),
    };
  });
}

export type RefillData = Awaited<ReturnType<typeof loadRefillData>>;
