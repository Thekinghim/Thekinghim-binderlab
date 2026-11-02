/**
 * Egen liten fixtur för assistentens tester: en organisation med en butik, två automater,
 * två titlar med inköpspris, ett avtal, order i mars 2025 och lager i automaterna. Skrivs
 * som ägaren genom RLS. (Den gemensamma seedTenantFixture täcker varje tabell och ändras
 * ofta; assistenten behöver bara det här.)
 */

import { listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import * as s from "@/db/schema";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

export interface AssistantFixture {
  orgId: string;
  owner: TestUser;
  machineIds: [string, string];
  titleIds: [string, string];
  storeId: string;
}

export function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

export async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Order: (automat 0|1, titel 0|1, datum, belopp i öre). */
const ORDERS: Array<[0 | 1, 0 | 1, string, number]> = [
  [0, 0, "2025-03-03", 7900],
  [0, 0, "2025-03-04", 7900],
  [0, 1, "2025-03-05", 8900],
  [1, 0, "2025-03-05", 7900],
  [0, 1, "2025-03-08", 8900],
  [0, 0, "2025-03-10", 7900],
  [1, 1, "2025-03-11", 8900],
];

export async function seedAssistantFixture(): Promise<AssistantFixture> {
  const owner = await createUser(`agare-assistent-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Assistent ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Assistent" })
      .returning();
    await tx.insert(s.storeAgreements).values({
      ...org,
      storeId: store!.id,
      validFrom: "2025-01-01",
      commissionBp: 1000,
    });
    const machines = await tx
      .insert(s.machines)
      .values([
        { ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" },
        { ...org, code: "BL-002", name: "Automat 2", activeFrom: "2025-01-01" },
      ])
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values(
        machines.map((m) => ({
          ...org,
          machineId: m.id,
          storeId: store!.id,
          validFrom: "2025-01-01",
        })),
      );
    const titles = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster", series: "Scarlet & Violet" },
        { ...org, name: "Surging Sparks Booster", series: "Scarlet & Violet" },
      ])
      .returning();
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: titles[0]!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
      { ...org, titleId: titles[1]!.id, unitCostOre: 5200, validFrom: "2025-01-01" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();

    // Lager: 12 av varje titel i varje automat den 1 mars (försäljningen drar av ett per order).
    const locations = await tx.select().from(s.stockLocations);
    const locationOf = (machineId: string) =>
      locations.find((l) => l.organizationId === orgId && l.machineId === machineId)!.id;
    await tx.insert(s.stockEvents).values(
      machines.flatMap((m) =>
        titles.map((t) => ({
          ...org,
          locationId: locationOf(m.id),
          titleId: t.id,
          kind: "refill" as const,
          quantity: 12,
          occurredAt: new Date("2025-03-01T07:00:00Z"),
        })),
      ),
    );

    await tx.insert(s.orders).values(
      ORDERS.map(([m, t, date, amount], i) => ({
        ...org,
        dataSourceId: source!.id,
        externalId: `A${i + 1}`,
        rawTitle: titles[t]!.name,
        titleId: titles[t]!.id,
        orderedAt: new Date(`${date}T11:00:00Z`),
        amountOre: amount,
        paymentMethod: "card",
        machineId: machines[m]!.id,
        sourceHash: `assistent-${i}`,
      })),
    );

    return {
      orgId,
      owner,
      machineIds: [machines[0]!.id, machines[1]!.id],
      titleIds: [titles[0]!.id, titles[1]!.id],
      storeId: store!.id,
    };
  });
}

export { createMember };
