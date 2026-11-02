/**
 * Skapa organisation för en ny operatör (createOrganizationFor) mot testdatabasen:
 * ägarmedlemskap via create_first_organization, unikt kortnamn, validering och vem som
 * får. Regeln gäller i databasen (lås per användare, BL060/BL061), så samtidiga anrop
 * och direkta anrop till RPC:erna nekas också.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { listOrganizationsFor } from "@/server/access";
import {
  CREATE_ORGANIZATION_MESSAGES as M,
  createOrganizationFor,
  slugFromName,
} from "@/server/onboarding/create-organization";
import { loadOnboardingStatusFor } from "@/server/onboarding/status";

import {
  asServiceRole,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  uniqueSuffix,
} from "./helpers";
import { inviteStoreUser, seedPortalTenant } from "./portal-fixture";

const session = (u: { id: string; email: string }) => ({ userId: u.id, email: u.email });

describe("slugFromName", () => {
  it("gör ett kortnamn av namnet", () => {
    expect(slugFromName("Kortautomater Väst AB")).toBe("kortautomater-vast-ab");
    expect(slugFromName("  Åre & Östersund!  ")).toBe("are-ostersund");
    expect(slugFromName("Café Noël")).toBe("cafe-noel");
    expect(slugFromName("!!!")).toBe("organisation");
    expect(slugFromName("x".repeat(80))).toHaveLength(48);
  });
});

describe("createOrganizationFor", () => {
  it("skapar organisationen med användaren som ägare, centrallager och profil", async () => {
    const user = await createUser(`ny-${uniqueSuffix()}@test.binderlab.se`);
    const name = `Kortautomater ${uniqueSuffix()}`;
    const result = await createOrganizationFor(session(user), { name: `  ${name}  ` });
    expect(result.ok).toBe(true);
    const orgId = result.data!.organizationId;

    const orgs = await listOrganizationsFor(session(user));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ id: orgId, name, role: "owner", slug: slugFromName(name) });

    const central = await asUser(user, (tx) =>
      one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.stock_locations
            where organization_id = ${orgId} and is_central`,
      ),
    );
    expect(central.n).toBe(1);

    const status = await loadOnboardingStatusFor(session(user), orgId);
    expect(status.requiredDone).toBe(1);
    expect(status.next?.id).toBe("butik");
  });

  it("ger ett unikt kortnamn när namnet redan är taget", async () => {
    const name = `Samma Namn ${uniqueSuffix()}`;
    const first = await createUser(`a-${uniqueSuffix()}@test.binderlab.se`);
    const second = await createUser(`b-${uniqueSuffix()}@test.binderlab.se`);
    const a = await createOrganizationFor(session(first), { name });
    const b = await createOrganizationFor(session(second), { name });
    expect(a.ok && b.ok).toBe(true);
    const slugs = await db().execute(
      sql`select slug::text as slug from public.organizations
          where id in (${a.data!.organizationId}::uuid, ${b.data!.organizationId}::uuid)`,
    );
    const values = Array.from(slugs).map((r) => String((r as { slug: string }).slug));
    expect(new Set(values).size).toBe(2);
    expect(values).toContain(slugFromName(name));
  });

  it("validerar namnet", async () => {
    const user = await createUser(`v-${uniqueSuffix()}@test.binderlab.se`);
    expect(await createOrganizationFor(session(user), { name: " " })).toEqual({
      ok: false,
      error: M.nameMissing,
    });
    expect(await createOrganizationFor(session(user), {})).toEqual({
      ok: false,
      error: M.nameMissing,
    });
    expect(await createOrganizationFor(session(user), { name: "x".repeat(121) })).toEqual({
      ok: false,
      error: M.nameTooLong,
    });
    expect(await listOrganizationsFor(session(user))).toHaveLength(0);
  });

  it("kräver inloggning", async () => {
    expect(await createOrganizationFor(null, { name: "Någon" })).toEqual({
      ok: false,
      error: M.notLoggedIn,
    });
  });

  it("nekar den som redan är med i en organisation, oavsett roll", async () => {
    const owner = await createUser(`o-${uniqueSuffix()}@test.binderlab.se`);
    const orgId = await createOrg(owner);
    expect(await createOrganizationFor(session(owner), { name: "Andra" })).toEqual({
      ok: false,
      error: M.alreadyMember,
    });
    const refiller = await createMember(orgId, "refiller");
    expect(await createOrganizationFor(session(refiller), { name: "Egen" })).toEqual({
      ok: false,
      error: M.alreadyMember,
    });
    expect(await listOrganizationsFor(session(refiller))).toHaveLength(1);
  });

  it("nekar ett butikskonto (butiksportalen)", async () => {
    const tenant = await seedPortalTenant();
    const storeUser = await inviteStoreUser(tenant.owner, tenant.orgId, tenant.storeId);
    expect(await createOrganizationFor(session(storeUser), { name: "Butikens egen" })).toEqual({
      ok: false,
      error: M.storeAccount,
    });
  });

  it("butikskonto vars butik har arkiverats nekas också", async () => {
    const tenant = await seedPortalTenant();
    const storeUser = await inviteStoreUser(tenant.owner, tenant.orgId, tenant.storeId);
    await asServiceRole((tx) =>
      tx.execute(sql`update public.stores set archived_at = now() where id = ${tenant.storeId}`),
    );
    expect(await createOrganizationFor(session(storeUser), { name: "Butikens egen" })).toEqual({
      ok: false,
      error: M.storeAccount,
    });
  });

  it("samtidiga anrop från samma konto ger en organisation", async () => {
    const user = await createUser(`race-${uniqueSuffix()}@test.binderlab.se`);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createOrganizationFor(session(user), { name: `Samtidig ${i}` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.error)).toEqual([
      M.alreadyMember,
      M.alreadyMember,
      M.alreadyMember,
    ]);
    expect(await listOrganizationsFor(session(user))).toHaveLength(1);
  });
});

describe("RPC:erna direkt (som en klient med den publika nyckeln)", () => {
  it("create_first_organization nekar den som redan är medlem (BL060)", async () => {
    const owner = await createUser(`d-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(owner);
    const outcome = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.create_first_organization('Direkt', ${`direkt-${uniqueSuffix()}`})`,
        ),
      ),
    );
    expect(outcome.code).toBe("BL060");
  });

  it("butikskontot nekas av båda RPC:erna (BL061)", async () => {
    const tenant = await seedPortalTenant();
    const storeUser = await inviteStoreUser(tenant.owner, tenant.orgId, tenant.storeId);
    for (const fn of ["create_first_organization", "create_organization"]) {
      const outcome = await asUser(storeUser, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select ${sql.identifier("public")}.${sql.identifier(fn)}('Direkt', ${`direkt-${uniqueSuffix()}`})`,
          ),
        ),
      );
      expect(outcome.code).toBe("BL061");
    }
  });

  it("create_organization fungerar som förut för en ägare (organisationsväljaren, seed)", async () => {
    const owner = await createUser(`two-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(owner);
    const second = await asUser(owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`select public.create_organization('Andra bolaget', ${`andra-${uniqueSuffix()}`}) as id`,
      ),
    );
    expect(typeof second.id).toBe("string");
    expect(await listOrganizationsFor(session(owner))).toHaveLength(2);
  });
});
