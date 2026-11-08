/**
 * Enkel vy: försök att ta sig ur den med delägarens egen session (som Supabase-klienten
 * skulle göra, under RLS). Rollen är kvar (ägare), men vyn ska aldrig gå att slå av själv,
 * hur raden än skrivs: upsert, radera och lägga till sig igen.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

async function viewOf(orgId: string, user: TestUser): Promise<string | null> {
  const rows = Array.from(
    await db().execute(
      sql`select view_mode from public.memberships
          where organization_id = ${orgId} and user_id = ${user.id}`,
    ),
  ) as Array<{ view_mode: string }>;
  return rows[0]?.view_mode ?? null;
}

async function simplePartner() {
  const owner = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, "Utbrytning");
  const partner = await createMember(orgId, "owner");
  const m = await one<{ id: string }>(
    db(),
    sql`select id from public.memberships where organization_id = ${orgId} and user_id = ${partner.id}`,
  );
  await asUser(owner, (tx) =>
    tx.execute(sql`update public.memberships set view_mode = 'simple' where id = ${m.id}::uuid`),
  );
  expect(await viewOf(orgId, partner)).toBe("simple");
  return { orgId, owner, partner };
}

describe("Enkel vy går inte att ta sig ur med den egna sessionen", () => {
  it("upsert på det egna medlemskapet (on conflict do update) nekas (BL130)", async () => {
    const f = await simplePartner();
    const outcome = await asUser(f.partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.memberships (organization_id, user_id, role, view_mode)
              values (${f.orgId}::uuid, ${f.partner.id}::uuid, 'owner', 'full')
              on conflict (organization_id, user_id) do update set view_mode = excluded.view_mode`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(await viewOf(f.orgId, f.partner)).toBe("simple");
  });

  it("radera sig själv och lägga till sig igen i full vy går inte", async () => {
    const f = await simplePartner();
    const outcome = await asUser(f.partner, (tx) =>
      attempt(tx, async (sp) => {
        await sp.execute(
          sql`delete from public.memberships
              where organization_id = ${f.orgId}::uuid and user_id = ${f.partner.id}::uuid`,
        );
        return sp.execute(
          sql`insert into public.memberships (organization_id, user_id, role, view_mode)
              values (${f.orgId}::uuid, ${f.partner.id}::uuid, 'owner', 'full')`,
        );
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(await viewOf(f.orgId, f.partner)).toBe("simple");
  });

  it("vyn går inte att ändra via set_invitation_options eller en egen inbjudan", async () => {
    const f = await simplePartner();
    const outcome = await asUser(f.partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.set_invitation_options(${f.orgId}::uuid, gen_random_uuid(), 'full', 'en')`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});
