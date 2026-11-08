/**
 * Teamlåset i Enkel vy (20261117000000_enkel_vy_teamlas.sql) mot testdatabasen.
 *
 * Ägaren (William) står överst: han bjuder in och sätter allas vy och språk. En delägare
 * med Enkel vy är ägare i datan men får inte hantera teamet, varken i databasen (RPC:er,
 * direkta skrivningar under RLS) eller i flödena bakom server actions: skapa, skicka om
 * eller återkalla inbjudningar, ändra roll, vy eller språk åt någon annan, ta bort medlemmar.
 * Det egna språket får hen ändra. En ägare i full vy kan fortfarande allt.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  changeMemberRoleFlow,
  removeMemberFlow,
  revokeInvitationFlow,
  setInvitationOptionsFlow,
  setMemberLocaleFlow,
  setMemberViewFlow,
} from "../../src/app/(app)/installningar/anvandare/members-data";
import { getServiceDb } from "../../src/db/client";
import { SIMPLE_VIEW_TEAM_MESSAGE, requireTeamManagerFor } from "../../src/server/access";
import { DevAuthProvider } from "../../src/server/auth/dev-provider";
import { createInviteFlow } from "../../src/server/auth/flows";
import { MemoryCookieJar } from "../../src/server/auth/types";
import {
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

const SECRET = "t".repeat(48);
const BASE_URL = "http://localhost:3200";
const session = (u: TestUser) => ({ userId: u.id, email: u.email });

let mailDir: string;

beforeAll(async () => {
  mailDir = await mkdtemp(path.join(tmpdir(), "binderlab-teamlas-mail-"));
});

afterAll(async () => {
  await rm(mailDir, { recursive: true, force: true });
});

function inviteCtx(user: TestUser) {
  const provider = new DevAuthProvider({
    env: {
      APP_ENV: "development",
      DATABASE_URL: process.env.DATABASE_URL,
      DEV_AUTH_SECRET: SECRET,
    },
    cookies: new MemoryCookieJar(),
    db: getServiceDb,
    mailDir,
    log: () => {},
  });
  return { provider, user: session(user), baseUrl: BASE_URL };
}

/**
 * William (ägare, full vy), delägaren (ägare, Enkel vy), en admin och en läsare, en butik
 * och en obesvarad inbjudan som William skickat.
 */
