/**
 * Kostnadsraderna (src/lib/cost-lines): hyra och fasta kostnader visas bara när
 * organisationen har någon. Läses som användaren (RLS) med samma underlag som
 * beräkningarna, och följer med beräkningsindatan (loadDomainInputFor).
 */

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { listOrganizationsFor } from "@/server/access";
import { loadCostLinesFor, loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";

import {
  asPostgres,
  createMember,
  seedTenantFixture,
  type TenantFixture,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const MARCH = { start: "2025-03-01", end: "2025-03-31" };

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fx: TenantFixture;
let owner: Viewer;
let other: TenantFixture;

beforeAll(async () => {
  fx = await seedTenantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  other = await seedTenantFixture();
  // Fixturen har en rad i varje tabell, också fixed_costs: arkiveras för läget "inga".
  await asPostgres((tx) =>
    tx
      .update(s.fixedCosts)
      .set({ archivedAt: sql`now()` })
      .where(eq(s.fixedCosts.organizationId, fx.orgId)),
  );
});

describe("loadCostLinesFor", () => {
  it("bara provision, inga fasta kostnader: varken hyra eller fasta kostnader", async () => {
    expect(await loadCostLinesFor(owner)).toEqual({ rent: false, fixed: false });
    const input = await loadDomainInputFor(owner, { period: MARCH }, NOW);
    expect(input.costLines).toEqual({ rent: false, fixed: false });
  });

  it("en annan organisations hyra och fasta kostnader räknas inte", async () => {
    await asPostgres(async (tx) => {
      await tx
        .update(s.storeAgreements)
        .set({ monthlyRentOre: 90_000 })
        .where(eq(s.storeAgreements.id, other.agreementId));
      await tx.insert(s.fixedCosts).values({
        organizationId: other.orgId,
        name: "Försäkring",
        amountOre: 50_000,
        interval: "month",
        startsOn: "2025-01-01",
      });
    });
    expect(await loadCostLinesFor(owner)).toEqual({ rent: false, fixed: false });
  });

  it("en fast kostnad och en hyra kommer tillbaka av sig själva; arkiverad räknas inte", async () => {
    const [cost] = await asPostgres((tx) =>
      tx
        .insert(s.fixedCosts)
        .values({
          organizationId: fx.orgId,
          name: "Lagerlokal",
          amountOre: 100_000,
          interval: "month",
          startsOn: "2025-01-01",
        })
        .returning({ id: s.fixedCosts.id }),
    );
    expect(await loadCostLinesFor(owner)).toEqual({ rent: false, fixed: true });

    await asPostgres((tx) =>
      tx
        .update(s.storeAgreements)
        .set({ monthlyRentOre: 75_000 })
        .where(eq(s.storeAgreements.id, fx.agreementId)),
    );
    expect(await loadCostLinesFor(owner)).toEqual({ rent: true, fixed: true });
    const input = await loadDomainInputFor(owner, { period: MARCH }, NOW);
    expect(input.costLines).toEqual({ rent: true, fixed: true });

    await asPostgres((tx) =>
      tx
        .update(s.fixedCosts)
        .set({ archivedAt: sql`now()` })
        .where(eq(s.fixedCosts.id, cost!.id)),
    );
    expect(await loadCostLinesFor(owner)).toEqual({ rent: true, fixed: false });
  });

  it("påfyllaren får inga kostnadsrader (rollkontroll)", async () => {
    const refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
    await expect(loadCostLinesFor(refiller)).rejects.toThrow();
  });
});
