/**
 * Ändringar från Att göra, utan beroende på Next (användaren skickas in), så att de kan
 * testas mot testdatabasen (test/db/att-gora-actions.test.ts). actions.ts kopplar dem
 * till sessionen och räknar om sidorna.
 *
 * Allt körs som användaren under RLS (withUserDbFor) efter en rollkontroll mot
 * databasen (requireRoleFor). Databasen har sista ordet: RLS på todo_dismissals
 * (påfyllaren bara lagerpunkter), register_refill och merge_titles kontrollerar
 * rollen själva, och triggarna loggar varje ändring i audit_log.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { TodoItem } from "@/analytics/todos";
import type { MemberRole } from "@/db/schema";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

export const TODO_MESSAGES = {
  forbidden: "Du har inte behörighet att ändra Att göra.",
  invalid: "Uppgifterna stämmer inte. Ladda om sidan och försök igen.",
  gone: "Punkten finns inte längre. Den kan redan vara åtgärdad. Ladda om sidan.",
  quantity: "Ange antal pack, minst 1 och högst 10 000.",
} as const;

/** Rollerna som har en Att göra-lista och får bocka av. */
const TODO_ROLES: readonly MemberRole[] = ["owner", "admin", "refiller"];
/** Rollerna som får registrera påfyllning. */
const REFILL_ROLES: readonly MemberRole[] = ["owner", "admin", "refiller"];
/** Rollerna som får slå ihop titlar. */
const MERGE_ROLES: readonly MemberRole[] = ["owner", "admin"];

const uuid = z.string().uuid();

const dismissInput = z.object({
  key: z.string().min(3).max(300),
  fingerprint: z.string().min(1).max(500),
});

const undoInput = z.object({ key: z.string().min(3).max(300) });

const refillInput = z.object({
  machineId: uuid,
  titleId: uuid,
  quantity: z.coerce.number().int().min(1).max(10_000),
  fromWarehouse: z.boolean(),
  note: z.string().max(500).optional(),
});

const mergeInput = z.object({ fromTitleId: uuid, intoTitleId: uuid });

/**
 * Felmeddelande för användaren. Våra RPC:er (register_refill, merge_titles) ger
 * svenska meddelanden med SQLSTATE 22023; övriga fel går via dbErrorMessage.
 */
function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return TODO_MESSAGES.forbidden;
  const pg = pgErrorOf(error);
  if (pg?.code === "22023" && pg.message) return pg.message;
  if (pg?.code === "42501") return TODO_MESSAGES.forbidden;
  return dbErrorMessage(error);
}

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Punkten med samma nyckel och fingerprint i användarens aktuella lista, eller undefined. */
function findTodo(todos: readonly TodoItem[], key: string, fingerprint?: string) {
  return todos.find(
    (t) => t.key === key && (fingerprint === undefined || t.fingerprint === fingerprint),
  );
}

/**
 * Bockar av en punkt. Den måste finnas i användarens lista just nu (med samma
 * fingerprint), så att bara verkliga punkter kan sparas. Samma punkt igen skriver
 * över raden. En avbockning vars orsak ändrats (nytt fingerprint) döljer inget längre,
 * och en punkt vars orsak är löst finns inte i listan; raden ligger kvar som historik.
 */
export async function dismissTodoFor(
  viewer: Viewer,
  raw: unknown,
  now: Date = new Date(),
): Promise<ActionResult<{ key: string; title: string }>> {
  const parsed = dismissInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TODO_MESSAGES.invalid };
  const { key, fingerprint } = parsed.data;
  return guard(async () => {
    await requireRoleFor(viewer.user, viewer.organization.id, TODO_ROLES);
    const item = findTodo(await loadTodosFor(viewer, now), key, fingerprint);
    if (!item) return { ok: false, error: TODO_MESSAGES.gone };
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(sql`
        insert into public.todo_dismissals (organization_id, todo_key, fingerprint, dismissed_by)
        values (${viewer.organization.id}::uuid, ${key}, ${fingerprint}, (select auth.uid()))
        on conflict (organization_id, todo_key) do update
          set fingerprint = excluded.fingerprint, dismissed_by = excluded.dismissed_by`),
    );
    return { ok: true, data: { key, title: item.title } };
  });
}

/** Ångrar en avbockning (punkten syns igen om orsaken finns kvar). */
export async function undoDismissFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const parsed = undoInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TODO_MESSAGES.invalid };
  return guard(async () => {
    await requireRoleFor(viewer.user, viewer.organization.id, TODO_ROLES);
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(sql`
        delete from public.todo_dismissals
        where organization_id = ${viewer.organization.id}::uuid and todo_key = ${parsed.data.key}`),
    );
    return { ok: true };
  });
}

/**
 * Registrerar en påfyllning (stock_events 'refill' i automaten, och uttag ur
 * centrallagret om packen tas därifrån) via RPC:n register_refill.
 */
export async function registerRefillFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ quantity: number }>> {
  const parsed = refillInput.safeParse(raw);
  if (!parsed.success) {
    const quantityIssue = parsed.error.issues.some((i) => i.path[0] === "quantity");
    return { ok: false, error: quantityIssue ? TODO_MESSAGES.quantity : TODO_MESSAGES.invalid };
  }
  const { machineId, titleId, quantity, fromWarehouse, note } = parsed.data;
  return guard(async () => {
    await requireRoleFor(viewer.user, viewer.organization.id, REFILL_ROLES);
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(sql`
        select public.register_refill(
          ${viewer.organization.id}::uuid, ${machineId}::uuid, ${titleId}::uuid,
          ${quantity}::integer, ${fromWarehouse}::boolean, null::timestamptz,
          ${note?.trim() || null}::text)`),
    );
    return { ok: true, data: { quantity } };
  });
}

/**
 * Slår ihop två titlar (merge_titles). Paret måste finnas som dubblettpunkt i listan;
 * riktningen får väljas (vilket namn som behålls). Originaldata behålls: orders.raw_title
 * och alias skrivs inte om, och den gamla titeln arkiveras med merged_into_id.
 */
export async function mergeTitlesFor(
  viewer: Viewer,
  raw: unknown,
  now: Date = new Date(),
): Promise<ActionResult<{ moved: number }>> {
  const parsed = mergeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TODO_MESSAGES.invalid };
  const { fromTitleId, intoTitleId } = parsed.data;
  if (fromTitleId === intoTitleId) return { ok: false, error: TODO_MESSAGES.invalid };
  return guard(async () => {
    await requireRoleFor(viewer.user, viewer.organization.id, MERGE_ROLES);
    const [a, b] =
      fromTitleId < intoTitleId ? [fromTitleId, intoTitleId] : [intoTitleId, fromTitleId];
    const todos = await loadTodosFor(viewer, now);
    if (!findTodo(todos, `duplicate-title:${a}:${b}`)) {
      return { ok: false, error: TODO_MESSAGES.gone };
    }
    const moved = await withUserDbFor(viewer.user, async (tx) => {
      const result = Array.from(
        await tx.execute(
          sql`select public.merge_titles(${viewer.organization.id}::uuid, ${fromTitleId}::uuid, ${intoTitleId}::uuid) as moved`,
        ),
      ) as Array<{ moved: number | string }>;
      return Number(result[0]?.moved ?? 0);
    });
    return { ok: true, data: { moved } };
  });
}