async function team() {
  const william = await createUser(`william-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(william, "Teamlås");
  const partner = await createMember(orgId, "owner");
  const admin = await createMember(orgId, "admin");
  const viewer = await createMember(orgId, "viewer");
  await db().execute(
    sql`update public.memberships set view_mode = 'simple'
        where organization_id = ${orgId}::uuid and user_id = ${partner.id}::uuid`,
  );
  const store = await one<{ id: string }>(
    db(),
    sql`insert into public.stores (organization_id, name) values (${orgId}::uuid, 'Butiken')
        returning id`,
  );
  const pendingEmail = `vantar-${uniqueSuffix()}@test.binderlab.se`;
  await asUser(william, (tx) =>
    tx.execute(sql`select public.create_invitation(${orgId}::uuid, ${pendingEmail}, 'viewer')`),
  );
  const invitation = await invitationTo(orgId, pendingEmail);
  return { orgId, william, partner, admin, viewer, storeId: store.id, pendingEmail, invitation };
}

async function invitationTo(orgId: string, email: string) {
  return one<{ id: string; expires_at: string }>(
    db(),
    sql`select id, expires_at::text as expires_at from public.invitations
        where organization_id = ${orgId}::uuid and email = ${email} and accepted_at is null
        order by created_at desc limit 1`,
  );
}

async function membership(orgId: string, user: TestUser) {
  return one<{ id: string; role: string; view_mode: string }>(
    db(),
    sql`select id, role::text as role, view_mode from public.memberships
        where organization_id = ${orgId}::uuid and user_id = ${user.id}::uuid`,
  );
}

async function localeOf(orgId: string, user: TestUser): Promise<string> {
  return (
    await one<{ locale: string }>(
      db(),
      sql`select locale from public.profiles
          where organization_id = ${orgId}::uuid and user_id = ${user.id}::uuid`,
    )
  ).locale;
}

async function invitationCount(orgId: string): Promise<number> {
  const r = await one<{ n: number }>(
    db(),
    sql`select count(*)::int as n from public.invitations where organization_id = ${orgId}::uuid`,
  );
  return r.n;
}

/** Kör som användaren i en sparpunkt: ok med raderna, eller felkoden. */
function as(user: TestUser, query: ReturnType<typeof sql>) {
  return asUser(user, (tx) => attempt(tx, async (sp) => Array.from(await sp.execute(query))));
}

describe("databasen: delägaren med Enkel vy hanterar inte teamet", () => {
  it("kan inte skapa en inbjudan (create_invitation, create_store_invitation): BL132", async () => {
    const f = await team();
    const before = await invitationCount(f.orgId);
    const invite = await as(
      f.partner,
      sql`select public.create_invitation(${f.orgId}::uuid, ${`ny-${uniqueSuffix()}@test.binderlab.se`}, 'viewer')`,
    );
    expect(invite.code).toBe("BL132");
    const storeInvite = await as(
      f.partner,
      sql`select public.create_store_invitation(${f.orgId}::uuid, ${f.storeId}::uuid,
                                                ${`butik-${uniqueSuffix()}@test.binderlab.se`})`,
    );
    expect(storeInvite.code).toBe("BL132");
    expect(await invitationCount(f.orgId)).toBe(before);
  });

  it("kan inte skicka om en inbjudan: den gamla länken gäller som förut", async () => {
    const f = await team();
    const resend = await as(
      f.partner,
      sql`select public.create_invitation(${f.orgId}::uuid, ${f.pendingEmail}, 'viewer')`,
    );
    expect(resend.code).toBe("BL132");
    const after = await invitationTo(f.orgId, f.pendingEmail);
    expect(after.id).toBe(f.invitation.id);
    expect(after.expires_at).toBe(f.invitation.expires_at);
  });

  it("kan inte återkalla eller ändra en inbjudan", async () => {
    const f = await team();
    const revoke = await as(
      f.partner,
      sql`delete from public.invitations where id = ${f.invitation.id}::uuid returning id`,
    );
    // Den restriktiva policyn släpper inte raden: inget raderas.
    expect(revoke.ok ? revoke.value : revoke.code).toEqual([]);
    const options = await as(
      f.partner,
      sql`select public.set_invitation_options(${f.orgId}::uuid, ${f.invitation.id}::uuid, 'simple', 'en')`,
    );
    expect(options.code).toBe("42501");
    const still = await one<{ n: number; view_mode: string }>(
      db(),
      sql`select count(*)::int as n, max(view_mode) as view_mode from public.invitations
          where id = ${f.invitation.id}::uuid`,
    );
    expect(still).toEqual({ n: 1, view_mode: "full" });
  });

  it("kan inte ändra någons roll eller vy", async () => {
    const f = await team();
    const viewer = await membership(f.orgId, f.viewer);
    const role = await as(
      f.partner,
      sql`update public.memberships set role = 'admin' where id = ${viewer.id}::uuid returning id`,
    );
    expect(role.code).toBe("BL132");
    const view = await as(
      f.partner,
      sql`update public.memberships set view_mode = 'simple' where id = ${viewer.id}::uuid
          returning id`,
    );
    expect(view.code).toBe("BL131");
    // Inte heller den egna rollen.
    const own = await membership(f.orgId, f.partner);
    const ownRole = await as(
      f.partner,
      sql`update public.memberships set role = 'admin' where id = ${own.id}::uuid returning id`,
    );
    expect(ownRole.code).toBe("BL132");
    expect(await membership(f.orgId, f.viewer)).toMatchObject({
      role: "viewer",
      view_mode: "full",
    });
    expect(await membership(f.orgId, f.partner)).toMatchObject({
      role: "owner",
      view_mode: "simple",
    });
  });

  it("kan inte ändra någon annans språk, men sitt eget", async () => {
    const f = await team();
    const other = await as(
      f.partner,
      sql`update public.profiles set locale = 'en'
          where organization_id = ${f.orgId}::uuid and user_id = ${f.william.id}::uuid
          returning id`,
    );
    expect(other.ok ? other.value : other.code).toEqual([]);
    expect(await localeOf(f.orgId, f.william)).toBe("sv");
    // En ny profil åt någon annan går inte heller.
    const newcomer = await createMember(f.orgId, "refiller");
    await db()
      .execute(
        sql`delete from public.profiles
          where organization_id = ${f.orgId}::uuid and user_id = ${newcomer.id}::uuid`,
      )
      .catch(() => undefined);
    const insert = await as(
      f.partner,
      sql`insert into public.profiles (organization_id, user_id, display_name, locale)
          values (${f.orgId}::uuid, ${newcomer.id}::uuid, 'Ny', 'en')`,
    );
    expect(insert.ok).toBe(false);
    // Det egna språket: ja.
    const own = await as(
      f.partner,
      sql`update public.profiles set locale = 'en'
          where organization_id = ${f.orgId}::uuid and user_id = ${f.partner.id}::uuid
          returning id`,
    );
    expect(own.ok ? own.value.length : own.code).toBe(1);
    expect(await localeOf(f.orgId, f.partner)).toBe("en");
  });

  it("kan inte ta bort medlemmar, inte heller sig själv", async () => {
    const f = await team();
    for (const target of [f.viewer, f.admin, f.william, f.partner]) {
      const m = await membership(f.orgId, target);
      const out = await as(
        f.partner,
        sql`delete from public.memberships where id = ${m.id}::uuid returning id`,
      );
      expect(out.ok ? out.value : out.code).toEqual([]);
    }
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.memberships where organization_id = ${f.orgId}::uuid`,
    );
    expect(n.n).toBe(4);
  });

  it("delägaren i full vy i en ANNAN organisation hanterar teamet där som vanligt", async () => {
    const f = await team();
    const ownOrg = await createOrg(f.partner, "Egen");
    const out = await as(
      f.partner,
      sql`select public.create_invitation(${ownOrg}::uuid, ${`x-${uniqueSuffix()}@test.binderlab.se`}, 'viewer')`,
    );
    expect(out.ok).toBe(true);
  });
});

