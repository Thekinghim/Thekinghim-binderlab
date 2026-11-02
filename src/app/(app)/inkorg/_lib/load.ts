/**
 * Laddare för Inkorg (kundärenden). Som den inloggade med RLS; bara ägare, admin och läsare
 * får läsa ärenden (påfyllaren ser aldrig återbetalningar). Statistiken räknas av
 * @/domain/refunds (återbetalningar) och här bara som antal ärenden.
 */

import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Period } from "@/domain";
import { summarizeRefunds, type Refund, type RefundSummary } from "@/domain/refunds";
import type { AppContext } from "@/server/data/core";
import { withUserDb } from "@/server/session";

export interface IncidentRow {
  readonly id: string;
  readonly machineId: string;
  readonly kind: string;
  readonly status: "open" | "in_progress" | "resolved";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly description: string | null;
  readonly actionTaken: string | null;
  readonly orderId: string | null;
  readonly titleId: string | null;
  readonly assigneeId: string | null;
  readonly refundedOre: number;
  readonly refundedOn: string | null;
  readonly customerContact: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
}

export interface Member {
  readonly userId: string;
  readonly name: string;
}

export interface InboxData {
  readonly incidents: IncidentRow[];
  readonly machines: { id: string; code: string; name: string }[];
  readonly titles: { id: string; name: string }[];
  readonly members: Member[];
  readonly orders: Map<string, { externalId: string; amountOre: number; orderedAt: string }>;
  readonly refunds: { byMachine: RefundSummary; byTitle: RefundSummary; total: RefundSummary };
}

const incidentColumns = {
  id: s.incidents.id,
  machineId: s.incidents.machineId,
  kind: s.incidents.kind,
  status: s.incidents.status,
  startedAt: s.incidents.startedAt,
  endedAt: s.incidents.endedAt,
  description: s.incidents.description,
  actionTaken: s.incidents.actionTaken,
  orderId: s.incidents.orderId,
  titleId: s.incidents.titleId,
  assigneeId: s.incidents.assigneeId,
  refundedOre: s.incidents.refundedOre,
  refundedOn: s.incidents.refundedOn,
  customerContact: s.incidents.customerContact,
  createdAt: s.incidents.createdAt,
  createdBy: s.incidents.createdBy,
  updatedAt: s.incidents.updatedAt,
};

interface RawIncident {
  id: string;
  machineId: string;
  kind: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  description: string | null;
  actionTaken: string | null;
  orderId: string | null;
  titleId: string | null;
  assigneeId: string | null;
  refundedOre: number;
  refundedOn: string | null;
  customerContact: string | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
}

