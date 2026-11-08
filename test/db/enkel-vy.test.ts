/**
 * Enkel vy och språk (20261116000000_enkel_vy_och_sprak.sql) mot testdatabasen:
 * memberships.view_mode (bara ägare/admin, aldrig den egna, admin aldrig en ägare),
 * profiles.locale (personen själv, ägare/admin åt en medlem, aldrig någon annans för läsare
 * och påfyllare), inbjudningar som bär vy och språk till medlemskapet och profilen, och
 * flödena bakom Inställningar → Användare.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  loadMembersPageFor,
  setInvitationOptionsFlow,
  setMemberLocaleFlow,
  setMemberViewFlow,
} from "../../src/app/(app)/installningar/anvandare/members-data";
import { listOrganizationsFor } from "../../src/server/access";
import { loadOrganizationsFor } from "../../src/server/data/core/loaders";
import { myInvitationsFlow } from "../../src/server/auth/flows";
import {
  asAnon,
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

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function membershipOf(orgId: string, user: TestUser) {
  return one<{ id: string; view_mode: string }>(
    db(),
    sql`select id, view_mode from public.memberships
        where organization_id = ${orgId} and user_id = ${user.id}`,
  );
}

async function localeOf(orgId: string, user: TestUser): Promise<string> {
  const r = await one<{ locale: string }>(
    db(),
    sql`select locale from public.profiles where organization_id = ${orgId} and user_id = ${user.id}`,
  );
  return r.locale;
}

async function orgWithAll() {
  const owner = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, "Enkel vy");
  const partner = await createMember(orgId, "owner");
  const admin = await createMember(orgId, "admin");
  const viewer = await createMember(orgId, "viewer");
  const refiller = await createMember(orgId, "refiller");
  return { orgId, owner, partner, admin, viewer, refiller };
}

const setView = (actor: TestUser, membershipId: string, mode: "full" | "simple") =>
  asUser(actor, (tx) =>
    attempt(tx, (sp) =>
      sp.execute(
        sql`update public.memberships set view_mode = ${mode} where id = ${membershipId}::uuid
            returning id`,
      ),
    ),
  );

describe("memberships.view_mode", () => {
  it("är 'full' som standard och har en check på värdet", async () => {
    const f = await orgWithAll();
    expect((await membershipOf(f.orgId, f.partner)).view_mode).toBe("full");
    const m = await membershipOf(f.orgId, f.viewer);
    const outcome = await setView(f.owner, m.id, "x" as "full");
    expect(outcome.code).toBe("23514");
  });

  it("ägaren sätter enkel vy på en delägare (rollen är kvar)", async () => {
    const f = await orgWithAll();
    const m = await membershipOf(f.orgId, f.partner);
    expect((await setView(f.owner, m.id, "simple")).ok).toBe(true);
    const after = await one<{ view_mode: string; role: string }>(
      db(),
      sql`select view_mode, role::text as role from public.memberships where id = ${m.id}`,
    );
    expect(after).toEqual({ view_mode: "simple", role: "owner" });
  });

  it("admin sätter enkel vy på en läsare men aldrig på en ägare", async () => {
    const f = await orgWithAll();
    const viewer = await membershipOf(f.orgId, f.viewer);
    expect((await setView(f.admin, viewer.id, "simple")).ok).toBe(true);
    const partner = await membershipOf(f.orgId, f.partner);
    const outcome = await setView(f.admin, partner.id, "simple");
    // RLS (memberships_update) släpper inte raden: inget ändras.
    expect(outcome.ok ? outcome.value : null).toEqual([]);
    expect((await membershipOf(f.orgId, f.partner)).view_mode).toBe("full");
  });

  it("medlemmen kan aldrig ändra sin egen vy, inte ens som ägare (BL130)", async () => {
    const f = await orgWithAll();
    const m = await membershipOf(f.orgId, f.partner);
    await setView(f.owner, m.id, "simple");
    const outcome = await setView(f.partner, m.id, "full");
    expect(outcome.code).toBe("BL130");
    expect((await membershipOf(f.orgId, f.partner)).view_mode).toBe("simple");
    // Inte heller åt andra hållet.
    const own = await membershipOf(f.orgId, f.owner);
    expect((await setView(f.owner, own.id, "simple")).code).toBe("BL130");
  });

  it("den som själv har enkel vy ändrar inte någon annans (BL131)", async () => {
    const f = await orgWithAll();
    const partner = await membershipOf(f.orgId, f.partner);
    await setView(f.owner, partner.id, "simple");
    const own = await membershipOf(f.orgId, f.owner);
    const outcome = await setView(f.partner, own.id, "simple");
    expect(outcome.code).toBe("BL131");
    expect((await membershipOf(f.orgId, f.owner)).view_mode).toBe("full");
  });

  it("läsare och påfyllare kan inte ändra någons vy, anon inte heller", async () => {
    const f = await orgWithAll();
    const target = await membershipOf(f.orgId, f.admin);
    for (const actor of [f.viewer, f.refiller]) {
      const outcome = await setView(actor, target.id, "simple");
      // Raden syns inte i memberships_update för dem: inget ändras.
      expect(outcome.ok ? outcome.value : outcome.code).toEqual([]);
    }
    const anon = await asAnon((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.memberships set view_mode = 'simple' where id = ${target.id}`),
      ),
    );
    expect(anon.code).toBe("42501");
    expect((await membershipOf(f.orgId, f.admin)).view_mode).toBe("full");
  });

  it("listOrganizationsFor ger vyn för den inloggade", async () => {
    const f = await orgWithAll();
    const m = await membershipOf(f.orgId, f.partner);
    await setView(f.owner, m.id, "simple");
    const orgs = await listOrganizationsFor(session(f.partner));
    expect(orgs.find((o) => o.id === f.orgId)?.viewMode).toBe("simple");
    const own = await listOrganizationsFor(session(f.owner));
    expect(own.find((o) => o.id === f.orgId)?.viewMode).toBe("full");
    // Skalets laddare (loadViewer i @/server/data/core) läser vyn härifrån.
    const shell = await loadOrganizationsFor(session(f.partner));
    expect(shell.organizations.find((o) => o.id === f.orgId)?.viewMode).toBe("simple");
  });
});

describe("profiles.locale", () => {
  const setLocale = (actor: TestUser, orgId: string, target: TestUser, locale: string) =>
    asUser(actor, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.profiles set locale = ${locale}
              where organization_id = ${orgId}::uuid and user_id = ${target.id}::uuid
              returning id`,
        ),
      ),
    );

  it("personen ändrar sitt eget språk, alla roller", async () => {
    const f = await orgWithAll();
    for (const u of [f.partner, f.admin, f.viewer, f.refiller]) {
      const outcome = await setLocale(u, f.orgId, u, "en");
      expect(outcome.ok ? outcome.value : outcome.code).toHaveLength(1);
      expect(await localeOf(f.orgId, u)).toBe("en");
    }
  });

  it("ägare och admin sätter språket åt en medlem; läsare och påfyllare aldrig åt någon annan", async () => {
    const f = await orgWithAll();
    expect((await setLocale(f.owner, f.orgId, f.partner, "en")).ok).toBe(true);
    expect(await localeOf(f.orgId, f.partner)).toBe("en");
    expect((await setLocale(f.admin, f.orgId, f.viewer, "en")).ok).toBe(true);
    expect(await localeOf(f.orgId, f.viewer)).toBe("en");
    for (const actor of [f.viewer, f.refiller]) {
      const outcome = await setLocale(actor, f.orgId, f.admin, "en");
      expect(outcome.ok ? outcome.value : outcome.code).toEqual([]);
    }
    expect(await localeOf(f.orgId, f.admin)).toBe("sv");
  });

  it("bara sv eller en", async () => {
    const f = await orgWithAll();
    expect((await setLocale(f.partner, f.orgId, f.partner, "de")).code).toBe("23514");
  });

  it("andra kolumner i profilen än namn och språk är fortfarande stängda", async () => {
    const f = await orgWithAll();
    const outcome = await asUser(f.partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.profiles set anonymized_at = now()
              where organization_id = ${f.orgId}::uuid and user_id = ${f.partner.id}::uuid`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});

describe("inbjudan med vy och språk", () => {
  async function invite(owner: TestUser, orgId: string, email: string, role = "owner") {
    const token = await asUser(owner, (tx) =>
      one<{ token: string }>(
        tx,
        sql`select public.create_invitation(${orgId}::uuid, ${email}, ${role}::public.member_role) as token`,
      ),
    );
    const row = await one<{ id: string }>(
      db(),
      sql`select id from public.invitations where token_hash = encode(sha256(convert_to(${token.token}, 'UTF8')), 'hex')`,
    );
    return { token: token.token, id: row.id };
  }

  it("set_invitation_options + accept_invitation: delägaren landar i enkel vy på engelska", async () => {
    const f = await orgWithAll();
    const email = `delagare-${uniqueSuffix()}@test.binderlab.se`;
    const inv = await invite(f.owner, f.orgId, email);
    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`select public.set_invitation_options(${f.orgId}::uuid, ${inv.id}::uuid, 'simple', 'en')`,
      ),
    );
    const invitee = await createUser(email);
    await asUser(invitee, (tx) => tx.execute(sql`select public.accept_invitation(${inv.token})`));
    const m = await one<{ view_mode: string; role: string }>(
      db(),
      sql`select view_mode, role::text as role from public.memberships
          where organization_id = ${f.orgId} and user_id = ${invitee.id}`,
    );
    expect(m).toEqual({ view_mode: "simple", role: "owner" });
    expect(await localeOf(f.orgId, invitee)).toBe("en");
  });

  it("utan val: full vy och svenska som förut", async () => {
    const f = await orgWithAll();
    const email = `vanlig-${uniqueSuffix()}@test.binderlab.se`;
    const inv = await invite(f.owner, f.orgId, email, "viewer");
    const invitee = await createUser(email);
    await asUser(invitee, (tx) => tx.execute(sql`select public.accept_invitation(${inv.token})`));
    expect((await membershipOf(f.orgId, invitee)).view_mode).toBe("full");
    expect(await localeOf(f.orgId, invitee)).toBe("sv");
  });

  it("my_invitations visar språket och accept_my_invitation bär vy och språk", async () => {
    const f = await orgWithAll();
    const email = `mina-${uniqueSuffix()}@test.binderlab.se`;
    const inv = await invite(f.owner, f.orgId, email);
    const flow = await setInvitationOptionsFlow(session(f.owner), {
      organizationId: f.orgId,
      invitationId: inv.id,
      viewMode: "simple",
      locale: "en",
    });
    expect(flow).toEqual({ ok: true });
    const invitee = await createUser(email);
    const mine = await myInvitationsFlow(session(invitee));
    expect(mine.find((i) => i.id === inv.id)?.locale).toBe("en");
    await asUser(invitee, (tx) =>
      tx.execute(sql`select public.accept_my_invitation(${inv.id}::uuid)`),
    );
    expect((await membershipOf(f.orgId, invitee)).view_mode).toBe("simple");
    expect(await localeOf(f.orgId, invitee)).toBe("en");
  });

  it("admin ändrar inte en ägarinbjudan; läsare inga alls; okända värden nekas", async () => {
    const f = await orgWithAll();
    const inv = await invite(f.owner, f.orgId, `x-${uniqueSuffix()}@test.binderlab.se`);
    const call = (actor: TestUser, mode: string, locale: string) =>
      asUser(actor, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.set_invitation_options(${f.orgId}::uuid, ${inv.id}::uuid, ${mode}, ${locale})`,
          ),
        ),
      );
    expect((await call(f.admin, "simple", "en")).code).toBe("42501");
    expect((await call(f.viewer, "simple", "en")).code).toBe("42501");
    expect((await call(f.refiller, "simple", "en")).code).toBe("42501");
    expect((await call(f.owner, "tiny", "en")).code).toBe("22023");
    expect((await call(f.owner, "simple", "de")).code).toBe("22023");
    const anon = await asAnon((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.set_invitation_options(${f.orgId}::uuid, ${inv.id}::uuid, 'simple', 'en')`,
        ),
      ),
    );
    expect(anon.code).toBe("42501");
    const row = await one<{ view_mode: string; locale: string }>(
      db(),
      sql`select view_mode, locale from public.invitations where id = ${inv.id}`,
    );
    expect(row).toEqual({ view_mode: "full", locale: "sv" });
  });

  it("en annan organisations ägare når inte inbjudan", async () => {
    const f = await orgWithAll();
    const inv = await invite(f.owner, f.orgId, `y-${uniqueSuffix()}@test.binderlab.se`);
    const other = await createUser();
    const otherOrg = await createOrg(other, "Annan");
    const outcome = await asUser(other, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.set_invitation_options(${otherOrg}::uuid, ${inv.id}::uuid, 'simple', 'en')`,
        ),
      ),
    );
    expect(outcome.code).toBe("BL010");
  });
});

describe("flödena bakom Inställningar → Användare", () => {
  it("setMemberViewFlow och setMemberLocaleFlow, och sidans data visar dem", async () => {
    const f = await orgWithAll();
    const m = await membershipOf(f.orgId, f.partner);
    const view = await setMemberViewFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: m.id,
      viewMode: "simple",
    });
    expect(view).toEqual({ ok: true, data: { viewMode: "simple" } });
    const lang = await setMemberLocaleFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: m.id,
      locale: "en",
    });
    expect(lang).toEqual({ ok: true, data: { locale: "en" } });
    const page = await loadMembersPageFor(session(f.owner), f.orgId);
    expect(page.members.find((x) => x.userId === f.partner.id)).toMatchObject({
      viewMode: "simple",
      locale: "en",
    });
  });

  it("den egna vyn går inte att ändra; admin rör inte en ägares språk; läsaren nekas", async () => {
    const f = await orgWithAll();
    const own = await membershipOf(f.orgId, f.owner);
    const self = await setMemberViewFlow(session(f.owner), {
      organizationId: f.orgId,
      membershipId: own.id,
      viewMode: "simple",
    });
    expect(self.ok).toBe(false);
    expect(self.error).toMatch(/egen vy/);
    const partner = await membershipOf(f.orgId, f.partner);
    const adminOnOwner = await setMemberLocaleFlow(session(f.admin), {
      organizationId: f.orgId,
      membershipId: partner.id,
      locale: "en",
    });
    expect(adminOnOwner.ok).toBe(false);
    const viewer = await setMemberViewFlow(session(f.viewer), {
      organizationId: f.orgId,
      membershipId: partner.id,
      viewMode: "simple",
    });
    expect(viewer.ok).toBe(false);
    expect(await localeOf(f.orgId, f.partner)).toBe("sv");
    expect((await membershipOf(f.orgId, f.partner)).view_mode).toBe("full");
  });
});
