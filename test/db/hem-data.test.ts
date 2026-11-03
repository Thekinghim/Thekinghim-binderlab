/**
 * Hem mot testdatabasen: loadHomeWith med de gemensamma "For"-laddarna (RLS + roll ur
 * databasen). Påfyllaren får ingenting (inte ens ett anrop till ekonomiladdaren),
 * läsaren får ekonomi men ingen Att göra, och modellen går att skicka till klienten.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadHomeWith, type HomeLoaders } from "@/app/(app)/_hem/data";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import {
  loadContextFor,
  loadDataStartFor,
  loadDomainInputFor,
  loadTodosFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { resolveAppPeriod } from "@/server/data/core/period";
import { keyMetrics } from "@/domain";

import * as s from "@/db/schema";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const MARCH = { from: "2025-03-01", to: "2025-03-31" };

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function loadersFor(viewer: Viewer): HomeLoaders & { domainInput: ReturnType<typeof vi.fn> } {
  const domainInput = vi.fn((args: Parameters<HomeLoaders["domainInput"]>[0]) =>
    loadDomainInputFor(viewer, args, NOW),
  );
  return {
    context: () => loadContextFor(viewer, [viewer.organization], NOW),
    period: async (sp) =>
      resolveAppPeriod(sp, {
        timeZone: viewer.organization.timezone,
        dataStart: await loadDataStartFor(viewer),
        now: NOW,
      }),
    domainInput,
    todos: () => loadTodosFor(viewer, NOW),
  };
}

interface HomeFixture {
  readonly orgId: string;
  readonly owner: TestUser;
}

/**
 * En egen liten organisation (oberoende av seedTenantFixture): en butik med provision,
 * en automat, två titlar med pris och två order 10 och 11 mars 2025, skrivet som ägaren.
 */
async function seedHomeFixture(): Promise<HomeFixture> {
  const owner = await createUser(`hem-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Hem ${uniqueSuffix()}`);
  await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Hem" })
      .returning();
    await tx
      .insert(s.storeAgreements)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 2000 });
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [a, b] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster" },
        { ...org, name: "Surging Sparks Booster" },
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
    const base = {
      ...org,
      dataSourceId: source!.id,
      machineId: machine!.id,
      paymentMethod: "card",
    };
    await tx.insert(s.orders).values([
      {
        ...base,
        externalId: "1",
        rawTitle: "Pokemon 151",
        titleId: a!.id,
        orderedAt: new Date("2025-03-10T10:00:00Z"),
        amountOre: 7900,
        sourceHash: "h1",
      },
      {
        ...base,
        externalId: "2",
        rawTitle: "Surging Sparks",
        titleId: b!.id,
        orderedAt: new Date("2025-03-11T10:00:00Z"),
        amountOre: 8900,
        sourceHash: "h2",
      },
    ]);
  });
  return { orgId, owner };
}

let fx: HomeFixture;
let owner: Viewer;
let refiller: Viewer;
let reader: Viewer;
let otherOwner: Viewer;

beforeAll(async () => {
  fx = await seedHomeFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  const other = await seedHomeFixture();
  otherOwner = await viewerFor(other.owner, other.orgId);
});