function toRow(r: RawIncident): IncidentRow {
  return {
    ...r,
    status: (["open", "in_progress", "resolved"].includes(r.status)
      ? r.status
      : "open") as IncidentRow["status"],
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Återbetalningarna i domänens form. */
export function refundsOf(incidents: readonly IncidentRow[]): Refund[] {
  return incidents
    .filter((i) => i.refundedOre > 0 && i.refundedOn !== null)
    .map((i) => ({
      id: i.id,
      machineId: i.machineId,
      titleId: i.titleId,
      refundedOn: i.refundedOn as string,
      amountOre: i.refundedOre,
    }));
}

async function members(
  tx: Parameters<Parameters<typeof withUserDb>[0]>[0],
  orgId: string,
): Promise<Member[]> {
  const rows = await tx
    .select({ userId: s.memberships.userId, name: s.profiles.displayName })
    .from(s.memberships)
    .leftJoin(
      s.profiles,
      and(
        eq(s.profiles.organizationId, s.memberships.organizationId),
        eq(s.profiles.userId, s.memberships.userId),
      ),
    )
    .where(eq(s.memberships.organizationId, orgId));
  return rows
    .filter((r) => r.userId)
    .map((r) => ({ userId: r.userId as string, name: r.name ?? "Medlem utan namn" }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/**
 * Ärenden som är öppna eller rör perioden (startade, lösta eller återbetalda i perioden),
 * stamdata och återbetalningarna i perioden per automat och titel.
 */
export async function loadInbox(ctx: AppContext, period: Period): Promise<InboxData> {
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const from = new Date(`${period.start}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${period.end}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 2);
    const raw = await tx
      .select(incidentColumns)
      .from(s.incidents)
      .where(
        and(
          eq(s.incidents.organizationId, orgId),
          or(
            inArray(s.incidents.status, ["open", "in_progress"]),
            and(gte(s.incidents.startedAt, from), lte(s.incidents.startedAt, to)),
            and(gte(s.incidents.endedAt, from), lte(s.incidents.endedAt, to)),
            and(gte(s.incidents.refundedOn, period.start), lte(s.incidents.refundedOn, period.end)),
          ),
        ),
      )
      .orderBy(desc(s.incidents.startedAt))
      .limit(1000);
    const incidents = raw.map(toRow);
    const machines = await tx
      .select({ id: s.machines.id, code: s.machines.code, name: s.machines.name })
      .from(s.machines)
      .where(eq(s.machines.organizationId, orgId))
      .orderBy(asc(s.machines.code));
    const titles = await tx
      .select({ id: s.titles.id, name: s.titles.name })
      .from(s.titles)
      .where(and(eq(s.titles.organizationId, orgId), isNull(s.titles.mergedIntoId)))
      .orderBy(asc(s.titles.name));
    const orderIds = [...new Set(incidents.map((i) => i.orderId).filter((x): x is string => !!x))];
    const orderRows = orderIds.length
      ? await tx
          .select({
            id: s.orders.id,
            externalId: s.orders.externalId,
            amountOre: s.orders.amountOre,
            orderedAt: s.orders.orderedAt,
          })
          .from(s.orders)
          .where(and(eq(s.orders.organizationId, orgId), inArray(s.orders.id, orderIds)))
      : [];
    const refunds = refundsOf(incidents);
    return {
      incidents,
      machines,
      titles,
      members: await members(tx, orgId),
      orders: new Map(
        orderRows.map((o) => [
          o.id,
          {
            externalId: o.externalId,
            amountOre: o.amountOre,
            orderedAt: o.orderedAt.toISOString(),
          },
        ]),
      ),
      refunds: {
        byMachine: summarizeRefunds(refunds, period, "machine"),
        byTitle: summarizeRefunds(refunds, period, "title"),
        total: summarizeRefunds(refunds, period, "total"),
      },
    };
  });
}

export interface IncidentDetail {
  readonly incident: IncidentRow | null;
  readonly machines: { id: string; code: string; name: string }[];
  readonly titles: { id: string; name: string }[];
  readonly members: Member[];
  readonly order: {
    id: string;
    externalId: string;
    amountOre: number;
    orderedAt: string;
    titleId: string | null;
  } | null;
  readonly history: { at: string; action: string; actor: string | null }[];
}

/** Ett ärende (eller tomt för ett nytt) med stamdata och ändringshistorik. */
export async function loadIncident(ctx: AppContext, id: string | null): Promise<IncidentDetail> {
  return withUserDb(async (tx) => {
    const orgId = ctx.organization.id;
    const [raw] = id
      ? await tx
          .select(incidentColumns)
          .from(s.incidents)
          .where(and(eq(s.incidents.organizationId, orgId), eq(s.incidents.id, id)))
      : [];
    const incident = raw ? toRow(raw) : null;
    const machines = await tx
      .select({ id: s.machines.id, code: s.machines.code, name: s.machines.name })
      .from(s.machines)
      .where(and(eq(s.machines.organizationId, orgId), isNull(s.machines.archivedAt)))
      .orderBy(asc(s.machines.code));
    const titles = await tx
      .select({ id: s.titles.id, name: s.titles.name })
      .from(s.titles)
      .where(and(eq(s.titles.organizationId, orgId), isNull(s.titles.mergedIntoId)))
      .orderBy(asc(s.titles.name));
    let order: IncidentDetail["order"] = null;
    if (incident?.orderId) {
      const [o] = await tx
        .select({
          id: s.orders.id,
          externalId: s.orders.externalId,
          amountOre: s.orders.amountOre,
          orderedAt: s.orders.orderedAt,
          titleId: s.orders.titleId,
        })
        .from(s.orders)
        .where(and(eq(s.orders.organizationId, orgId), eq(s.orders.id, incident.orderId)));
      if (o) order = { ...o, orderedAt: o.orderedAt.toISOString() };
    }
    const memberList = await members(tx, orgId);
    const history = incident
      ? await tx
          .select({
            at: s.auditLog.occurredAt,
            action: s.auditLog.action,
            actor: s.auditLog.actorId,
          })
          .from(s.auditLog)
          .where(
            and(
              eq(s.auditLog.organizationId, orgId),
              eq(s.auditLog.tableName, "incidents"),
              eq(s.auditLog.rowId, incident.id),
            ),
          )
          .orderBy(desc(s.auditLog.occurredAt))
          .limit(20)
      : [];
    const names = new Map(memberList.map((m) => [m.userId, m.name]));
    return {
      incident,
      machines,
      titles,
      members: memberList,
      order,
      history: history.map((h) => ({
        at: h.at.toISOString(),
        action: h.action,
        actor: h.actor ? (names.get(h.actor) ?? "Borttagen användare") : null,
      })),
    };
  });
}