describe("flödena bakom server actions: delägaren med Enkel vy nekas", () => {
  it("requireTeamManagerFor kastar med teamlåsets meddelande", async () => {
    const f = await team();
    await expect(requireTeamManagerFor(session(f.partner), f.orgId)).rejects.toThrow(
      SIMPLE_VIEW_TEAM_MESSAGE,
    );
    await expect(requireTeamManagerFor(session(f.william), f.orgId)).resolves.toBe("owner");
  });

  it("bjuda in (även med lösenord: inget konto skapas), skicka om, återkalla", async () => {
    const f = await team();
    const email = `delagare-bjuder-${uniqueSuffix()}@test.binderlab.se`;
    const invite = await createInviteFlow(inviteCtx(f.partner), {
      organizationId: f.orgId,
      email,
      role: "viewer",
      password: "ett långt testlösenord",
    });
    expect(invite).toEqual({ ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE });
    expect(await rows(db(), sql`select id from auth.users where email = ${email}`)).toEqual([]);
    // Skicka om = en ny inbjudan till samma adress.
    const resend = await createInviteFlow(inviteCtx(f.partner), {
      organizationId: f.orgId,
      email: f.pendingEmail,
      role: "viewer",
    });
    expect(resend).toEqual({ ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE });
    const revoke = await revokeInvitationFlow(session(f.partner), {
      organizationId: f.orgId,
      invitationId: f.invitation.id,
    });
    expect(revoke).toEqual({ ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE });
    const options = await setInvitationOptionsFlow(session(f.partner), {
      organizationId: f.orgId,
      invitationId: f.invitation.id,
      viewMode: "simple",
      locale: "en",
    });
    expect(options).toEqual({ ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE });
    expect((await invitationTo(f.orgId, f.pendingEmail)).id).toBe(f.invitation.id);
  });

  it("roll, vy, språk åt andra och borttagning", async () => {
    const f = await team();
    const viewer = await membership(f.orgId, f.viewer);
    const denied = { ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE };
    const base = { organizationId: f.orgId, membershipId: viewer.id };
    expect(await changeMemberRoleFlow(session(f.partner), { ...base, role: "admin" })).toEqual(
      denied,
    );
    expect(await setMemberViewFlow(session(f.partner), { ...base, viewMode: "simple" })).toEqual(
      denied,
    );
    expect(await setMemberLocaleFlow(session(f.partner), { ...base, locale: "en" })).toEqual(
      denied,
    );
    expect(await removeMemberFlow(session(f.partner), base)).toEqual(denied);
    const william = await membership(f.orgId, f.william);
    expect(
      await removeMemberFlow(session(f.partner), {
        organizationId: f.orgId,
        membershipId: william.id,
      }),
    ).toEqual(denied);
    expect(await membership(f.orgId, f.viewer)).toMatchObject({
      role: "viewer",
      view_mode: "full",
    });
    expect(await localeOf(f.orgId, f.viewer)).toBe("sv");
  });
});

