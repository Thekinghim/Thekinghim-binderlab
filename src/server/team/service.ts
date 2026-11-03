/**
 * Vem gör vad: ansvarig per automat och tilldelning i Att göra. Utan beroende på Next
 * (användaren skickas in), så att de testas mot testdatabasen (test/db/managerpaket.test.ts).
 * Actions i src/app/(app)/_team/actions.ts kopplar dem till sessionen.
 *
 * Allt körs som användaren under RLS efter en rollkontroll. Databasen har sista ordet:
 * machines_update (ägare och admin), RLS på todo_assignments (påfyllaren bara lagerpunkter)
 * och triggarna som kräver att den ansvariga fyller på i organisationen (SQLSTATE 22023).
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { BOTH } from "@/analytics/team";
import type { MemberRole } from "@/db/schema";
import * as s from "@/db/schema";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import type { Viewer } from "@/server/data/core/loaders";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

export const TEAM_MESSAGES = {
  forbidden: "Du har inte behörighet att ändra det här.",
  invalid: "Uppgifterna stämmer inte. Ladda om sidan och försök igen.",
  machineGone: "Automaten finns inte.",
} as const;

/** Ändrar ansvarig per automat (samma som machines_update). */
const MACHINE_ROLES: readonly MemberRole[] = ["owner", "admin"];
/** Tilldelar punkter i Att göra (samma roller som bockar av). */
const TODO_ROLES: readonly MemberRole[] = ["owner", "admin", "refiller"];

const person = z.union([z.literal(BOTH), z.string().uuid()]);

const responsibleInput = z.object({ machineId: z.string().uuid(), userId: person });

const assignInput = z.object({
  key: z
    .string()
    .min(3)
    .max(300)
    .regex(/^[a-z][a-z-]*:\S+$/),
  userId: person,
});

function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return TEAM_MESSAGES.forbidden;
  const pg = pgErrorOf(error);
  if (pg?.code === "22023" && pg.message) return pg.message;
  if (pg?.code === "42501") return TEAM_MESSAGES.forbidden;
  return dbErrorMessage(error);
}

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Sätter vem som fyller på automaten ("" = Båda). */
export async function setMachineResponsibleFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ userId: string | null }>> {
  const parsed = responsibleInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TEAM_MESSAGES.invalid };
  const { machineId } = parsed.data;
  const userId = parsed.data.userId === BOTH ? null : parsed.data.userId;
  return guard(async () => {
    await requireRoleFor(viewer.user, viewer.organization.id, MACHINE_ROLES);
    const updated = await withUserDbFor(viewer.user, (tx) =>
      tx
        .update(s.machines)
        .set({ responsibleUserId: userId })
        .where(
          and(eq(s.machines.organizationId, viewer.organization.id), eq(s.machines.id, machineId)),
        )
        .returning({ id: s.machines.id }),
    );
    if (updated.length === 0) return { ok: false, error: TEAM_MESSAGES.machineGone };
    return { ok: true, data: { userId } };
  });
}

/**
 * Tilldelar en punkt i Att göra ("" = Båda, sparas uttryckligen så att den inte faller
 * tillbaka på automatens ansvariga). Samma punkt igen skriver över raden.
 */
export async function assignTodoFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ userId: string | null }>> {
  const parsed = assignInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TEAM_MESSAGES.invalid };
  const { key } = parsed.data;
  const userId = parsed.data.userId === BOTH ? null : parsed.data.userId;
  return guard(async () => {
    await requireRoleFor(viewer.user, viewer.organization.id, TODO_ROLES);
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(sql`
        insert into public.todo_assignments (organization_id, todo_key, assigned_to, assigned_by)
        values (${viewer.organization.id}::uuid, ${key}, ${userId}::uuid, (select auth.uid()))
        on conflict (organization_id, todo_key) do update
          set assigned_to = excluded.assigned_to, assigned_by = excluded.assigned_by`),
    );
    return { ok: true, data: { userId } };
  });
}
