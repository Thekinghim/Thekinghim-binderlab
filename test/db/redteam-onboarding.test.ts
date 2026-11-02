/**
 * Oberoende granskning av Kom igång (src/server/onboarding): försök läcka data mellan
 * organisationer eller till fel roll, och kringgå regeln att bara den utan organisation
 * skapar en ny.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { AuthorizationError } from "@/server/session";
import { listOrganizationsFor } from "@/server/access";
import { createOrganizationFor } from "@/server/onboarding/create-organization";
import { loadOnboardingStatusFor } from "@/server/onboarding/status";

import {
  asPostgres,
  asServiceRole,
  asUser,
  createMember,
  createOrg,
  createUser,
  one,
  seedTenantFixture,
  uniqueSuffix,
} from "./helpers";
import { inviteStoreUser, seedPortalTenant } from "./portal-fixture";

const session = (u: { id: string; email: string }) => ({ userId: u.id, email: u.email });

describe("redteam: läsning av status", () => {
  it("nekar medlem i en annan organisation, påfyllare och store-roll", async () => {
    const a = await seedTenantFixture();
    const other = await createUser(`x-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(other);
    await expect(loadOnboardingStatusFor(session(other), a.orgId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const refiller = await createMember(a.orgId, "refiller");
    await expect(loadOnboardingStatusFor(session(refiller), a.orgId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const tenant = await seedPortalTenant();
    const storeUser = await inviteStoreUser(tenant.owner, tenant.orgId, tenant.storeId);
    await expect(loadOnboardingStatusFor(session(storeUser), tenant.orgId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("räknar bara den egna organisationens rader", async () => {
    const a = await seedTenantFixture();
    const fresh = await createUser(`f-${uniqueSuffix()}@test.binderlab.se`);
    const created = await createOrganizationFor(session(fresh), { name: "Tom Org" });
    const s = await loadOnboardingStatusFor(session(fresh), created.data!.organizationId);
    expect(s.complete).toBe(false);
    expect(s.coverage.revenueOre).toBe(0);
    expect(s.steps.find((x) => x.id === "butik")!.state).toBe("todo");
    // Ingen länk pekar på den andra organisationens butik.
    expect(JSON.stringify(s)).not.toContain(a.storeId);
  });
});

describe("redteam: skapa organisation", () => {
  // Rättat: create_first_organization låser per användare och kontrollerar i databasen.
  it("två samtidiga anrop ger bara en organisation", async () => {
    const user = await createUser(`race-${uniqueSuffix()}@test.binderlab.se`);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createOrganizationFor(session(user), { name: `Race ${i}` }),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    const orgs = await listOrganizationsFor(session(user));
    // Förväntat: 1. Avslöjar om kontrollen "redan medlem" går att kringgå.
    expect({ ok, orgs: orgs.length }).toEqual({ ok: 1, orgs: 1 });
  });

  // Rättat: create_first_organization nekar varje konto med rollen store (BL061).
  it("butikskonto vars butik arkiverats nekas", async () => {
    const tenant = await seedPortalTenant();
    const storeUser = await inviteStoreUser(tenant.owner, tenant.orgId, tenant.storeId);
    await asServiceRole((tx) =>
      tx.execute(sql`update public.stores set archived_at = now() where id = ${tenant.storeId}`),
    );
    const r = await createOrganizationFor(session(storeUser), { name: "Butikens egen" });
    expect(r.ok).toBe(false);
  });

  it("medlem i en arkiverad organisation", async () => {
    const owner = await createUser(`arch-${uniqueSuffix()}@test.binderlab.se`);
    const orgId = await createOrg(owner);
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set archived_at = now() where id = ${orgId}`),
    );
    const r = await createOrganizationFor(session(owner), { name: "Ny efter arkiv" });
    // Dokumenterar beteendet (ok: true är rimligt).
    expect(r.ok).toBe(true);
  });

  // Rättat: create_organization nekar butikskonton i databasen (BL061).
  it("RPC:n create_organization nekar ett butikskonto som anropar den direkt", async () => {
    const tenant = await seedPortalTenant();
    const storeUser = await inviteStoreUser(tenant.owner, tenant.orgId, tenant.storeId);
    await expect(
      asUser(storeUser, (tx) =>
        one<{ id: string }>(
          tx,
          sql`select public.create_organization('Direkt', ${`direkt-${uniqueSuffix()}`}) as id`,
        ),
      ),
    ).rejects.toThrow();
  });
});