describe("William (ägare, full vy) kan fortfarande allt", () => {
  it("bjuder in, skickar om, ändrar vy och språk på inbjudan och återkallar", async () => {
    const f = await team();
    const email = `ny-${uniqueSuffix()}@test.binderlab.se`;
    expect(
      await createInviteFlow(inviteCtx(f.william), {
        organizationId: f.orgId,
        email,
        role: "viewer",
      }),
    ).toMatchObject({ ok: true });
    const first = await invitationTo(f.orgId, email);
    expect(
      await createInviteFlow(inviteCtx(f.william), {
        organizationId: f.orgId,
        email,
        role: "viewer",
      }),
    ).toMatchObject({ ok: true });
    const second = await invitationTo(f.orgId, email);
    expect(second.id).not.toBe(first.id);
    expect(
      await setInvitationOptionsFlow(session(f.william), {
        organizationId: f.orgId,
        invitationId: second.id,
        viewMode: "simple",
        locale: "en",
      }),
    ).toEqual({ ok: true });
    expect(
      await revokeInvitationFlow(session(f.william), {
        organizationId: f.orgId,
        invitationId: second.id,
      }),
    ).toEqual({ ok: true });
    const store = await as(
      f.william,
      sql`select public.create_store_invitation(${f.orgId}::uuid, ${f.storeId}::uuid,
                                                ${`butik-${uniqueSuffix()}@test.binderlab.se`})`,
    );
    expect(store.ok).toBe(true);
  });

  it("ändrar roll, vy och språk åt delägaren och läsaren, och tar bort en medlem", async () => {
    const f = await team();
    const viewer = await membership(f.orgId, f.viewer);
    const partner = await membership(f.orgId, f.partner);
    const me = session(f.william);
    expect(
      await changeMemberRoleFlow(me, {
        organizationId: f.orgId,
        membershipId: viewer.id,
        role: "refiller",
      }),
    ).toEqual({ ok: true, data: { self: false } });
    expect(
      await setMemberViewFlow(me, {
        organizationId: f.orgId,
        membershipId: partner.id,
        viewMode: "full",
      }),
    ).toEqual({ ok: true, data: { viewMode: "full" } });
    expect(
      await setMemberViewFlow(me, {
        organizationId: f.orgId,
        membershipId: partner.id,
        viewMode: "simple",
      }),
    ).toEqual({ ok: true, data: { viewMode: "simple" } });
    expect(
      await setMemberLocaleFlow(me, {
        organizationId: f.orgId,
        membershipId: partner.id,
        locale: "en",
      }),
    ).toEqual({ ok: true, data: { locale: "en" } });
    expect(await localeOf(f.orgId, f.partner)).toBe("en");
    expect(
      await removeMemberFlow(me, { organizationId: f.orgId, membershipId: viewer.id }),
    ).toEqual({ ok: true, data: { self: false } });
    // Admin i full vy hanterar också teamet (utom ägare), som förut.
    const admin = session(f.admin);
    expect(await requireTeamManagerFor(admin, f.orgId)).toBe("admin");
  });

  it("delägaren tar emot en inbjudan med Enkel vy i en ny organisation (låset stör inte)", async () => {
    const f = await team();
    const other = await createUser(`annan-${uniqueSuffix()}@test.binderlab.se`);
    const otherOrg = await createOrg(other, "Annan");
    const token = await asUser(other, (tx) =>
      one<{ token: string }>(
        tx,
        sql`select public.create_invitation(${otherOrg}::uuid, ${f.partner.email}, 'viewer') as token`,
      ),
    );
    const invitation = await invitationTo(otherOrg, f.partner.email);
    await asUser(other, (tx) =>
      tx.execute(
        sql`select public.set_invitation_options(${otherOrg}::uuid, ${invitation.id}::uuid, 'simple', 'en')`,
      ),
    );
    await asUser(f.partner, (tx) =>
      tx.execute(sql`select public.accept_invitation(${token.token})`),
    );
    expect(await membership(otherOrg, f.partner)).toMatchObject({
      role: "viewer",
      view_mode: "simple",
    });
  });
});
