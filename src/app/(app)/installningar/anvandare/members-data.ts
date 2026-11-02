/**
 * Data och ändringar för Inställningar → Användare, utan beroende på Next
 * (användaren skickas in). Testas mot testdatabasen i
 * test/db/anvandare-members.test.ts; actions.ts kopplar ihop dem med sessionen.
 *
 * Allt körs som användaren under RLS (withUserDbFor) efter en rollkontroll mot
 * databasen (requireRoleFor). Databasen har sista ordet: RLS på memberships
 * och invitations, BL005 (minst en ägare) och BL006 (admin rör inte ägare).
 * Varje ändring loggas i audit_log av triggarna.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { MemberRole } from "@/db/schema";
import {
  AuthorizationError,
  MEMBER_ROLES,
  requireRoleFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import {
  LAST_OWNER_REASON,
  OWNER_ONLY_REASON,
  isMemberRole,
  type InvitationRow,
  type MemberRow,
} from "./model";

export const MEMBER_MESSAGES = {
  forbidden: "Bara ägare och admin kan ändra användare.",
  invalid: "Uppgifterna stämmer inte. Ladda om sidan och försök igen.",
  memberMissing: "Personen är inte längre medlem. Ladda om sidan.",
  invitationMissing: "Inbjudan finns inte längre. Ladda om sidan.",
  ownerOnly: OWNER_ONLY_REASON,
  ownerInviteOnly: "Bara en ägare kan återkalla eller skicka om en ägarinbjudan.",
  lastOwnerRemove: "Sista ägaren kan inte tas bort. Gör någon annan till ägare först.",
  lastOwnerRole: LAST_OWNER_REASON,
  sameRole: "Personen har redan den rollen.",
} as const;

export interface MembersPageData {
  role: MemberRole;
  members: MemberRow[];
  invitations: InvitationRow[];
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * Medlemmar (med e-post, via list_members) och obesvarade inbjudningar som
 * inte gått ut. Bara ägare och admin; kastar AuthorizationError annars.
 */
export async function loadMembersPageFor(
  user: SessionUser,
  organizationId: string,
): Promise<MembersPageData> {
  const role = await requireRoleFor(user, organizationId, ["owner", "admin"]);
  return withUserDbFor(user, async (tx) => {
    const memberRows = Array.from(
      await tx.execute(sql`select * from public.list_members(${organizationId}::uuid)`),
    ) as Record<string, unknown>[];
    const inviteRows = Array.from(
      await tx.execute(
        sql`select i.id, i.email::text as email, i.role::text as role, i.created_at,
                   i.expires_at, i.invited_by
            from public.invitations i
            where i.organization_id = ${organizationId}::uuid
              and i.accepted_at is null and i.expires_at > now()
            order by i.created_at desc`,
      ),
    ) as Record<string, unknown>[];
    const members = memberRows.flatMap((r): MemberRow[] =>
      isMemberRole(r.role)
        ? [
            {
              membershipId: String(r.membership_id),
              userId: String(r.user_id),
              email: String(r.email),
              displayName: typeof r.display_name === "string" ? r.display_name : null,
              role: r.role,
              createdAt: iso(r.created_at),
            },
          ]
        : [],
    );
    const invitations = inviteRows.flatMap((r): InvitationRow[] =>
      isMemberRole(r.role)
        ? [
            {
              id: String(r.id),
              email: String(r.email),
              role: r.role,
              createdAt: iso(r.created_at),
              expiresAt: iso(r.expires_at),
              invitedBy: typeof r.invited_by === "string" ? r.invited_by : null,
            },
          ]
        : [],
    );
    return { role, members, invitations };
  });
}

async function authorize(
  user: SessionUser | null,
  organizationId: string,
): Promise<MemberRole | ActionResult> {
  if (!user) return { ok: false, error: "Du är inte inloggad." };
  try {
    return await requireRoleFor(user, organizationId, ["owner", "admin"]);
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: MEMBER_MESSAGES.forbidden };
    throw error;
  }
}

function isRole(value: MemberRole | ActionResult): value is MemberRole {
  return typeof value === "string";
}

/** BL005 → ett meddelande som säger vad man gör i stället. */
function memberWriteError(error: unknown, lastOwner: string): string {
  const pg = pgErrorOf(error);
  if (pg?.code === "BL005") return lastOwner;
  if (pg?.code === "BL006") return MEMBER_MESSAGES.ownerOnly;
  return dbErrorMessage(error);
}

const changeRoleInput = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
  role: z.enum(MEMBER_ROLES),
});

