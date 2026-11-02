/**
 * Inbjudningar: token visas en gång och bara hashen sparas; accept_invitation
 * är atomisk och kontrollerar e-post, giltighet och att den inte använts.
 */

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  asUser,
  attempt,
  createMember,
  createUser,
  db,
  one,
  rows,
  seedTenantFixture,
  uniqueSuffix,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;

beforeAll(async () => {
  F = await seedTenantFixture();
});

async function invite(by: TestUser, email: string, role = "viewer"): Promise<string> {
  const { token } = await asUser(by, (tx) =>
    one<{ token: string }>(
      tx,
      sql`select public.create_invitation(${F.orgId}, ${email}, ${role}::public.member_role) as token`,
    ),
  );
  return token;
}

async function accept(user: TestUser, token: string) {
  return asUser(user, (tx) =>
    attempt(tx, (sp) => one<{ org: string }>(sp, sql`select public.accept_invitation(${token}) as org`)),
  );
}

describe("inbjudningar", () => {
  it("token returneras en gång och bara sha256-hashen sparas", async () => {
    const email = `ny-${uniqueSuffix()}@test.binderlab.se`;
    const token = await invite(F.owner, email);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await one<{ token_hash: string }>(
      db(),
      sql`select token_hash from public.invitations where organization_id = ${F.orgId} and email = ${email}`,
    );
    expect(stored.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    const plain = await rows(db(), sql`select 1 from public.invitations where token_hash = ${token}`);
    expect(plain).toHaveLength(0);
  });

  it("rätt e-post skapar medlemskap med rätt roll, och profil", async () => {
    const user = await createUser(`Refill-${uniqueSuffix()}@Test.Binderlab.se`);
    const token = await invite(F.owner, user.email.toLowerCase(), "refiller");
    const outcome = await accept(user, token);
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.org).toBe(F.orgId);
    const membership = await one<{ role: string }>(
      db(),
      sql`select role from public.memberships where organization_id = ${F.orgId} and user_id = ${user.id}`,
    );
    expect(membership.role).toBe("refiller");
    const invitation = await one<{ accepted_by: string; accepted_at: Date | null }>(
      db(),
      sql`select accepted_by, accepted_at from public.invitations
          where organization_id = ${F.orgId} and lower(email::text) = lower(${user.email})`,
    );
    expect(invitation.accepted_by).toBe(user.id);
    expect(invitation.accepted_at).not.toBeNull();
    const profiles = await rows(
      db(),
      sql`select 1 from public.profiles where organization_id = ${F.orgId} and user_id = ${user.id}`,
    );
    expect(profiles).toHaveLength(1);
  });

  it("fel e-post nekas och förbrukar inte inbjudan", async () => {
    const invited = await createUser();
    const intruder = await createUser();
    const token = await invite(F.owner, invited.email);
    const wrong = await accept(intruder, token);
    expect(wrong.code).toBe("BL013");
    const right = await accept(invited, token);
    expect(right.ok).toBe(true);
  });

  it("återanvändning nekas", async () => {
    const user = await createUser();
    const token = await invite(F.owner, user.email);
    expect((await accept(user, token)).ok).toBe(true);
    const again = await accept(user, token);
    expect(again.code).toBe("BL011");
  });

  it("utgången inbjudan nekas", async () => {
    const user = await createUser();
    const token = await invite(F.owner, user.email);
    await db().execute(
      sql`update public.invitations set expires_at = now() - interval '1 minute'
          where organization_id = ${F.orgId} and email = ${user.email}`,
    );
    const outcome = await accept(user, token);
    expect(outcome.code).toBe("BL012");
  });

  it("en ny inbjudan till samma adress gör den gamla ogiltig", async () => {
    const user = await createUser();
    const first = await invite(F.owner, user.email);
    const second = await invite(F.owner, user.email, "admin");
    expect((await accept(user, first)).code).toBe("BL012");
    expect((await accept(user, second)).ok).toBe(true);
  });

  it("okänd token nekas", async () => {
    const user = await createUser();
    const outcome = await accept(user, "0".repeat(64));
    expect(outcome.code).toBe("BL010");
  });

  it("den som redan är medlem kan inte bjudas in", async () => {
    const member = await createMember(F.orgId, "viewer");
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.create_invitation(${F.orgId}, ${member.email}, 'admin')`),
      ),
    );
    expect(outcome.code).toBe("BL014");
  });

  it("påfyllare och läsare kan inte bjuda in, och ser inga inbjudningar", async () => {
    for (const role of ["refiller", "viewer"] as const) {
      const member = await createMember(F.orgId, role);
      const outcome = await asUser(member, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select public.create_invitation(${F.orgId}, 'x@test.binderlab.se', 'viewer')`)),
      );
      expect(outcome.code).toBe("42501");
      const visible = await asUser(member, (tx) =>
        one<{ n: number }>(tx, sql`select count(*)::int as n from public.invitations`),
      );
      expect(visible.n).toBe(0);
    }
  });

  it("en inbjudan kan inte skapas eller ändras direkt i tabellen", async () => {
    const insert = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.invitations (organization_id, email, role, token_hash, expires_at)
                       values (${F.orgId}, 'x@test.binderlab.se', 'owner', ${"b".repeat(64)}, now() + interval '1 day')`),
      ),
    );
    expect(insert.code).toBe("42501");
    const update = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`update public.invitations set role = 'owner' where organization_id = ${F.orgId}`)),
    );
    expect(update.code).toBe("42501");
  });
});
