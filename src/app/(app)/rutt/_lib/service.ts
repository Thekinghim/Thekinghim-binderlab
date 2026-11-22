/**
 * Rutt: ändringar i dagens rutt och dagens gräns (V2, byggplanen 3.2). Utan beroende på Next
 * (användaren skickas in), så att DB-testerna kör samma kod som sidans actions.
 *
 * - Hoppa över / Till i morgon / Lägg till: en rad i route_day_changes för i dag. Har
 *   automaten redan en gällande ändring i dag ångras den först (högst en gällande per
 *   automat och dag). Ångra = undone_at (raden står kvar); med `restore` läggs den tidigare
 *   ändringen tillbaka som en ny rad.
 *   Ägare, admin och påfyllare (samma som tabellens RLS och Fyll på).
 * - Dagens gräns: organization_settings.route_max_stops/route_max_packs/route_weekdays.
 *   Ägare och admin (befintlig policy och kolumnrätt). Samma kontroller som databasen.
 *
 * Allt skrivs som användaren (RLS) och loggas av triggrarna.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

export const ROUTE_EDIT_ROLES = ["owner", "admin", "refiller"] as const;
export const ROUTE_LIMIT_ROLES = ["owner", "admin"] as const;

export type RouteChangeKind = "skip" | "add" | "later";

export const ROUTE_MESSAGES = {
  forbidden: "Bara ägare, admin och påfyllare kan ändra rutten.",
  limitsForbidden: "Bara ägare och admin kan ändra dagens gräns.",
  invalid: "Automaten finns inte.",
  notFound: "Ändringen finns inte längre.",
  stops: "Stopp per dag ska vara 1–30.",
  packs: "Pack per dag ska vara 1–5 000.",
  weekdays: "Välj minst en dag.",
  noSettings: "Inställningarna finns inte.",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly RouteChangeKind[] = ["skip", "add", "later"];

async function allowed(
  viewer: Viewer,
  roles: readonly ("owner" | "admin" | "refiller")[],
  message: string,
): Promise<ActionResult | null> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, roles);
    return null;
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: message };
    throw error;
  }
}

/**
 * Ändrar automatens plats i dagens rutt. Ger den nya radens id och den ändring som ersattes
 * (för Ångra: undoRouteChangeFor(id, replaced)).
 */
export async function changeRouteFor(
  viewer: Viewer,
  machineId: string,
  change: RouteChangeKind,
  now: Date = new Date(),
): Promise<ActionResult<{ id: string; replaced: RouteChangeKind | null }>> {
  if (!UUID.test(machineId) || !KINDS.includes(change))
    return { ok: false, error: ROUTE_MESSAGES.invalid };
  const denied = await allowed(viewer, ROUTE_EDIT_ROLES, ROUTE_MESSAGES.forbidden);
  if (denied) return denied as ActionResult<never>;
  const orgId = viewer.organization.id;
  const day = businessToday(now, viewer.organization.timezone);
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const [m] = Array.from(
        await tx.execute(
          sql`select id from public.machines
              where organization_id = ${orgId}::uuid and id = ${machineId}::uuid
                and archived_at is null`,
        ),
      );
      if (!m) return { ok: false, error: ROUTE_MESSAGES.invalid };
      const previous = Array.from(
        await tx.execute(
          sql`update public.route_day_changes set undone_at = now()
              where organization_id = ${orgId}::uuid and day = ${day}::date
                and machine_id = ${machineId}::uuid and undone_at is null
              returning change`,
        ),
      ) as { change: RouteChangeKind }[];
      const [row] = Array.from(
        await tx.execute(
          sql`insert into public.route_day_changes (organization_id, day, machine_id, change)
              values (${orgId}::uuid, ${day}::date, ${machineId}::uuid, ${change})
              returning id::text as id`,
        ),
      ) as { id: string }[];
      if (!row) return { ok: false, error: ROUTE_MESSAGES.invalid };
      return { ok: true, data: { id: row.id, replaced: previous[0]?.change ?? null } };
    });
  } catch (error) {
    if (pgErrorOf(error)?.code === "42501") return { ok: false, error: ROUTE_MESSAGES.forbidden };
    return { ok: false, error: dbErrorMessage(error) };
  }
}

