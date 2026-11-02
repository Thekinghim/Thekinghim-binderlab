/**
 * Lager (src/app/(app)/lager) mot testdatabasen: laddaren och registreringen av
 * påfyllning och inventering, som ägare, påfyllare och läsare.
 *
 * Viktigast: påfyllaren får aldrig belopp i det som skickas till klienten, och
 * registreringen kräver rätt roll både i koden och i databasen.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { loadLagerFor } from "@/app/(app)/lager/_lib/data";
import { LagerError, registerCountFor, registerRefillFor } from "@/app/(app)/lager/_lib/register";
import { countSchema, refillSchema } from "@/app/(app)/lager/_lib/schemas";
import * as s from "@/db/schema";
import { AuthorizationError, listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

import { asUser, createMember, createOrg, createUser, db, rows, type TestUser } from "./helpers";

interface LagerFixture {
  orgId: string;
  owner: TestUser;
  machineId: string;
  machineLocationId: string;
  centralLocationId: string;
  titleId: string;
  secondTitleId: string;
}

/**
 * En organisation med en butik, en automat, två titlar och lagerhändelser, skrivet som
 * ägaren genom RLS. Egen fixtur (inte seedTenantFixture), så att testet bara beror på
 * lagret och stamdatan.
 */
async function seedLagerFixture(): Promise<LagerFixture> {
  const owner = await createUser(`lager-agare-${crypto.randomUUID()}@test.binderlab.se`);
  const orgId = await createOrg(owner, "Lagertest");
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Testbutik" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title, second] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Black Bolt" },
        { ...org, name: "Surging Sparks" },
      ])
      .returning();
    const locations = await tx.select().from(s.stockLocations);
    const central = locations.find((l) => l.organizationId === orgId && l.isCentral);
    const machineLocation = locations.find(
      (l) => l.organizationId === orgId && l.machineId === machine!.id,
    );
    await tx.insert(s.stockEvents).values([
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: title!.id,
        kind: "count",
        quantity: 10,
        occurredAt: new Date("2025-03-05T08:00:00Z"),
      },
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: second!.id,
        kind: "refill",
        quantity: 5,
        occurredAt: new Date("2025-03-05T08:10:00Z"),
      },
    ]);
    return {
      orgId,
      owner,
      machineId: machine!.id,
      machineLocationId: machineLocation!.id,
      centralLocationId: central!.id,
      titleId: title!.id,
      secondTitleId: second!.id,
    };
  });
}

/** Nycklar och texter som bara får förekomma i ekonomidata. */
const ECONOMY =
  /"(amountOre|unitCostOre|monthlyRentOre|commissionBp|vatRateBp|cardFeeBp|revenueOre|profitOre|atStakeOre|prices|agreements|settings|investments)"|\d\s?kr\b/;

function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const NOW = new Date("2025-03-12T09:00:00Z");
const ALL_TIME = { start: "2025-01-01", end: "2030-12-31" };
const NO_SCOPE = { storeId: null, machineId: null };

let fx: LagerFixture;
let owner: Viewer;
let refiller: Viewer;
let reader: Viewer;
let outsider: Viewer;

beforeAll(async () => {
  fx = await seedLagerFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  const other = await seedLagerFixture();
  outsider = await viewerFor(other.owner, other.orgId);
  // Känt saldo i centrallagret: 20 pack av titeln.
  await asUser(fx.owner, (tx) =>
    tx.insert(s.stockEvents).values({
      organizationId: fx.orgId,
      locationId: fx.centralLocationId,
      titleId: fx.titleId,
      kind: "count",
      quantity: 20,
      occurredAt: new Date("2025-03-06T08:00:00Z"),
    }),
  );
});

