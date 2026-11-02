/**
 * Butiksportalen i /butiker: ägare och admin ser vem i butiken som har tillgång
 * (och väntande inbjudningar), tar bort butiksanvändare och återkallar inbjudningar.
 * Frågorna rör bara rollen store för just den butiken, och läsare, påfyllare och
 * butiker själva kommer inte åt dem.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  deleteStorePortalInvitation,
  deleteStorePortalUser,
  queryStorePortalAccess,
} from "../../src/server/portal/access";
import { queryPortalStores } from "../../src/server/portal/queries";

import { asUser, attempt, one, uniqueSuffix } from "./helpers";
import { inviteStoreUser, seedPortalFixture, type PortalFixture } from "./portal-fixture";

let f: PortalFixture;

beforeAll(async () => {
  f = await seedPortalFixture();
});

describe("vem som har tillgång till butikens portal", () => {
  it("ägaren och admin ser butikens användare och väntande inbjudningar, bara för butiken", async () => {
    const email = `vantar-${uniqueSuffix()}@test.binderlab.se`;
    await asUser(f.a.owner, (tx) =>
      tx.execute(
        sql`select public.create_store_invitation(${f.a.orgId}::uuid, ${f.a.storeId}::uuid, ${email})`,
      ),
    );
    for (const user of [f.a.owner, f.adminA]) {
      const access = await asUser(user, (tx) => queryStorePortalAccess(tx, f.a.orgId, f.a.storeId));
      expect(access.users.map((u) => u.email)).toEqual([f.storeA1.email]);
      expect(access.invitations.map((i) => i.email)).toEqual([email]);
    }
    const other = await asUser(f.a.owner, (tx) =>
      queryStorePortalAccess(tx, f.a.orgId, f.a2.storeId),
    );
    expect(other.users.map((u) => u.email)).toEqual([f.storeA2.email]);
    expect(other.invitations).toEqual([]);
  });

  it("läsare, påfyllare, butiker och andra organisationer kommer inte åt listan", async () => {
    for (const user of [f.viewerA, f.refillerA, f.storeA1, f.b.owner]) {
      const outcome = await asUser(user, (tx) =>
        attempt(tx, (sp) => queryStorePortalAccess(sp, f.a.orgId, f.a.storeId)),
      );
      expect(outcome.ok).toBe(false);
    }
  });

  it("ta bort och återkalla rör bara rollen store för just den butiken", async () => {
    const extra = await inviteStoreUser(f.a.owner, f.a.orgId, f.a.storeId);
    const ids = await asUser(f.a.owner, (tx) => queryStorePortalAccess(tx, f.a.orgId, f.a.storeId));
    const membershipId = ids.users.find((u) => u.email === extra.email)!.membershipId;

    // Fel butik: inget tas bort.
    expect(
      await asUser(f.a.owner, (tx) =>
        deleteStorePortalUser(tx, {
          organizationId: f.a.orgId,
          storeId: f.a2.storeId,
          membershipId,
        }),
      ),
    ).toBe(0);
    // En approll (läsaren) går inte att ta bort härifrån.
    const viewerMembership = await asUser(f.a.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`select id from public.memberships where organization_id = ${f.a.orgId}
            and user_id = ${f.viewerA.id}`,
      ),
    );
    expect(
      await asUser(f.a.owner, (tx) =>
        deleteStorePortalUser(tx, {
          organizationId: f.a.orgId,
          storeId: f.a.storeId,
          membershipId: viewerMembership.id,
        }),
      ),
    ).toBe(0);
    // Läsaren kan inte ta bort (RLS).
    expect(
      await asUser(f.viewerA, (tx) =>
        deleteStorePortalUser(tx, {
          organizationId: f.a.orgId,
          storeId: f.a.storeId,
          membershipId,
        }),
      ),
    ).toBe(0);

    // Admin tar bort: butiksanvändaren når inte portalen längre.
    expect(await asUser(extra, queryPortalStores)).toHaveLength(1);
    expect(
      await asUser(f.adminA, (tx) =>
        deleteStorePortalUser(tx, {
          organizationId: f.a.orgId,
          storeId: f.a.storeId,
          membershipId,
        }),
      ),
    ).toBe(1);
    expect(await asUser(extra, queryPortalStores)).toEqual([]);

    // Återkalla en väntande inbjudan.
    const email = `aterkalla-${uniqueSuffix()}@test.binderlab.se`;
    await asUser(f.a.owner, (tx) =>
      tx.execute(
        sql`select public.create_store_invitation(${f.a.orgId}::uuid, ${f.a.storeId}::uuid, ${email})`,
      ),
    );
    const before = await asUser(f.a.owner, (tx) =>
      queryStorePortalAccess(tx, f.a.orgId, f.a.storeId),
    );
    const invitationId = before.invitations.find((i) => i.email === email)!.invitationId;
    expect(
      await asUser(f.a.owner, (tx) =>
        deleteStorePortalInvitation(tx, {
          organizationId: f.a.orgId,
          storeId: f.a2.storeId,
          invitationId,
        }),
      ),
    ).toBe(0);
    expect(
      await asUser(f.a.owner, (tx) =>
        deleteStorePortalInvitation(tx, {
          organizationId: f.a.orgId,
          storeId: f.a.storeId,
          invitationId,
        }),
      ),
    ).toBe(1);
    const after = await asUser(f.a.owner, (tx) =>
      queryStorePortalAccess(tx, f.a.orgId, f.a.storeId),
    );
    expect(after.invitations.map((i) => i.email)).not.toContain(email);
  });
});