/** Ångrar en ändring (undone_at). Med `restore`: den tidigare ändringen läggs tillbaka. */
export async function undoRouteChangeFor(
  viewer: Viewer,
  id: string,
  restore: RouteChangeKind | null = null,
): Promise<ActionResult> {
  if (!UUID.test(id) || (restore !== null && !KINDS.includes(restore)))
    return { ok: false, error: ROUTE_MESSAGES.notFound };
  const denied = await allowed(viewer, ROUTE_EDIT_ROLES, ROUTE_MESSAGES.forbidden);
  if (denied) return denied;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const [row] = Array.from(
        await tx.execute(
          sql`update public.route_day_changes set undone_at = now()
              where organization_id = ${orgId}::uuid and id = ${id}::uuid and undone_at is null
              returning day::text as day, machine_id::text as machine_id`,
        ),
      ) as { day: string; machine_id: string }[];
      if (!row) return { ok: false, error: ROUTE_MESSAGES.notFound };
      if (restore) {
        await tx.execute(
          sql`insert into public.route_day_changes (organization_id, day, machine_id, change)
              values (${orgId}::uuid, ${row.day}::date, ${row.machine_id}::uuid, ${restore})`,
        );
      }
      return { ok: true };
    });
  } catch (error) {
    if (pgErrorOf(error)?.code === "42501") return { ok: false, error: ROUTE_MESSAGES.forbidden };
    return { ok: false, error: dbErrorMessage(error) };
  }
}

export interface RouteLimitsInput {
  readonly maxStops: number;
  readonly maxPacks: number;
  /** 1 = måndag … 7 = söndag. */
  readonly weekdays: readonly number[];
}

/** Kontrollerar gränsen (samma som databasens check). null = giltig. */
export function routeLimitsError(input: RouteLimitsInput): string | null {
  if (!Number.isSafeInteger(input.maxStops) || input.maxStops < 1 || input.maxStops > 30)
    return ROUTE_MESSAGES.stops;
  if (!Number.isSafeInteger(input.maxPacks) || input.maxPacks < 1 || input.maxPacks > 5000)
    return ROUTE_MESSAGES.packs;
  const days = new Set(input.weekdays);
  if (days.size === 0 || [...days].some((d) => !Number.isSafeInteger(d) || d < 1 || d > 7))
    return ROUTE_MESSAGES.weekdays;
  return null;
}

/** Sparar dagens gräns (ägare och admin). */
export async function saveRouteLimitsFor(
  viewer: Viewer,
  input: RouteLimitsInput,
): Promise<ActionResult> {
  const invalid = routeLimitsError(input);
  if (invalid) return { ok: false, error: invalid };
  const denied = await allowed(viewer, ROUTE_LIMIT_ROLES, ROUTE_MESSAGES.limitsForbidden);
  if (denied) return denied;
  const orgId = viewer.organization.id;
  const days = [...new Set(input.weekdays)].sort((a, b) => a - b);
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const rows = Array.from(
        await tx.execute(
          sql`update public.organization_settings
              set route_max_stops = ${input.maxStops},
                  route_max_packs = ${input.maxPacks},
                  route_weekdays = ${`{${days.join(",")}}`}::smallint[]
              where organization_id = ${orgId}::uuid
              returning organization_id`,
        ),
      );
      return rows.length > 0 ? { ok: true } : { ok: false, error: ROUTE_MESSAGES.noSettings };
    });
  } catch (error) {
    if (pgErrorOf(error)?.code === "42501")
      return { ok: false, error: ROUTE_MESSAGES.limitsForbidden };
    return { ok: false, error: dbErrorMessage(error) };
  }
}
