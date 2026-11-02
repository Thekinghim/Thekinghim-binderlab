/**
 * Inställningar → Användare mot testdatabasen: list_members, laddaren och
 * flödena bakom server actions (byt roll, ta bort, återkalla inbjudan), samt
 * hela inbjudningsflödet "bjud in delägaren som läsare och logga in som hen".
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MEMBER_MESSAGES,
  changeMemberRoleFlow,
  loadMembersPageFor,
  removeMemberFlow,
  revokeInvitationFlow,
} from "../../src/app/(app)/installningar/anvandare/members-data";
import {
  OWNER_INVITE_REASON,
  inviteErrorFor,
} from "../../src/app/(app)/installningar/anvandare/model";
import { devAccountExists } from "../../src/app/inbjudan/[token]/account";
import { getServiceDb } from "../../src/db/client";
import type { MemberRole } from "../../src/db/schema";
import { AuthorizationError, getRoleFor } from "../../src/server/access";
import { DevAuthProvider } from "../../src/server/auth/dev-provider";
import { acceptInviteFlow, createInviteFlow, loginFlow } from "../../src/server/auth/flows";
import { hashPassword } from "../../src/server/auth/password";
import { MemoryCookieJar } from "../../src/server/auth/types";
import { dbErrorMessage } from "../../src/server/errors";
import { createRateLimiter } from "../../src/server/rate-limit";
import {
  asAnon,
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function membershipId(orgId: string, user: TestUser): Promise<string> {
  const row = await one<{ id: string }>(
    db(),
    sql`select id from public.memberships where organization_id = ${orgId} and user_id = ${user.id}`,
  );
  return row.id;
}

async function roleOf(orgId: string, user: TestUser): Promise<MemberRole | null> {
  return getRoleFor(session(user), orgId);
}

async function orgWith(roles: MemberRole[]) {
  const owner = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, "Användartest");
  const members: Partial<Record<MemberRole, TestUser>> = {};
  for (const role of roles) members[role] = await createMember(orgId, role);
  return { orgId, owner, ...members };
}

describe("list_members", () => {
  it("ägare och admin ser medlemmar med e-post och visningsnamn", async () => {
    const f = await orgWith(["admin", "viewer", "refiller"]);
    for (const actor of [f.owner, f.admin!]) {
      const list = await asUser(actor, (tx) =>
        rows<{ email: string; role: string; display_name: string | null }>(
          tx,
          sql`select * from public.list_members(${f.orgId}::uuid)`,
        ),
      );
      expect(list.map((m) => m.email).sort()).toEqual(
        [f.owner, f.admin!, f.viewer!, f.refiller!].map((u) => u.email).sort(),
      );
      expect(list.find((m) => m.email === f.viewer!.email)?.role).toBe("viewer");
    }
  });

  it("läsare, påfyllare och en annan organisations ägare nekas (42501)", async () => {
    const f = await orgWith(["viewer", "refiller"]);
    const other = await createUser();
    await createOrg(other, "Annan");
    for (const actor of [f.viewer!, f.refiller!, other]) {
      const outcome = await asUser(actor, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select * from public.list_members(${f.orgId}::uuid)`)),
      );
      expect(outcome.code).toBe("42501");
    }
  });

  it("anon kan inte köra den; den är security definer med tom search_path", async () => {
    const outcome = await asAnon((tx) =>
      attempt(tx, (sp) => sp.execute(sql`select * from public.list_members(gen_random_uuid())`)),
    );
    expect(outcome.code).toBe("42501");
    const fn = await one<{ definer: boolean; auth: boolean; anon: boolean; config: string[] }>(
      db(),
      sql`select p.prosecdef as definer, p.proconfig as config,
                 has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
                 has_function_privilege('anon', p.oid, 'EXECUTE') as anon
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'list_members'`,
    );
    expect(fn).toMatchObject({ definer: true, auth: true, anon: false });
    expect(fn.config).toContain('search_path=""');
  });
});

describe("loadMembersPageFor", () => {
  it("ger medlemmar och bara obesvarade, giltiga inbjudningar", async () => {
    const f = await orgWith(["viewer"]);
    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`select public.create_invitation(${f.orgId}::uuid, 'ny@test.binderlab.se', 'refiller', 7)`,
      ),
    );
    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`select public.create_invitation(${f.orgId}::uuid, 'gammal@test.binderlab.se', 'viewer', 7)`,
      ),
    );
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.invitations set expires_at = now() - interval '1 minute'
            where organization_id = ${f.orgId} and email = 'gammal@test.binderlab.se'`,
      ),
    );
    const data = await loadMembersPageFor(session(f.owner), f.orgId);
    expect(data.role).toBe("owner");
    expect(data.members).toHaveLength(2);
    expect(data.invitations.map((i) => [i.email, i.role])).toEqual([
      ["ny@test.binderlab.se", "refiller"],
    ]);
    expect(data.invitations[0]?.invitedBy).toBe(f.owner.id);
  });

  it("läsare och påfyllare får AuthorizationError", async () => {
    const f = await orgWith(["viewer", "refiller"]);
    for (const actor of [f.viewer!, f.refiller!]) {
      await expect(loadMembersPageFor(session(actor), f.orgId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
  });
});

describe("byt roll", () => {
  it("ägaren byter läsare till påfyllare; ändringen loggas i audit_log", async () => {
    const f = await orgWith(["viewer"]);
    const id = await membershipId(f.orgId, f.viewer!);
    const result = await changeMemberRoleFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: id,
      role: "refiller",
    });
    expect(result).toEqual({ ok: true, data: { self: false } });
    expect(await roleOf(f.orgId, f.viewer!)).toBe("refiller");
    const log = await rows<{ before: { role: string }; after: { role: string }; actor_id: string }>(
      db(),
      sql`select before, after, actor_id from public.audit_log
          where table_name = 'memberships' and row_id = ${id} and action = 'update'`,
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      before: { role: "viewer" },
      after: { role: "refiller" },
      actor_id: f.owner.id,
    });
  });

  it("sista ägaren kan inte byta roll", async () => {
    const f = await orgWith([]);
    const result = await changeMemberRoleFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.owner),
      role: "admin",
    });
    expect(result).toEqual({ ok: false, error: MEMBER_MESSAGES.lastOwnerRole });
    expect(await roleOf(f.orgId, f.owner)).toBe("owner");
  });

  it("admin kan varken ändra en ägare eller göra någon till ägare", async () => {
    const f = await orgWith(["admin", "viewer"]);
    const toOwner = await changeMemberRoleFlow(session(f.admin!), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.viewer!),
      role: "owner",
    });
    expect(toOwner).toEqual({ ok: false, error: MEMBER_MESSAGES.ownerOnly });
    const demote = await changeMemberRoleFlow(session(f.admin!), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.owner),
      role: "viewer",
    });
    expect(demote).toEqual({ ok: false, error: MEMBER_MESSAGES.ownerOnly });
    expect(await roleOf(f.orgId, f.owner)).toBe("owner");
    expect(await roleOf(f.orgId, f.viewer!)).toBe("viewer");
  });

  it("läsare och påfyllare nekas; en annan organisations ägare når inte medlemmen", async () => {
    const f = await orgWith(["viewer", "refiller"]);
    const target = await membershipId(f.orgId, f.refiller!);
    for (const actor of [f.viewer!, f.refiller!]) {
      const result = await changeMemberRoleFlow(session(actor), {
        organizationId: f.orgId,
        membershipId: target,
        role: "owner",
      });
      expect(result).toEqual({ ok: false, error: MEMBER_MESSAGES.forbidden });
    }
    const other = await createUser();
    const otherOrg = await createOrg(other, "Annan");
    const viaOwnOrg = await changeMemberRoleFlow(session(other), {
      organizationId: otherOrg,
      membershipId: target,
      role: "viewer",
    });
    expect(viaOwnOrg).toEqual({ ok: false, error: MEMBER_MESSAGES.memberMissing });
    const viaTheirOrg = await changeMemberRoleFlow(session(other), {
      organizationId: f.orgId,
      membershipId: target,
      role: "viewer",
    });
    expect(viaTheirOrg).toEqual({ ok: false, error: MEMBER_MESSAGES.forbidden });
    expect(await roleOf(f.orgId, f.refiller!)).toBe("refiller");
  });

  it("skräpindata ger ett fel, inget undantag", async () => {
    const f = await orgWith([]);
    for (const raw of [null, {}, { organizationId: f.orgId, membershipId: "x", role: "viewer" }]) {
      const result = await changeMemberRoleFlow(session(f.owner), raw);
      expect(result).toEqual({ ok: false, error: MEMBER_MESSAGES.invalid });
    }
    expect(
      await changeMemberRoleFlow(null, {
        organizationId: f.orgId,
        membershipId: await membershipId(f.orgId, f.owner),
        role: "viewer",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("ta bort", () => {
  it("sista ägaren kan inte tas bort, inte ens av sig själv", async () => {
    const f = await orgWith(["admin"]);
    const result = await removeMemberFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.owner),
    });
    expect(result).toEqual({ ok: false, error: MEMBER_MESSAGES.lastOwnerRemove });
    const byAdmin = await removeMemberFlow(session(f.admin!), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.owner),
    });
    expect(byAdmin).toEqual({ ok: false, error: MEMBER_MESSAGES.ownerOnly });
    expect(await roleOf(f.orgId, f.owner)).toBe("owner");
  });

  it("med två ägare kan en ägare lämna; borttagningen loggas", async () => {
    const f = await orgWith(["owner", "viewer"]);
    const viewerId = await membershipId(f.orgId, f.viewer!);
    expect(
      await removeMemberFlow(session(f.owner), { organizationId: f.orgId, membershipId: viewerId }),
    ).toEqual({ ok: true, data: { self: false } });
    expect(await roleOf(f.orgId, f.viewer!)).toBeNull();
    const selfResult = await removeMemberFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.owner),
    });
    expect(selfResult).toEqual({ ok: true, data: { self: true } });
    expect(await roleOf(f.orgId, f.owner)).toBeNull();
    const deletes = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${f.orgId} and table_name = 'memberships' and action = 'delete'`,
    );
    expect(deletes.n).toBe(2);
  });

  it("påfyllaren kan inte ta bort någon", async () => {
    const f = await orgWith(["refiller", "viewer"]);
    const result = await removeMemberFlow(session(f.refiller!), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, f.viewer!),
    });
    expect(result).toEqual({ ok: false, error: MEMBER_MESSAGES.forbidden });
    expect(await roleOf(f.orgId, f.viewer!)).toBe("viewer");
  });
});

describe("återkalla inbjudan", () => {
  async function invite(orgId: string, by: TestUser, role: MemberRole): Promise<string> {
    const email = `inbjuden-${uniqueSuffix()}@test.binderlab.se`;
    await asUser(by, (tx) =>
      tx.execute(
        sql`select public.create_invitation(${orgId}::uuid, ${email}, ${role}::public.member_role, 7)`,
      ),
    );
    return (
      await one<{ id: string }>(
        db(),
        sql`select id from public.invitations where organization_id = ${orgId} and email = ${email}`,
      )
    ).id;
  }

  it("ägaren återkallar; admin får inte återkalla en ägarinbjudan", async () => {
    const f = await orgWith(["admin"]);
    const viewerInvite = await invite(f.orgId, f.owner, "viewer");
    const ownerInvite = await invite(f.orgId, f.owner, "owner");
    expect(
      await revokeInvitationFlow(session(f.admin!), {
        organizationId: f.orgId,
        invitationId: ownerInvite,
      }),
    ).toEqual({ ok: false, error: MEMBER_MESSAGES.ownerInviteOnly });
    expect(
      await revokeInvitationFlow(session(f.owner), {
        organizationId: f.orgId,
        invitationId: viewerInvite,
      }),
    ).toEqual({ ok: true });
    const left = await rows<{ id: string }>(
      db(),
      sql`select id from public.invitations where organization_id = ${f.orgId}`,
    );
    expect(left.map((r) => r.id)).toEqual([ownerInvite]);
  });
});

describe("bjud in delägaren som läsare och logga in som hen", () => {
  const SECRET = "t".repeat(48);
  const PASSWORD = "binderlab-dev";
  let mailDir: string;

  beforeAll(async () => {
    mailDir = await mkdtemp(path.join(tmpdir(), "binderlab-anvandare-"));
  });
  afterAll(async () => {
    await rm(mailDir, { recursive: true, force: true });
  });

  function provider(cookies = new MemoryCookieJar()) {
    return new DevAuthProvider({
      env: {
        APP_ENV: "development",
        DATABASE_URL: process.env.DATABASE_URL,
        DEV_AUTH_SECRET: SECRET,
      },
      cookies,
      db: getServiceDb,
      mailDir,
      log: () => {},
    });
  }

  async function tokenFor(email: string): Promise<string> {
    for (const file of (await readdir(mailDir)).sort().reverse()) {
      const text = await readFile(path.join(mailDir, file), "utf8");
      const token = text.includes(`To: ${email}`)
        ? /\/inbjudan\/([0-9a-f]{64})/.exec(text)?.[1]
        : undefined;
      if (token) return token;
    }
    throw new Error(`Inget mejl till ${email}`);
  }

  it("ny delägare: inbjudan → eget lösenord → läsare → kan logga in", async () => {
    const f = await orgWith([]);
    const email = `delagare-${uniqueSuffix()}@test.binderlab.se`;
    const invited = await createInviteFlow(
      { provider: provider(), user: session(f.owner), baseUrl: "http://localhost:3200" },
      { organizationId: f.orgId, email, role: "viewer" },
    );
    expect(invited).toEqual({ ok: true });
    const token = await tokenFor(email);
    const cookies = new MemoryCookieJar();
    const accepted = await acceptInviteFlow(
      { provider: provider(cookies), user: null, cookies, secureCookies: false },
      { token, password: PASSWORD },
    );
    expect(accepted).toEqual({ ok: true, data: { organizationId: f.orgId } });
    const user = await one<{ id: string }>(
      db(),
      sql`select id from auth.users where email = ${email}`,
    );
    expect(await getRoleFor({ userId: user.id, email }, f.orgId)).toBe("viewer");
    const login = await loginFlow(
      {
        provider: provider(),
        limiter: createRateLimiter({ limit: 5, windowMs: 60_000 }),
        ip: "1.2.3.4",
      },
      { email, password: PASSWORD },
    );
    expect(login).toEqual({ ok: true });
    // Läsaren ser inte medlemslistan.
    await expect(loadMembersPageFor({ userId: user.id, email }, f.orgId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("delägare med konto: borttagen, inbjuden igen som läsare, loggar in och går med", async () => {
    const f = await orgWith([]);
    const partner = await createUser(`delagare-${uniqueSuffix()}@test.binderlab.se`);
    const hash = await hashPassword(PASSWORD);
    await asPostgres((tx) =>
      tx.execute(sql`update auth.users set encrypted_password = ${hash} where id = ${partner.id}`),
    );
    const invited = await createInviteFlow(
      { provider: provider(), user: session(f.owner), baseUrl: "http://localhost:3200" },
      { organizationId: f.orgId, email: partner.email, role: "viewer" },
    );
    expect(invited).toEqual({ ok: true });
    const token = await tokenFor(partner.email);

    // Utan session: kontot finns redan, personen ska logga in först.
    const anon = new MemoryCookieJar();
    expect(
      await acceptInviteFlow(
        { provider: provider(anon), user: null, cookies: anon, secureCookies: false },
        { token, password: "ett annat långt lösenord" },
      ),
    ).toMatchObject({ ok: false });

    const cookies = new MemoryCookieJar();
    const p = provider(cookies);
    expect(
      await loginFlow(
        { provider: p, limiter: createRateLimiter({ limit: 5, windowMs: 60_000 }), ip: "1.2.3.4" },
        { email: partner.email, password: PASSWORD },
      ),
    ).toEqual({ ok: true });
    const sessionUser = await p.getSession();
    expect(sessionUser?.email).toBe(partner.email);
    const accepted = await acceptInviteFlow(
      { provider: p, user: sessionUser, cookies, secureCookies: false },
      { token },
    );
    expect(accepted).toEqual({ ok: true, data: { organizationId: f.orgId } });
    expect(await roleOf(f.orgId, partner)).toBe("viewer");

    // Ta bort och bjud in igen: medlemskapet kommer tillbaka som läsare.
    const removed = await removeMemberFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: await membershipId(f.orgId, partner),
    });
    expect(removed).toEqual({ ok: true, data: { self: false } });
    expect(await roleOf(f.orgId, partner)).toBeNull();
    await createInviteFlow(
      { provider: provider(), user: session(f.owner), baseUrl: "http://localhost:3200" },
      { organizationId: f.orgId, email: partner.email, role: "viewer" },
    );
    const again = await acceptInviteFlow(
      { provider: p, user: sessionUser, cookies, secureCookies: false },
      { token: await tokenFor(partner.email) },
    );
    expect(again).toMatchObject({ ok: true });
    expect(await roleOf(f.orgId, partner)).toBe("viewer");
  });
  it("admin som bjuder in en ägare nekas, och felet förklaras som ägarregeln", async () => {
    const f = await orgWith(["admin"]);
    const result = await createInviteFlow(
      { provider: provider(), user: session(f.admin!), baseUrl: "http://localhost:3200" },
      {
        organizationId: f.orgId,
        email: `ny-agare-${uniqueSuffix()}@test.binderlab.se`,
        role: "owner",
      },
    );
    expect(result.ok).toBe(false);
    const generic = dbErrorMessage({ code: "42501", severity: "ERROR", message: "" });
    expect(inviteErrorFor("owner", result.error!, generic)).toBe(OWNER_INVITE_REASON);
    const pending = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.invitations where organization_id = ${f.orgId}`,
    );
    expect(pending.n).toBe(0);
  });

  it("devAccountExists: bara ett konto med lösenord räknas, oavsett versaler", async () => {
    const email = `konto-${uniqueSuffix()}@test.binderlab.se`;
    expect(await devAccountExists(email)).toBe(false);
    const user = await createUser(email);
    expect(await devAccountExists(email)).toBe(false);
    const encrypted = await hashPassword(PASSWORD);
    await asPostgres((tx) =>
      tx.execute(
        sql`update auth.users set encrypted_password = ${encrypted} where id = ${user.id}::uuid`,
      ),
    );
    expect(await devAccountExists(email.toUpperCase())).toBe(true);
  });
});
