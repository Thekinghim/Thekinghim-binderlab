/**
 * Lönsamhet mot testdatabasen: samma kedja som sidan (loadDomainInput → buildLonsamhetModel),
 * med RLS och rollkontroll. Påfyllaren får ingen ekonomi, och en titel utan inköpspris
 * räknas inte in i vinsten men syns med länk till priset.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { buildLonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import * as s from "@/db/schema";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import { loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import type { DomainInput } from "@/server/data/core/types";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const MARCH = { start: "2025-03-01", end: "2025-03-31" };
const FEBRUARY = { start: "2025-02-01", end: "2025-02-28" };
const NOW = new Date("2025-04-02T09:00:00Z");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function model(input: DomainInput) {
  return buildLonsamhetModel(
    {
      current: input.current,
      previous: input.previous,
      titles: input.titles,
      machines: input.machines,
      stores: input.stores,
      scope: input.scope,
    },
    { today: "2025-04-02", carry: "period=allt" },
  );
}

interface Fixture {
  orgId: string;
  owner: TestUser;
  machineId: string;
  unpricedTitleId: string;
}

/**
 * Egen fixtur (en butik med provision 20 % och hyra 500 kr/mån, en automat, två titlar med
 * pris och en utan). Skriven som ägaren genom RLS.
 */
async function seedLonsamhet(): Promise<Fixture> {
  const owner = await createUser(`lonsamhet-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Lönsamhet ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Testbutik" })
      .returning();
    await tx.insert(s.storeAgreements).values({
      ...org,
      storeId: store!.id,
      validFrom: "2025-01-01",
      commissionBp: 2000,
      monthlyRentOre: 50_000,
    });
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [a, b, c] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster" },
        { ...org, name: "Surging Sparks Booster" },
        { ...org, name: "Black Bolt Booster" },
      ])
      .returning();
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: a!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
      { ...org, titleId: b!.id, unitCostOre: 5200, validFrom: "2025-01-01" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const order = (n: number, titleId: string, day: string, amountOre: number) => ({
      ...org,
      dataSourceId: source!.id,
      externalId: `L${n}`,
      rawTitle: "x",
      titleId,
      orderedAt: new Date(`${day}T10:00:00Z`),
      amountOre,
      paymentMethod: "card",
      machineId: machine!.id,
      sourceHash: `lonsamhet-${n}`,
    });
    await tx
      .insert(s.orders)
      .values([
        order(1, a!.id, "2025-03-10", 7900),
        order(2, b!.id, "2025-03-11", 7900),
        order(3, c!.id, "2025-03-12", 6900),
      ]);
    return { orgId, owner, machineId: machine!.id, unpricedTitleId: c!.id };
  });
}

let fx: Fixture;
let owner: Viewer;
let reader: Viewer;
let refiller: Viewer;
let unpricedTitleId: string;

beforeAll(async () => {
  fx = await seedLonsamhet();
  unpricedTitleId = fx.unpricedTitleId;
  owner = await viewerFor(fx.owner, fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
});

describe("Lönsamhet från databasen", () => {
  it("ger ägaren vattenfall, vyer och order utan pris som summerar till totalen", async () => {
    const m = model(await loadDomainInputFor(owner, { period: MARCH, compare: FEBRUARY }, NOW));

    expect(m.orders).toBe(3);
    expect(m.pricedOrders).toBe(2);
    const b = m.bridge;
    expect(b.revenueOre - b.costOre - b.feesOre - b.compensationOre).toBe(b.profitOre);
    expect(b.unpricedRevenueOre).toBe(6900);

    // Titeln utan pris: ingår inte i vinsten, länkar till inköpspriset.
    expect(m.unpriced.orders).toBe(1);
    expect(m.unpriced.titles).toEqual([
      expect.objectContaining({
        titleId: unpricedTitleId,
        name: "Black Bolt Booster",
        revenueOre: 6900,
        href: `/inkopspriser?titel=${unpricedTitleId}&period=allt#titel`,
      }),
    ]);
    const row = m.views.title.find((r) => r.key === unpricedTitleId);
    expect(row).toMatchObject({ profitOre: 0, revenueOre: 0, unpricedRevenueOre: 6900 });

    // Hela månadshyran dras, även den del som hamnade på ordern utan pris.
    expect(b.rentOre).toBe(50_000);
    expect(b.unallocatedRentOre).toBeGreaterThan(0);
    expect(m.views.title.find((r) => r.kind === "unallocated")?.name).toBe("Ej fördelad hyra");

    for (const view of ["title", "machine", "store"] as const) {
      const sum = m.views[view].reduce((acc, r) => acc + r.profitOre, 0);
      expect(sum).toBe(m.totals.profitOre);
    }
    expect(m.views.machine[0]).toMatchObject({ code: "BL-001", name: "Automat 1" });
    expect(m.views.store[0]).toMatchObject({ name: "ICA Testbutik" });

    // Februari saknar order: ingen jämförelse i nyckeltalen.
    expect(m.comparisonLabel).toBeNull();
    expect(m.kpis.every((k) => k.delta === null)).toBe(true);
    // 158 kr intäkt med pris klarar inte 500 kr i hyra: förlust.
    expect(m.headline.kind).toBe("loss");
    expect(m.headline.title).toMatch(/^Förlust /);
  });

  it("ger läsaren samma siffror som ägaren", async () => {
    const asOwner = model(await loadDomainInputFor(owner, { period: MARCH }, NOW));
    const asReader = model(await loadDomainInputFor(reader, { period: MARCH }, NOW));
    expect(asReader.totals).toEqual(asOwner.totals);
    expect(asReader.headline).toEqual(asOwner.headline);
  });

  it("nekar påfyllaren all ekonomi", async () => {
    await expect(loadDomainInputFor(refiller, { period: MARCH }, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("filtrerar på automat", async () => {
    const m = model(
      await loadDomainInputFor(owner, { period: MARCH, machineId: fx.machineId }, NOW),
    );
    expect(m.scopeLabel).toBe("BL-001 Automat 1");
    expect(m.orders).toBe(3);
  });
});
