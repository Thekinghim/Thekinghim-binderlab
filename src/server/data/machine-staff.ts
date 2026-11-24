/**
 * Påfyllare i butiken (rollen machine_refiller): ägaren och admin skapar, ger ny PIN-kod,
 * stänger av och väljer automater på automatens sida. Testbar utan Next
 * (test/db/butikspafyllare-agare.test.ts).
 *
 * Kontot: en egen användare i Supabase Auth (e-post på .invalid, slumpat lösenord som
 * kastas: kan aldrig logga in med e-post), ett medlemskap med rollen machine_refiller,
 * en profil med namnet, automaterna i private.membership_machines och mobilnummer +
 * PIN-hash i private.phone_logins. Allt skrivs med systemrollen, efter rollkontroll mot
 * databasen; blir något fel raderas användaren igen.
 */

import "server-only";

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db/client";
import { requireRoleFor, withUserDbFor, type SessionUser } from "@/server/access";
import type { AuthProvider } from "@/server/auth/types";
import { generateStartPin, maskMobile, normalizeSwedishMobile } from "@/server/auth/phone";
import { hashPassword } from "@/server/auth/password";

export const STAFF_ADMIN_ROLES = ["owner", "admin"] as const;

export type StaffStatus = "active" | "disabled" | "locked";

export interface MachineStaffMember {
  readonly userId: string;
  readonly name: string;
  readonly phoneMasked: string;
  readonly status: StaffStatus;
  readonly lastUsedAt: string | null;
  readonly machineIds: readonly string[];
}

export interface StaffDeps {
  db: () => Db;
  provider: Pick<AuthProvider, "createSystemUser" | "deleteUser" | "setUserBanned">;
}

export type StaffResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const uuid = z.string().uuid();
const createInput = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().max(40),
  machineIds: z.array(uuid).min(1).max(50),
});

/** Automaterna finns i organisationen och är inte borttagna (som användaren, med RLS). */
async function machinesBelong(user: SessionUser, orgId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const found = await withUserDbFor(user, (tx) =>
    tx.execute(sql`select id from public.machines
      where organization_id = ${orgId}::uuid and archived_at is null
        and id = any(${`{${unique.join(",")}}`}::uuid[])`),
  );
  return Array.from(found).length === unique.length;
}

/** Påfyllarna i butiken i organisationen (för automatens sida). */
export async function listMachineStaff(
  user: SessionUser,
  orgId: string,
  db: () => Db,
): Promise<MachineStaffMember[]> {
  await requireRoleFor(user, orgId, STAFF_ADMIN_ROLES);
  const rows = Array.from(
    await db().execute(sql`
      select m.user_id, coalesce(pr.display_name, 'Påfyllare') as name, p.phone_e164,
             p.disabled_at is not null as disabled,
             (p.locked_until is not null and p.locked_until > now()) as locked,
             p.last_used_at,
             coalesce(array_agg(mm.machine_id) filter (where mm.machine_id is not null), '{}') as machine_ids
      from public.memberships m
      join private.phone_logins p on p.user_id = m.user_id
      left join public.profiles pr on pr.organization_id = m.organization_id and pr.user_id = m.user_id
      left join private.membership_machines mm on mm.organization_id = m.organization_id and mm.membership_id = m.id
      where m.organization_id = ${orgId}::uuid and m.role = 'machine_refiller'
      group by m.user_id, pr.display_name, p.phone_e164, p.disabled_at, p.locked_until, p.last_used_at, m.created_at
      order by m.created_at`),
  ) as {
    user_id: string;
    name: string;
    phone_e164: string;
    disabled: boolean;
    locked: boolean;
    last_used_at: Date | string | null;
    machine_ids: string[];
  }[];
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    phoneMasked: maskMobile(r.phone_e164),
    status: r.disabled ? "disabled" : r.locked ? "locked" : "active",
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    machineIds: r.machine_ids,
  }));
}

/** Skapar ett konto. Svarar med start-PIN:en, som bara visas en gång. */
export async function createMachineStaff(
  user: SessionUser,
  orgId: string,
  raw: unknown,
  deps: StaffDeps,
): Promise<StaffResult<{ pin: string; name: string; phone: string; userId: string }>> {
  await requireRoleFor(user, orgId, STAFF_ADMIN_ROLES);
  const parsed = createInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Skriv namn och välj minst en automat." };
  const phone = normalizeSwedishMobile(parsed.data.phone);
  if (!phone) return { ok: false, error: "Skriv ett svenskt mobilnummer, t.ex. 070-123 45 67." };
  if (!(await machinesBelong(user, orgId, parsed.data.machineIds))) {
    return { ok: false, error: "Välj automater i er organisation." };
  }
  const taken = Array.from(
    await deps
      .db()
      .execute(sql`select 1 from private.phone_logins where phone_e164 = ${phone} limit 1`),
  );
  if (taken.length > 0) return { ok: false, error: "Det finns redan ett konto med det numret." };
  if (!deps.provider.createSystemUser || !deps.provider.deleteUser) {
    return { ok: false, error: "Kontot kunde inte skapas." };
  }

  const pin = generateStartPin();
  const pinHash = await hashPassword(pin);
  const email = `tel-${randomBytes(12).toString("hex")}@binderlab.invalid`;
  const userId = await deps.provider.createSystemUser(email, parsed.data.name);
  try {
    await deps.db().transaction(async (tx) => {
      await tx.execute(sql`insert into private.phone_logins (user_id, phone_e164, pin_hash, must_change_pin)
        values (${userId}::uuid, ${phone}, ${pinHash}, true)`);
      const membership = Array.from(
        await tx.execute(sql`insert into public.memberships (organization_id, user_id, role, created_by)
          values (${orgId}::uuid, ${userId}::uuid, 'machine_refiller', ${user.userId}::uuid)
          returning id`),
      )[0] as { id: string };
      await tx.execute(sql`insert into public.profiles (organization_id, user_id, display_name)
        values (${orgId}::uuid, ${userId}::uuid, ${parsed.data.name})
        on conflict (organization_id, user_id) do update set display_name = excluded.display_name`);
      for (const machineId of new Set(parsed.data.machineIds)) {
        await tx.execute(sql`insert into private.membership_machines (organization_id, membership_id, machine_id)
          values (${orgId}::uuid, ${membership.id}::uuid, ${machineId}::uuid)`);
      }
    });
  } catch (error) {
    await deps.provider.deleteUser(userId).catch(() => {});
    if ((error as { cause?: { code?: string }; code?: string })?.cause?.code === "23505") {
      return { ok: false, error: "Det finns redan ett konto med det numret." };
    }
    throw error;
  }
  return { ok: true, pin, name: parsed.data.name, phone, userId };
}

