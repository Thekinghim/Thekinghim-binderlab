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

function viewModeOf(value: unknown): "full" | "simple" {
  return value === "simple" ? "simple" : "full";
}

function localeOf(value: unknown): "sv" | "en" {
  return value === "en" ? "en" : "sv";
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
    const viewRows = Array.from(
      await tx.execute(
        sql`select m.id as membership_id, m.view_mode, coalesce(p.locale, 'sv') as locale
            from public.memberships m
            left join public.profiles p
              on p.organization_id = m.organization_id and p.user_id = m.user_id
            where m.organization_id = ${organizationId}::uuid`,
      ),
    ) as Record<string, unknown>[];
    const views = new Map(viewRows.map((r) => [String(r.membership_id), r]));
    const inviteRows = Array.from(
      await tx.execute(
        sql`select i.id, i.email::text as email, i.role::text as role, i.created_at,
                   i.expires_at, i.invited_by, i.view_mode, i.locale
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
              viewMode: viewModeOf(views.get(String(r.membership_id))?.view_mode),
              locale: localeOf(views.get(String(r.membership_id))?.locale),
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
              viewMode: viewModeOf(r.view_mode),
              locale: localeOf(r.locale),
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
): Promise<
  ActionResult<{
    email: string;
    role: MemberRole;
    organizationId: string;
    viewMode: "full" | "simple";
    locale: "sv" | "en";
  }>
> {
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
          sql`select i.email::text as email, i.role::text as role, i.view_mode, i.locale
            from public.invitations i
            where i.id = ${invitationId}::uuid and i.organization_id = ${organizationId}::uuid
              and i.accepted_at is null`,
        ),
      )[0],
  );
  const invitation = row as
    { email: string; role: string; view_mode: unknown; locale: unknown } | undefined;
  if (!invitation || !isMemberRole(invitation.role)) {
    return { ok: false, error: MEMBER_MESSAGES.invitationMissing };
  }
  if (actor !== "owner" && invitation.role === "owner") {
    return { ok: false, error: MEMBER_MESSAGES.ownerInviteOnly };
  }
  return {
    ok: true,
    data: {
      email: invitation.email,
      role: invitation.role,
      organizationId,
      viewMode: viewModeOf(invitation.view_mode),
      locale: localeOf(invitation.locale),
    },
  };
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

// ---------------------------------------------------------------------------
// Enkel vy och språk
// ---------------------------------------------------------------------------

const viewInput = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
  viewMode: z.enum(["full", "simple"]),
});

/** BL130/BL131 och RLS → ett meddelande som säger vad man gör i stället. */
function viewWriteError(error: unknown): string {
  const pg = pgErrorOf(error);
  if ((pg?.code === "BL130" || pg?.code === "BL131") && pg.message) return pg.message;
  if (pg?.code === "42501") return MEMBER_MESSAGES.forbidden;
  return dbErrorMessage(error);
}

/**
 * Slår på eller av Enkel vy för en medlem (ägare och admin; admin aldrig för en ägare; aldrig
 * den egna, BL130). Rollen ändras inte: en delägare behåller ägarrollen i datan.
 */
export async function setMemberViewFlow(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult<{ viewMode: "full" | "simple" }>> {
  const parsed = viewInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: MEMBER_MESSAGES.invalid };
  const { organizationId, membershipId, viewMode } = parsed.data;
  const actor = await authorize(user, organizationId);
  if (!isRole(actor)) return { ok: false, error: actor.error ?? MEMBER_MESSAGES.forbidden };
  try {
    return await withUserDbFor(user as SessionUser, async (tx) => {
      const updated = Array.from(
        await tx.execute(
          sql`update public.memberships set view_mode = ${viewMode}
              where id = ${membershipId}::uuid and organization_id = ${organizationId}::uuid
              returning id`,
        ),
      );
      if (updated.length === 0) return { ok: false, error: MEMBER_MESSAGES.memberMissing };
      return { ok: true, data: { viewMode } };
    });
  } catch (error) {
    return { ok: false, error: viewWriteError(error) };
  }
}

const localeInput = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
  locale: z.enum(["sv", "en"]),
});

/** Sätter språket i appen åt en medlem (ägare och admin, RLS profiles_update). */
export async function setMemberLocaleFlow(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult<{ locale: "sv" | "en" }>> {
  const parsed = localeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: MEMBER_MESSAGES.invalid };
  const { organizationId, membershipId, locale } = parsed.data;
  const actor = await authorize(user, organizationId);
  if (!isRole(actor)) return { ok: false, error: actor.error ?? MEMBER_MESSAGES.forbidden };
  try {
    return await withUserDbFor(user as SessionUser, async (tx) => {
      const target = Array.from(
        await tx.execute(
          sql`select m.user_id, m.role::text as role
              from public.memberships m
              where m.id = ${membershipId}::uuid and m.organization_id = ${organizationId}::uuid`,
        ),
      )[0] as { user_id: string; role: string } | undefined;
      if (!target) return { ok: false, error: MEMBER_MESSAGES.memberMissing };
      if (actor !== "owner" && target.role === "owner") {
        return { ok: false, error: MEMBER_MESSAGES.ownerOnly };
      }
      const updated = Array.from(
        await tx.execute(
          sql`update public.profiles set locale = ${locale}
              where organization_id = ${organizationId}::uuid and user_id = ${target.user_id}::uuid
              returning id`,
        ),
      );
      if (updated.length === 0) {
        // Ingen profil (äldre medlemskap): skapas med ett namn ur e-posten via list_members.
        const name = Array.from(
          await tx.execute(
            sql`select coalesce(nullif(split_part(email, '@', 1), ''), 'Medlem') as name
                from public.list_members(${organizationId}::uuid)
                where user_id = ${target.user_id}::uuid`,
          ),
        )[0] as { name?: string } | undefined;
        await tx.execute(
          sql`insert into public.profiles (organization_id, user_id, display_name, locale)
              values (${organizationId}::uuid, ${target.user_id}::uuid,
                      ${name?.name ?? "Medlem"}, ${locale})`,
        );
      }
      return { ok: true, data: { locale } };
    });
  } catch (error) {
    return { ok: false, error: viewWriteError(error) };
  }
}

const invitationOptionsInput = z.object({
  organizationId: z.uuid(),
  invitationId: z.uuid(),
  viewMode: z.enum(["full", "simple"]),
  locale: z.enum(["sv", "en"]),
});

/**
 * Vy och språk på en obesvarad inbjudan (RPC set_invitation_options: ägare och admin,
 * ägarinbjudningar bara en ägare). Den inbjudna landar direkt i rätt vy och språk.
 */
export async function setInvitationOptionsFlow(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult> {
  const parsed = invitationOptionsInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: MEMBER_MESSAGES.invalid };
  const { organizationId, invitationId, viewMode, locale } = parsed.data;
  const actor = await authorize(user, organizationId);
  if (!isRole(actor)) return { ok: false, error: actor.error ?? MEMBER_MESSAGES.forbidden };
  try {
    await withUserDbFor(user as SessionUser, (tx) =>
      tx.execute(
        sql`select public.set_invitation_options(${organizationId}::uuid, ${invitationId}::uuid,
                                                 ${viewMode}, ${locale})`,
      ),
    );
    return { ok: true };
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "BL010") return { ok: false, error: MEMBER_MESSAGES.invitationMissing };
    if (pg?.code === "42501") return { ok: false, error: MEMBER_MESSAGES.ownerInviteOnly };
    return { ok: false, error: dbErrorMessage(error) };
  }
}

/** Den senaste obesvarade inbjudan till adressen (efter create_invitation), eller null. */
export async function latestInvitationIdFor(
  user: SessionUser,
  organizationId: string,
  email: string,
): Promise<string | null> {
  const row = await withUserDbFor(
    user,
    async (tx) =>
      Array.from(
        await tx.execute(
          sql`select i.id from public.invitations i
              where i.organization_id = ${organizationId}::uuid
                and lower(i.email::text) = ${email.trim().toLowerCase()}
                and i.accepted_at is null and i.expires_at > now()
              order by i.created_at desc limit 1`,
        ),
      )[0] as { id?: string } | undefined,
  );
  return row?.id ? String(row.id) : null;
}
