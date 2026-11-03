/**
 * De gemensamma serverladdarna (src/server/data/core) mot testdatabasen.
 *
 * Viktigast: påfyllaren får aldrig ekonomi, varken via laddarna (rollkontroll) eller
 * via frågorna själva (RLS), och inget belopp finns i det påfyllaren får tillbaka.
 */

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { profitability, titleEconomics, unitEconomics } from "@/domain";
import {
  AuthorizationError,
  listOrganizationsFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";
import {
  loadContextFor,
  loadDataStartFor,
  loadDomainInputFor,
  loadMasterDataFor,
  loadSalesCountsFor,
  loadStockFor,
  loadSyncInfoFor,
  loadTodosFor,
  type Viewer,
} from "@/server/data/core/loaders";
import {
  queryAgreements,
  queryInvestments,
  queryOrders,
  queryPrices,
  querySettings,
} from "@/server/data/core/queries";

import { createMember, seedTenantFixture, type TenantFixture, type TestUser } from "./helpers";

const MARCH = { start: "2025-03-01", end: "2025-03-31" };
const FEBRUARY = { start: "2025-02-01", end: "2025-02-28" };
const NOW = new Date("2025-03-12T09:00:00Z");

/** Nycklar som bara får förekomma i ekonomidata. */
const ECONOMY_KEYS =
  /"(amountOre|unitCostOre|monthlyRentOre|commissionBp|vatRateBp|cardFeeBp|revenueOre|atStakeOre|prices|agreements|settings)"\s*:\s*(?!null)/;

function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fx: TenantFixture;
let owner: Viewer;
let refiller: Viewer;
let reader: Viewer;
let otherOwner: Viewer;

beforeAll(async () => {
  fx = await seedTenantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  const other = await seedTenantFixture();
  otherOwner = await viewerFor(other.owner, other.orgId);
});

describe("loadContextFor", () => {
  it("ger ägaren roll, inställningar och dagens affärsdatum i organisationens tidszon", async () => {
    const ctx = await loadContextFor(owner, [owner.organization], NOW);
    expect(ctx.role).toBe("owner");
    expect(ctx.canSeeEconomy).toBe(true);
    expect(ctx.canEdit).toBe(true);
    expect(ctx.settings).toEqual({ vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1 });
    expect(ctx.timeZone).toBe("Europe/Stockholm");
    expect(ctx.today).toBe("2025-03-12");
    expect(ctx.user.displayName).not.toBeNull();
  });

  it("ger påfyllaren inga inställningar och ingen ekonomi", async () => {
    const ctx = await loadContextFor(refiller, [refiller.organization], NOW);
    expect(ctx.role).toBe("refiller");
    expect(ctx.canSeeEconomy).toBe(false);
    expect(ctx.canEdit).toBe(false);
    expect(ctx.settings).toBeNull();
  });

  it("nekar en användare från en annan organisation", async () => {
    const intruder: Viewer = { user: otherOwner.user, organization: owner.organization };
    await expect(loadContextFor(intruder, [], NOW)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("loadDomainInputFor", () => {
  it("ger exakt det beräkningarna behöver för perioden och jämförelsen", async () => {
    const input = await loadDomainInputFor(owner, { period: MARCH, compare: FEBRUARY }, NOW);
    expect(input.current.period).toEqual(MARCH);
    expect(input.current.orders.map((o) => o.externalId).sort()).toEqual(["42001", "42002"]);
    expect(input.current.orders[0]).toMatchObject({
      machineId: fx.machineId,
      businessDate: "2025-03-10",
      amountOre: 7900,
      orderedAt: "2025-03-10T10:00:00.000Z",
    });
    expect(input.previous?.orders).toEqual([]);
    expect(input.previous?.period).toEqual(FEBRUARY);
    expect(input.current.prices).toHaveLength(2);
    expect(input.current.agreements).toEqual([
      {
        storeId: fx.storeId,
        validFrom: "2025-01-01",
        validTo: null,
        commissionBp: 2000,
        monthlyRentOre: null,
        commissionBase: "net_excl_vat",
        lossTreatment: "zero",
        vmbBeforeSplit: false,
      },
    ]);
    expect(input.current.refunds).toEqual([]);
    expect(input.current.placements).toHaveLength(1);
    expect(input.investments).toHaveLength(1);
    expect(input.titles.length).toBeGreaterThanOrEqual(3);
    expect(input.machines[0]).toMatchObject({ id: fx.machineId, storeId: fx.storeId });
    expect(input.diagnostics).toEqual({ ordersWithoutTitle: 0, ordersWithoutMachine: 0 });

    // Indata går rakt in i beräkningslagret.
    const result = profitability(input.current, "machine");
    expect(result.totals.orders).toBe(2);
    expect(result.totals.revenueOre).toBe(16_800);
    // 7 900 + 8 900 − (4 500 + 5 200) − 20 % provision (1 580 + 1 780)
    expect(result.totals.profitOre).toBe(16_800 - 9_700 - 3_360);
    expect(titleEconomics(input.current)).toHaveLength(2);
    expect(unitEconomics({ ...input.current, investments: input.investments })).toHaveLength(1);
  });

  it("filtrerar på butik och automat utan att ta med andra butikers avtal", async () => {
    const store = await loadDomainInputFor(owner, { period: MARCH, storeId: fx.storeId }, NOW);
    expect(store.current.orders).toHaveLength(2);
    expect(store.scope).toEqual({ storeId: fx.storeId, machineId: null });

    const elsewhere = await loadDomainInputFor(
      owner,
      { period: MARCH, storeId: randomUUID() },
      NOW,
    );
    expect(elsewhere.current.orders).toEqual([]);
    expect(elsewhere.current.agreements).toEqual([]);
    expect(elsewhere.current.placements).toEqual([]);
    expect(elsewhere.investments).toEqual([]);

    const machine = await loadDomainInputFor(
      owner,
      { period: MARCH, machineId: fx.machineId.toUpperCase() },
      NOW,
    );
    expect(machine.current.orders).toHaveLength(2);
    expect(machine.scope.machineId).toBe(fx.machineId);
    expect(machine.current.agreements).toHaveLength(1);
  });

  it("fungerar för läsaren", async () => {
    const input = await loadDomainInputFor(reader, { period: MARCH }, NOW);
    expect(input.current.orders).toHaveLength(2);
    expect(input.previous).toBeNull();
  });

  it("nekar påfyllaren", async () => {
    await expect(loadDomainInputFor(refiller, { period: MARCH }, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("nekar en annan organisations ägare", async () => {
    const intruder: Viewer = { user: otherOwner.user, organization: owner.organization };
    await expect(loadDomainInputFor(intruder, { period: MARCH }, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("påfyllaren får aldrig ekonomi", () => {
  it("RLS ger tomma resultat även om rollkontrollen kringgås", async () => {
    const result = await withUserDbFor(refiller.user, async (tx) => ({
      orders: await queryOrders(tx, fx.orgId, MARCH, { storeId: null, machineId: null }),
      prices: await queryPrices(tx, fx.orgId),
      agreements: await queryAgreements(tx, fx.orgId),
      investments: await queryInvestments(tx, fx.orgId),
      settings: await querySettings(tx, fx.orgId),
    }));
    expect(result.orders.orders).toEqual([]);
    expect(result.prices).toEqual([]);
    expect(result.agreements).toEqual([]);
    expect(result.investments).toEqual([]);
    // Ingen rad läsbar: standardvärdena, inte organisationens.
    expect(result.settings).toEqual({ vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1 });
  });

  it("lager, försäljning i antal, stamdata och Att göra innehåller inga belopp", async () => {
    const stock = await loadStockFor(refiller);
    const sales = await loadSalesCountsFor(refiller, { period: MARCH });
    const master = await loadMasterDataFor(refiller, NOW);
    const todos = await loadTodosFor(refiller, NOW);
    const sync = await loadSyncInfoFor(refiller, NOW);

    expect(sales.units).toBe(2);
    for (const row of sales.rows) {
      expect(Object.keys(row).sort()).toEqual(["date", "machineId", "titleId", "units"]);
    }
    expect(stock.machineStock.length).toBeGreaterThan(0);
    expect(master.machines).toHaveLength(1);
    expect(sync).toBeNull();
    for (const t of todos) {
      expect(["refill", "stale-machine"]).toContain(t.kind);
      expect(t.atStakeOre).toBeNull();
      expect(t.evidence.figures.every((f) => f.unit !== "ore")).toBe(true);
      expect(t.detail).not.toMatch(/kr\b/);
    }
    const payload = JSON.stringify({ stock, sales, master, todos });
    expect(payload).not.toMatch(ECONOMY_KEYS);
    expect(payload).not.toContain("7900");
    expect(payload).not.toContain("8900");
  });

  it("'Allt' börjar vid första försäljningen i lagret för påfyllaren och första ordern för ägaren", async () => {
    expect(await loadDataStartFor(refiller)).toBe("2025-03-10");
    expect(await loadDataStartFor(owner)).toBe("2025-03-10");
  });
});

describe("lager och försäljning i antal", () => {
  it("ger saldon per lagerplats med senaste påfyllning", async () => {
    const stock = await loadStockFor(owner);
    const level = stock.machineStock.find(
      (r) => r.machineId === fx.machineId && r.titleId === fx.titleId,
    );
    // Inventering 10 den 5 mars, sedan en försäljning den 10 mars.
    expect(level?.onHand).toBe(9);
    expect(level?.lastRestockedAt).toBe("2025-03-05T08:00:00.000Z");
    expect(stock.warehouse.every((r) => r.isCentral)).toBe(true);
  });

  it("räknar sålda pack per dag och filtrerar på butik", async () => {
    const all = await loadSalesCountsFor(owner, { period: MARCH });
    expect(all.rows).toEqual(
      expect.arrayContaining([
        { date: "2025-03-10", titleId: fx.titleId, machineId: fx.machineId, units: 1 },
        { date: "2025-03-11", titleId: fx.secondTitleId, machineId: fx.machineId, units: 1 },
      ]),
    );
    const none = await loadSalesCountsFor(owner, { period: MARCH, storeId: randomUUID() });
    expect(none.units).toBe(0);
    const store = await loadSalesCountsFor(owner, { period: MARCH, storeId: fx.storeId });
    expect(store.units).toBe(2);
  });
});

describe("synk och Att göra", () => {
  it("ger synkstatus för ägaren", async () => {
    const sync = await loadSyncInfoFor(owner, NOW);
    expect(sync).toMatchObject({ sources: 1, syncedAt: null, state: "stale" });
  });

  it("räknar Att göra för ägaren och ger läsaren en tom lista", async () => {
    const todos = await loadTodosFor(owner, NOW);
    expect(Array.isArray(todos)).toBe(true);
    expect(await loadTodosFor(reader, NOW)).toEqual([]);
  });
});