describe("loadLagerFor", () => {
  it("ger påfyllaren matrisen, centrallagret och historiken utan ett enda belopp", async () => {
    const view = await loadLagerFor(refiller, { period: ALL_TIME, scope: NO_SCOPE }, NOW);
    expect(view.machines.map((m) => m.id)).toEqual([fx.machineId]);
    expect(view.canRegister).toBe(true);
    const i = view.titles.findIndex((t) => t.id === fx.titleId);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(view.cells[i]?.[0]).toMatchObject({ machineId: fx.machineId, stocked: true });
    expect(view.warehouse.find((w) => w.titleId === fx.titleId)?.onHand).toBe(20);
    expect(view.history.length).toBeGreaterThan(0);

    const json = JSON.stringify(view);
    expect(json).not.toMatch(ECONOMY);
    expect(json).not.toContain("externalId");
  });

  it("ger läsaren samma vy men utan rätt att registrera", async () => {
    const view = await loadLagerFor(reader, { period: ALL_TIME, scope: NO_SCOPE }, NOW);
    expect(view.canRegister).toBe(false);
    expect(view.machines).toHaveLength(1);
  });

  it("nekar en användare från en annan organisation", async () => {
    const intruder: Viewer = { user: outsider.user, organization: owner.organization };
    await expect(
      loadLagerFor(intruder, { period: ALL_TIME, scope: NO_SCOPE }, NOW),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("filtrerar på automat", async () => {
    const view = await loadLagerFor(
      owner,
      { period: ALL_TIME, scope: { storeId: null, machineId: fx.machineId } },
      NOW,
    );
    expect(view.machines.map((m) => m.id)).toEqual([fx.machineId]);
    const none = await loadLagerFor(
      owner,
      { period: ALL_TIME, scope: { storeId: null, machineId: crypto.randomUUID() } },
      NOW,
    );
    expect(none.machines).toEqual([]);
  });
});

describe("registerRefillFor", () => {
  it("fyller på från centrallagret, ger nytt saldo och loggar i audit_log", async () => {
    const before = await loadLagerFor(refiller, { period: ALL_TIME, scope: NO_SCOPE }, NOW);
    const i = before.titles.findIndex((t) => t.id === fx.titleId);
    const start = before.cells[i]![0]!.onHand;

    const result = await registerRefillFor(
      refiller,
      refillSchema.parse({
        machineId: fx.machineId,
        titleId: fx.titleId,
        quantity: 6,
        fromWarehouse: true,
      }),
    );
    expect(result).toEqual({ previous: start, onHand: start + 6, warehouseOnHand: 14 });

    const audit = await rows<{ action: string; actor_id: string }>(
      db(),
      sql`select action::text as action, actor_id::text as actor_id from public.audit_log
          where organization_id = ${fx.orgId}::uuid and table_name = 'stock_events'
            and actor_id = ${refiller.user.userId}::uuid`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);

    const after = await loadLagerFor(refiller, { period: ALL_TIME, scope: NO_SCOPE }, NOW);
    const latest = after.history[0];
    expect(latest).toMatchObject({
      kind: "refill",
      quantity: 6,
      isSelf: true,
      fromWarehouse: true,
      machineId: fx.machineId,
    });
    // Uttaget ur centrallagret står på påfyllningsraden, inte som egen rad.
    expect(after.history.some((h) => h.kind === "adjustment")).toBe(false);
  });

  it("stoppar en påfyllning som är större än centrallagret", async () => {
    await expect(
      registerRefillFor(refiller, {
        machineId: fx.machineId,
        titleId: fx.titleId,
        quantity: 500,
        fromWarehouse: true,
      }),
    ).rejects.toThrow(LagerError);
  });

  it("tillåter påfyllning utan centrallagret", async () => {
    const r = await registerRefillFor(owner, {
      machineId: fx.machineId,
      titleId: fx.secondTitleId,
      quantity: 2,
      fromWarehouse: false,
    });
    expect(r.onHand).toBe(r.previous + 2);
    expect(r.warehouseOnHand).toBeNull();
  });

  it("nekar läsaren och en annan organisations ägare", async () => {
    const input = {
      machineId: fx.machineId,
      titleId: fx.titleId,
      quantity: 1,
      fromWarehouse: false,
    };
    await expect(registerRefillFor(reader, input)).rejects.toBeInstanceOf(AuthorizationError);
    const intruder: Viewer = { user: outsider.user, organization: owner.organization };
    await expect(registerRefillFor(intruder, input)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("registerCountFor", () => {
  it("inventerar en automat: räknat antal blir saldot", async () => {
    const r = await registerCountFor(
      refiller,
      countSchema.parse({
        location: "machine",
        machineId: fx.machineId,
        titleId: fx.titleId,
        counted: 4,
      }),
    );
    expect(r.onHand).toBe(4);
    const level = await rows<{ quantity: number }>(
      db(),
      sql`select sl.quantity from public.stock_levels sl
          where sl.location_id = ${fx.machineLocationId}::uuid and sl.title_id = ${fx.titleId}::uuid`,
    );
    expect(level[0]?.quantity).toBe(4);
  });

  it("inventerar centrallagret", async () => {
    const r = await registerCountFor(refiller, {
      location: "warehouse",
      titleId: fx.secondTitleId,
      counted: 9,
    });
    expect(r).toMatchObject({ onHand: 9, warehouseOnHand: null });
  });

  it("nekar läsaren", async () => {
    await expect(
      registerCountFor(reader, { location: "warehouse", titleId: fx.titleId, counted: 1 }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("avvisar ogiltiga antal i valideringen", () => {
    expect(() =>
      countSchema.parse({ location: "warehouse", titleId: fx.titleId, counted: -1 }),
    ).toThrow();
    expect(() =>
      refillSchema.parse({
        machineId: fx.machineId,
        titleId: fx.titleId,
        quantity: 0,
        fromWarehouse: true,
      }),
    ).toThrow();
  });
});

describe("lager_performers", () => {
  it("ger påfyllaren namnen på dem som registrerat, men inte en utomstående", async () => {
    const names = await asUser({ id: refiller.user.userId, email: refiller.user.email }, (tx) =>
      tx.execute(
        sql`select user_id::text as user_id, display_name from public.lager_performers(${fx.orgId}::uuid)`,
      ),
    );
    const list = Array.from(names) as { user_id: string; display_name: string | null }[];
    expect(list.map((n) => n.user_id)).toContain(refiller.user.userId);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["display_name", "user_id"]);

    await expect(
      asUser({ id: outsider.user.userId, email: outsider.user.email }, (tx) =>
        tx.execute(sql`select * from public.lager_performers(${fx.orgId}::uuid)`),
      ),
    ).rejects.toThrow();
  });
});
