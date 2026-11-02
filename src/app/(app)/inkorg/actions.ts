"use server";

/**
 * Server actions för Inkorg (kundärenden). Ägare och admin skriver; rollen kontrolleras mot
 * databasen (requireContextRole) och allt skrivs som användaren med RLS (withUserDb).
 * Databasen kontrollerar dessutom att ordern hör till automaten, att den ansvariga är medlem
 * och att en återbetalning inte ändras i en stängd månad (BL004).
 */

import { revalidatePath } from "next/cache";
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { z } from "zod";

import * as s from "@/db/schema";
import { OPERATOR_ROLES, requireContextRole } from "@/server/data/core";
import { withUserDb } from "@/server/session";

import {
  localToUtc,
  validateIncident,
  type IncidentErrors,
  type IncidentInput,
} from "./_lib/model";

const uuid = z.string().uuid();

function dbMessage(error: unknown): string | null {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = e?.cause?.code ?? e?.code;
  const message = e?.cause?.message ?? e?.message;
  if (code === "BL004" || code === "BL020" || code === "22023") return message ?? null;
  return null;
}

export interface SaveIncidentResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly errors?: IncidentErrors;
}

/** Skapar eller uppdaterar ett ärende. */
export async function saveIncident(input: IncidentInput): Promise<SaveIncidentResult> {
  const ctx = await requireContextRole(OPERATOR_ROLES);
  const orgId = ctx.organization.id;
  if (input.id && !uuid.safeParse(input.id).success)
    return { ok: false, errors: { form: "Okänt ärende." } };
  const { machineIds, memberIds } = await withUserDb(async (tx) => {
    const m = await tx
      .select({ id: s.machines.id })
      .from(s.machines)
      .where(eq(s.machines.organizationId, orgId));
    const u = await tx
      .select({ id: s.memberships.userId })
      .from(s.memberships)
      .where(eq(s.memberships.organizationId, orgId));
    return {
      machineIds: m.map((x) => x.id),
      memberIds: u.map((x) => x.id).filter((x): x is string => !!x),
    };
  });
  const result = validateIncident(input, {
    timeZone: ctx.timeZone,
    now: new Date(ctx.now),
    machineIds,
    memberIds,
  });
  if (!result.ok) return { ok: false, errors: result.errors };
  const v = result.values;
  const values = {
    machineId: v.machineId,
    kind: v.kind,
    startedAt: v.startedAt,
    orderId: v.orderId,
    titleId: v.titleId,
    description: v.description,
    customerContact: v.customerContact,
    status: v.status,
    assigneeId: v.assigneeId,
    actionTaken: v.actionTaken,
    refundedOre: v.refundedOre,
    refundedOn: v.refundedOn,
  };
  try {
    const id = await withUserDb(async (tx) => {
      if (input.id) {
        const [prev] = await tx
          .select({ status: s.incidents.status, endedAt: s.incidents.endedAt })
          .from(s.incidents)
          .where(and(eq(s.incidents.organizationId, orgId), eq(s.incidents.id, input.id)));
        if (!prev) return null;
        const endedAt = v.status === "resolved" ? (prev.endedAt ?? new Date()) : null;
        const [row] = await tx
          .update(s.incidents)
          .set({ ...values, endedAt })
          .where(and(eq(s.incidents.organizationId, orgId), eq(s.incidents.id, input.id)))
          .returning({ id: s.incidents.id });
        return row?.id ?? null;
      }
      const [row] = await tx
        .insert(s.incidents)
        .values({
          organizationId: orgId,
          ...values,
          endedAt: v.status === "resolved" ? new Date() : null,
        })
        .returning({ id: s.incidents.id });
      return row?.id ?? null;
    });
    if (!id) return { ok: false, errors: { form: "Ärendet finns inte." } };
    revalidatePath("/inkorg", "layout");
    revalidatePath("/drift", "layout");
    return { ok: true, id };
  } catch (error) {
    return {
      ok: false,
      errors: { form: dbMessage(error) ?? "Ärendet kunde inte sparas. Försök igen." },
    };
  }
}

export interface OrderCandidate {
  readonly id: string;
  readonly externalId: string;
  readonly orderedAt: string;
  readonly amountOre: number;
  readonly titleId: string | null;
  readonly titleName: string | null;
}

/** Order i automaten inom två timmar från tidpunkten (för att koppla ärendet till rätt order). */
export async function findOrders(machineId: string, occurredAt: string): Promise<OrderCandidate[]> {
  const ctx = await requireContextRole(OPERATOR_ROLES);
  if (!uuid.safeParse(machineId).success) return [];
  const at = localToUtc(occurredAt, ctx.timeZone);
  if (!at) return [];
  const from = new Date(at.getTime() - 2 * 3_600_000);
  const to = new Date(at.getTime() + 2 * 3_600_000);
  const rows = await withUserDb((tx) =>
    tx
      .select({
        id: s.orders.id,
        externalId: s.orders.externalId,
        orderedAt: s.orders.orderedAt,
        amountOre: s.orders.amountOre,
        titleId: s.orders.titleId,
        titleName: s.titles.name,
      })
      .from(s.orders)
      .leftJoin(
        s.titles,
        and(
          eq(s.titles.organizationId, s.orders.organizationId),
          eq(s.titles.id, s.orders.titleId),
        ),
      )
      .where(
        and(
          eq(s.orders.organizationId, ctx.organization.id),
          eq(s.orders.machineId, machineId),
          gte(s.orders.orderedAt, from),
          lte(s.orders.orderedAt, to),
          isNull(s.titles.mergedIntoId),
        ),
      )
      .orderBy(asc(s.orders.orderedAt))
      .limit(50),
  );
  return rows
    .map((r) => ({ ...r, orderedAt: r.orderedAt.toISOString() }))
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.orderedAt) - at.getTime()) -
        Math.abs(Date.parse(b.orderedAt) - at.getTime()),
    );
}