describe("loadHomeWith", () => {
  it("ger ägaren nyckeltal ur organisationens order, med Att göra", async () => {
    const data = await loadHomeWith(loadersFor(owner), MARCH);
    const { model } = data;
    expect(data.canEdit).toBe(true);
    expect(data.today).toBe("2025-03-12");
    // Perioden kapas vid i dag; datan börjar med första ordern (10 mars).
    expect(model.period).toEqual({ start: "2025-03-01", end: "2025-03-12" });
    expect(model.coverage?.start).toBe("2025-03-10");
    expect(model.kpis.find((k) => k.id === "orders")?.value).toBe(2);
    expect(model.kpis.find((k) => k.id === "revenue")?.value).toBe(7_900 + 8_900);
    expect(model.headline.state).toBe("ok");
    expect(model.headline.title).toMatch(/^168 kr /);
    expect(model.todos).not.toBeNull();
    expect(model.topTitles.rows.length).toBeGreaterThan(0);
  });

  it("ger en modell som kan skickas till klienten (bara tal, strängar, listor)", async () => {
    const { model } = await loadHomeWith(loadersFor(owner), MARCH);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it("ger läsaren ekonomi men ingen Att göra", async () => {
    const data = await loadHomeWith(loadersFor(reader), MARCH);
    expect(data.canEdit).toBe(false);
    expect(data.model.todos).toBeNull();
    expect(data.model.kpis.find((k) => k.id === "revenue")?.value).toBe(16_800);
  });

  it("nekar påfyllaren innan någon ekonomi läses", async () => {
    const loaders = loadersFor(refiller);
    await expect(loadHomeWith(loaders, MARCH)).rejects.toBeInstanceOf(AuthorizationError);
    expect(loaders.domainInput).not.toHaveBeenCalled();
  });

  it("nekar påfyllaren även om rollkontrollen i sidan kringgås", async () => {
    const loaders = loadersFor(refiller);
    // Låtsas att kontexten säger ekonomi: laddaren kontrollerar rollen själv mot databasen.
    const ctx = await loaders.context();
    loaders.context = async () => ({ ...ctx, canSeeEconomy: true });
    await expect(loadHomeWith(loaders, MARCH)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("visar bara den egna organisationens data", async () => {
    const mine = await loadHomeWith(loadersFor(owner), MARCH);
    const theirs = await loadHomeWith(loadersFor(otherOwner), MARCH);
    const myTitles = new Set(mine.model.topTitles.rows.map((r) => r.id));
    expect(theirs.model.topTitles.rows.some((r) => myTitles.has(r.id))).toBe(false);
  });

  it("filtrerar på automat och visar automatens namn", async () => {
    const base = await loadHomeWith(loadersFor(owner), MARCH);
    expect(base.scope).toBeNull();
    const input = await loadDomainInputFor(
      owner,
      { period: { start: "2025-03-01", end: "2025-03-12" } },
      NOW,
    );
    const machine = input.machines[0];
    expect(machine).toBeDefined();
    const data = await loadHomeWith(loadersFor(owner), { ...MARCH, automat: machine!.id });
    expect(data.scope).toMatchObject({
      kind: "machine",
      id: machine!.id,
      code: "BL-001",
      missing: false,
    });
    expect(data.model.kpis.find((k) => k.id === "orders")?.value).toBe(2);
  });

  it("säger att automaten saknas när filtret pekar på en annan organisations automat", async () => {
    const theirs = await loadDomainInputFor(
      otherOwner,
      { period: { start: "2025-03-01", end: "2025-03-12" } },
      NOW,
    );
    const foreign = theirs.machines[0];
    expect(foreign).toBeDefined();
    const data = await loadHomeWith(loadersFor(owner), { ...MARCH, automat: foreign!.id });
    expect(data.scope).toMatchObject({ kind: "machine", missing: true });
    expect(data.model.kpis.find((k) => k.id === "orders")?.value).toBe(0);
    expect(data.model.daily).toBeNull();
  });

  it("räknar vinsten på hela perioden, samma som beräkningslagret för perioden", async () => {
    const { model } = await loadHomeWith(loadersFor(owner), MARCH);
    const input = await loadDomainInputFor(owner, { period: model.period }, NOW);
    const km = keyMetrics(input.current);
    expect(model.kpis.find((k) => k.id === "profit")?.value).toBe(km.profitOre);
    expect(model.kpis.find((k) => k.id === "margin")?.value).toBe(km.marginBp);
  });
});

describe("loadHomeWith: i dag hittills", () => {
  /** En organisation med order kl. 09 tre onsdagar bakåt och kl. 09.30 i dag (onsdag 12 mars). */
  async function seedPaceFixture(): Promise<Viewer> {
    const u = await createUser(`takt-${uniqueSuffix()}@test.binderlab.se`);
    const orgId = await createOrg(u, `Takt ${uniqueSuffix()}`);
    await asUser(u, async (tx) => {
      const org = { organizationId: orgId };
      const [machine] = await tx
        .insert(s.machines)
        .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
        .returning();
      const [title] = await tx
        .insert(s.titles)
        .values({ ...org, name: "Pokémon 151 Booster" })
        .returning();
      const [source] = await tx
        .insert(s.dataSources)
        .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
        .returning();
      const at = [
        "2025-02-19T08:00:00Z",
        "2025-02-26T08:00:00Z",
        "2025-02-26T15:00:00Z",
        "2025-03-05T08:00:00Z",
        "2025-03-12T08:30:00Z",
      ];
      await tx.insert(s.orders).values(
        at.map((t, i) => ({
          ...org,
          dataSourceId: source!.id,
          machineId: machine!.id,
          paymentMethod: "card",
          externalId: String(i + 1),
          rawTitle: "Pokemon 151",
          titleId: title!.id,
          orderedAt: new Date(t),
          amountOre: 10_000,
          sourceHash: `t${i}`,
        })),
      );
    });
    return viewerFor(u, orgId);
  }

  it("jämför dagens intäkt med samma klockslag samma veckodag, med samma filter", async () => {
    const viewer = await seedPaceFixture();
    const loaders = loadersFor(viewer);
    const { pace } = await loadHomeWith(loaders, MARCH);
    expect(loaders.domainInput).toHaveBeenCalledWith(
      expect.objectContaining({ period: { start: "2025-01-15", end: "2025-03-12" } }),
    );
    const today = await loadDomainInputFor(
      viewer,
      { period: { start: "2025-03-12", end: "2025-03-12" } },
      NOW,
    );
    const revenueToday = keyMetrics(today.current).revenueOre;
    expect(pace).not.toBeNull();
    expect(pace!.clock).toBe("10:00");
    expect(pace!.comparisonDays).toBe(3);
    expect(pace!.soFarOre).toBe(revenueToday);
    // Hittills: en order per dag, samma belopp som i dag.
    expect(pace!.baselineSoFarOre).toBe(revenueToday);
    expect(pace!.deltaBp).toBe(0);
    // Hela dagar: 4 order på 3 dagar.
    expect(pace!.baselineFullOre).toBe(Math.round((4 * revenueToday) / 3));
    expect(JSON.parse(JSON.stringify(pace))).toEqual(pace);
  });

  it("visas inte när perioden ligger helt bakåt i tiden", async () => {
    const viewer = await seedPaceFixture();
    const loaders = loadersFor(viewer);
    const { pace } = await loadHomeWith(loaders, { from: "2025-02-01", to: "2025-02-28" });
    expect(pace).toBeNull();
    expect(loaders.domainInput).not.toHaveBeenCalledWith(
      expect.objectContaining({ period: { start: "2025-01-15", end: "2025-03-12" } }),
    );
  });

  it("har inget att jämföra med för en organisation med två dagars data", async () => {
    const { pace } = await loadHomeWith(loadersFor(owner), MARCH);
    expect(pace).toBeNull();
  });
});
