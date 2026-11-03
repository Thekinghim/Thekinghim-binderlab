/**
 * Vem gör vad (@/analytics/team): personerna som fyller på, ansvarig per automat,
 * tilldelningar i Att göra och butikernas plats för rutten. Läses som användaren under RLS
 * (Tx från withUserDb/withUserDbFor).
 *
 * Påfyllaren ser bara sin egen profil och sitt eget medlemskap (RLS), så för henne blir
 * listan bara hon själv; andras namn visas då som "Delägaren".
 */

import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { TeamMember } from "@/analytics/team";
import type { GeoPoint } from "@/analytics/visits";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { withUserDbFor, type SessionUser } from "@/server/access";

/** Rollerna som fyller på och kan vara ansvariga (samma som private.is_refill_member). */
export const REFILL_MEMBER_ROLES = ["owner", "admin", "refiller"] as const;

/** Personerna som fyller på, efter namn. */
export async function queryTeam(tx: Tx, orgId: string): Promise<TeamMember[]> {
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
    .where(
      and(
        eq(s.memberships.organizationId, orgId),
        inArray(s.memberships.role, [...REFILL_MEMBER_ROLES]),
      ),
    );
  return rows
    .map((r) => ({ userId: r.userId, name: r.name?.trim() || "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv") || (a.userId < b.userId ? -1 : 1));
}

/** Ansvarig per automat (null = Båda), för automater som inte är arkiverade. */
export async function queryResponsibles(
  tx: Tx,
  orgId: string,
): Promise<Map<string, string | null>> {
  const rows = await tx
    .select({ id: s.machines.id, responsible: s.machines.responsibleUserId })
    .from(s.machines)
    .where(and(eq(s.machines.organizationId, orgId), isNull(s.machines.archivedAt)));
  return new Map(rows.map((r) => [r.id, r.responsible]));
}

/**
 * Uttryckliga tilldelningar i Att göra: nyckel → person (null = Båda). RLS: påfyllaren bara
 * lagerpunkter.
 */
export async function queryTodoAssignments(
  tx: Tx,
  orgId: string,
): Promise<Map<string, string | null>> {
  const rows = await tx
    .select({ key: s.todoAssignments.todoKey, to: s.todoAssignments.assignedTo })
    .from(s.todoAssignments)
    .where(eq(s.todoAssignments.organizationId, orgId));
  return new Map(rows.map((r) => [r.key, r.to]));
}

/** En butiks namn, adress och plats. */
export interface StorePlace {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly location: GeoPoint | null;
}

/** Butikernas adress och plats (alla roller som ser butiker). */
export async function queryStorePlaces(tx: Tx, orgId: string): Promise<Map<string, StorePlace>> {
  const rows = await tx
    .select({
      id: s.stores.id,
      name: s.stores.name,
      address: s.stores.address,
      city: s.stores.city,
      lat: s.stores.latitude,
      lng: s.stores.longitude,
    })
    .from(s.stores)
    .where(eq(s.stores.organizationId, orgId));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        address: r.address,
        city: r.city,
        location: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
      },
    ]),
  );
}

/** Personerna, ansvarig per automat och tilldelningarna, för Att göra. */
export interface TeamState {
  readonly team: TeamMember[];
  readonly responsibles: Map<string, string | null>;
  readonly assignments: Map<string, string | null>;
}

export async function loadTeamStateFor(user: SessionUser, orgId: string): Promise<TeamState> {
  return withUserDbFor(user, async (tx) => {
    const [team, responsibles, assignments] = await Promise.all([
      queryTeam(tx, orgId),
      queryResponsibles(tx, orgId),
      queryTodoAssignments(tx, orgId),
    ]);
    return { team, responsibles, assignments };
  });
}