/** Kontot måste vara en påfyllare i butiken i just den här organisationen. */
async function staffInOrg(
  db: () => Db,
  orgId: string,
  staffUserId: string,
): Promise<string | null> {
  const row = Array.from(
    await db().execute(sql`select m.id from public.memberships m
      join private.phone_logins p on p.user_id = m.user_id
      where m.organization_id = ${orgId}::uuid and m.user_id = ${staffUserId}::uuid
        and m.role = 'machine_refiller'`),
  )[0] as { id: string } | undefined;
  return row?.id ?? null;
}

/** Ny PIN-kod (visas en gång): nollställer felräkningen och låset och slår på kontot. */
export async function resetStaffPin(
  user: SessionUser,
  orgId: string,
  staffUserId: unknown,
  deps: StaffDeps,
): Promise<StaffResult<{ pin: string }>> {
  await requireRoleFor(user, orgId, STAFF_ADMIN_ROLES);
  const id = uuid.safeParse(staffUserId);
  if (!id.success || !(await staffInOrg(deps.db, orgId, id.data))) {
    return { ok: false, error: "Påfyllaren finns inte." };
  }
  const pin = generateStartPin();
  const hash = await hashPassword(pin);
  await deps.db().execute(sql`update private.phone_logins
    set pin_hash = ${hash}, must_change_pin = true, failed_attempts = 0, locked_until = null,
        disabled_at = null, last_used_at = now(), updated_at = now()
    where user_id = ${id.data}::uuid`);
  await deps.provider.setUserBanned?.(id.data, false);
  return { ok: true, pin };
}

/** Stäng av (eller slå på) kontot. Avstängt gäller direkt i databasen. */
export async function setStaffDisabled(
  user: SessionUser,
  orgId: string,
  staffUserId: unknown,
  disabled: boolean,
  deps: StaffDeps,
): Promise<StaffResult> {
  await requireRoleFor(user, orgId, STAFF_ADMIN_ROLES);
  const id = uuid.safeParse(staffUserId);
  if (!id.success || !(await staffInOrg(deps.db, orgId, id.data))) {
    return { ok: false, error: "Påfyllaren finns inte." };
  }
  await deps.db().execute(
    disabled
      ? sql`update private.phone_logins set disabled_at = now(), updated_at = now() where user_id = ${id.data}::uuid`
      : sql`update private.phone_logins set disabled_at = null, failed_attempts = 0, locked_until = null,
              last_used_at = now(), updated_at = now() where user_id = ${id.data}::uuid`,
  );
  await deps.provider.setUserBanned?.(id.data, disabled);
  return { ok: true };
}

/** Byter påfyllarens automater (systemrollen, efter rollkontroll mot databasen). */
export async function setStaffMachines(
  user: SessionUser,
  orgId: string,
  staffUserId: unknown,
  machineIds: unknown,
  db: () => Db,
): Promise<StaffResult> {
  await requireRoleFor(user, orgId, STAFF_ADMIN_ROLES);
  const id = uuid.safeParse(staffUserId);
  const ids = z.array(uuid).min(1).max(50).safeParse(machineIds);
  if (!ids.success) return { ok: false, error: "Välj minst en automat." };
  const membershipId = id.success ? await staffInOrg(db, orgId, id.data) : null;
  if (!membershipId) return { ok: false, error: "Påfyllaren finns inte." };
  if (!(await machinesBelong(user, orgId, ids.data))) {
    return { ok: false, error: "Välj automater i er organisation." };
  }
  await db().transaction(async (tx) => {
    await tx.execute(sql`delete from private.membership_machines
      where organization_id = ${orgId}::uuid and membership_id = ${membershipId}::uuid`);
    for (const machineId of new Set(ids.data)) {
      await tx.execute(sql`insert into private.membership_machines (organization_id, membership_id, machine_id)
        values (${orgId}::uuid, ${membershipId}::uuid, ${machineId}::uuid)`);
    }
  });
  return { ok: true };
}