/** Byter en medlems roll. Returnerar om det var den egna rollen. */
export async function changeMemberRoleFlow(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult<{ self: boolean }>> {
  const parsed = changeRoleInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: MEMBER_MESSAGES.invalid };
  const { organizationId, membershipId, role } = parsed.data;
  const actor = await authorize(user, organizationId);
  if (!isRole(actor)) return { ok: false, error: actor.error ?? MEMBER_MESSAGES.forbidden };
  const sessionUser = user as SessionUser;
  try {
    return await withUserDbFor(sessionUser, async (tx) => {
      const target = Array.from(
        await tx.execute(
          sql`select m.role::text as role, m.user_id from public.memberships m
              where m.id = ${membershipId}::uuid and m.organization_id = ${organizationId}::uuid`,
        ),
      )[0] as { role: string; user_id: string } | undefined;
      if (!target) return { ok: false, error: MEMBER_MESSAGES.memberMissing };
      if (target.role === role) return { ok: false, error: MEMBER_MESSAGES.sameRole };
      if (actor !== "owner" && (target.role === "owner" || role === "owner")) {
        return { ok: false, error: MEMBER_MESSAGES.ownerOnly };
      }
      const updated = Array.from(
        await tx.execute(
          sql`update public.memberships set role = ${role}::public.member_role
              where id = ${membershipId}::uuid and organization_id = ${organizationId}::uuid
              returning id`,
        ),
      );
      if (updated.length === 0) return { ok: false, error: MEMBER_MESSAGES.memberMissing };
      return { ok: true, data: { self: target.user_id === sessionUser.userId } };
    });
  } catch (error) {
    return { ok: false, error: memberWriteError(error, MEMBER_MESSAGES.lastOwnerRole) };
  }
}

const removeInput = z.object({ organizationId: z.uuid(), membershipId: z.uuid() });

/** Tar bort ett medlemskap. Returnerar om det var det egna. */
export async function removeMemberFlow(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult<{ self: boolean }>> {
  const parsed = removeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: MEMBER_MESSAGES.invalid };
  const { organizationId, membershipId } = parsed.data;
  const actor = await authorize(user, organizationId);
  if (!isRole(actor)) return { ok: false, error: actor.error ?? MEMBER_MESSAGES.forbidden };
  const sessionUser = user as SessionUser;
  try {
    return await withUserDbFor(sessionUser, async (tx) => {
      const target = Array.from(
        await tx.execute(
          sql`select m.role::text as role, m.user_id from public.memberships m
              where m.id = ${membershipId}::uuid and m.organization_id = ${organizationId}::uuid`,
        ),
      )[0] as { role: string; user_id: string } | undefined;
      if (!target) return { ok: false, error: MEMBER_MESSAGES.memberMissing };
      if (actor !== "owner" && target.role === "owner") {
        return { ok: false, error: MEMBER_MESSAGES.ownerOnly };
      }
      const deleted = Array.from(
        await tx.execute(
          sql`delete from public.memberships
              where id = ${membershipId}::uuid and organization_id = ${organizationId}::uuid
              returning id`,
        ),
      );
      if (deleted.length === 0) return { ok: false, error: MEMBER_MESSAGES.memberMissing };
      return { ok: true, data: { self: target.user_id === sessionUser.userId } };
    });
  } catch (error) {
    return { ok: false, error: memberWriteError(error, MEMBER_MESSAGES.lastOwnerRemove) };
  }
}

const invitationInput = z.object({ organizationId: z.uuid(), invitationId: z.uuid() });

/** En obesvarad inbjudan som användaren får återkalla eller skicka om. */
export async function findManageableInvitationFor(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult<{ email: string; role: MemberRole; organizationId: string }>> {
  const parsed = invitationInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: MEMBER_MESSAGES.invalid };
  const { organizationId, invitationId } = parsed.data;
  const actor = await authorize(user, organizationId);
  if (!isRole(actor)) return { ok: false, error: actor.error ?? MEMBER_MESSAGES.forbidden };
  const row = await withUserDbFor(
    user as SessionUser,
    async (tx) =>
      Array.from(
        await tx.execute(
          sql`select i.email::text as email, i.role::text as role from public.invitations i
            where i.id = ${invitationId}::uuid and i.organization_id = ${organizationId}::uuid
              and i.accepted_at is null`,
        ),
      )[0],
  );
  const invitation = row as { email: string; role: string } | undefined;
  if (!invitation || !isMemberRole(invitation.role)) {
    return { ok: false, error: MEMBER_MESSAGES.invitationMissing };
  }
  if (actor !== "owner" && invitation.role === "owner") {
    return { ok: false, error: MEMBER_MESSAGES.ownerInviteOnly };
  }
  return { ok: true, data: { email: invitation.email, role: invitation.role, organizationId } };
}

/** Återkallar en obesvarad inbjudan (raderas; länken slutar gälla direkt). */
export async function revokeInvitationFlow(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult> {
  const found = await findManageableInvitationFor(user, raw);
  if (!found.ok) return found;
  const { invitationId } = invitationInput.parse(raw);
  try {
    const deleted = await withUserDbFor(user as SessionUser, async (tx) =>
      Array.from(
        await tx.execute(
          sql`delete from public.invitations
              where id = ${invitationId}::uuid and organization_id = ${found.data!.organizationId}::uuid
                and accepted_at is null
              returning id`,
        ),
      ),
    );
    return deleted.length > 0
      ? { ok: true }
      : { ok: false, error: MEMBER_MESSAGES.invitationMissing };
  } catch (error) {
    return { ok: false, error: dbErrorMessage(error) };
  }
}
