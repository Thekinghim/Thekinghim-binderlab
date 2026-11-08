/**
 * Försäljning i lagret, saldon och orderns oföränderlighet.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "../../src/db/schema";
import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  db,
  one,
  rows,
  seedTenantFixture,
  settle,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;
let refiller: TestUser;

beforeAll(async () => {
  F = await seedTenantFixture();
  refiller = await createMember(F.orgId, "refiller");
});

function newOrder(overrides: Partial<typeof s.orders.$inferInsert> = {}) {
  return {
    organizationId: F.orgId,
    dataSourceId: F.dataSourceId,
    externalId: `o-${randomUUID().slice(0, 8)}`,
    rawTitle: "Pokemon 151",
    titleId: F.titleId,
    orderedAt: new Date("2025-06-01T09:00:00Z"),
    amountOre: 7900,
    machineId: F.machineId,
    sourceHash: "h",
    ...overrides,
  } satisfies typeof s.orders.$inferInsert;
}

describe("försäljning → lagerhändelse", () => {
  it("en order med automat skapar en sale-händelse på automatens lagerplats, utan belopp", async () => {
    const [order] = await asUser(F.owner, (tx) =>
      tx.insert(s.orders).values(newOrder()).returning(),
    );
    const event = await one<Record<string, unknown>>(
      db(),
      sql`select * from public.stock_events where order_id = ${order!.id}`,
    );
    expect(event).toMatchObject({
      kind: "sale",
      quantity: -1,
      location_id: F.machineLocationId,
      title_id: F.titleId,
      business_date: order!.businessDate,
      performed_by: null,
    });
    expect(Object.keys(event).some((k) => /ore|amount/.test(k))).toBe(false);
  });

  it("utan automat skapas ingen händelse förrän källautomaten kopplas", async () => {
    const sourceMachine = await asUser(F.owner, async (tx) => {
      const [sm] = await tx
        .insert(s.sourceMachines)
        .values({
          organizationId: F.orgId,
          dataSourceId: F.dataSourceId,
          externalId: `AW-${randomUUID().slice(0, 4)}`,
        })
        .returning();
      await tx
        .insert(s.orders)
        .values(newOrder({ machineId: null, sourceMachineId: sm!.id, externalId: "unmapped-1" }));
      return sm!;
    });
    const before = await rows(
      db(),
      sql`select 1 from public.stock_events e join public.orders o on o.id = e.order_id
          where o.organization_id = ${F.orgId} and o.external_id = 'unmapped-1'`,
    );
    expect(before).toHaveLength(0);

    await asUser(F.owner, (tx) =>
      tx.execute(
        sql`update public.source_machines set machine_id = ${F.machineId} where id = ${sourceMachine.id}`,
      ),
    );
    const after = await one<{ machine_id: string; events: number }>(
      db(),
      sql`select o.machine_id, (select count(*)::int from public.stock_events e where e.order_id = o.id) as events
          from public.orders o where o.organization_id = ${F.orgId} and o.external_id = 'unmapped-1'`,
    );
    expect(after).toEqual({ machine_id: F.machineId, events: 1 });
  });

  it("en order utan titel får sin händelse när titeln kopplas", async () => {
    const [order] = await asUser(F.owner, (tx) =>
      tx
        .insert(s.orders)
        .values(newOrder({ titleId: null, rawTitle: "Okänd titel" }))
        .returning(),
    );
    expect(
      await rows(db(), sql`select 1 from public.stock_events where order_id = ${order!.id}`),
    ).toHaveLength(0);
    await asUser(F.owner, (tx) =>
      tx.execute(
        sql`update public.orders set title_id = ${F.secondTitleId} where id = ${order!.id}`,
      ),
    );
    const event = await one<{ title_id: string }>(
      db(),
      sql`select title_id from public.stock_events where order_id = ${order!.id}`,
    );
    expect(event.title_id).toBe(F.secondTitleId);
  });
});

describe("en importerad order ändras inte", () => {
  it("belopp, tid och källa kan inte ändras (inte ens av systemet)", async () => {
    const asOwner = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.orders set amount_ore = 1 where id = ${F.orderIds[0]!}`),
      ),
    );
    expect(asOwner.code).toBe("42501");
    const asSystem = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.orders set amount_ore = 1, ordered_at = now() where id = ${F.orderIds[0]!}`,
        ),
      ),
    );
    expect(asSystem.code).toBe("BL007");
  });

  it("automaten kan inte bytas och titeln kan inte tas bort", async () => {
    const machine = await asUser(F.owner, async (tx) => {
      const [m] = await tx
        .insert(s.machines)
        .values({ organizationId: F.orgId, code: "BL-002", name: "Automat 2" })
        .returning();
      return attempt(tx, (sp) =>
        sp.execute(
          sql`update public.orders set machine_id = ${m!.id} where id = ${F.orderIds[0]!}`,
        ),
      );
    });
    expect(machine.code).toBe("BL007");
    const title = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.orders set title_id = null where id = ${F.orderIds[0]!}`),
      ),
    );
    expect(title.code).toBe("BL007");
  });

  it("samma order (källa + order-nr) kan inte importeras två gånger", async () => {
    const order = newOrder({ externalId: "dup-1" });
    await asUser(F.owner, (tx) => tx.insert(s.orders).values(order));
    const again = await asUser(F.owner, (tx) =>
      tx
        .insert(s.orders)
        .values({ ...order, sourceHash: "changed" })
        .onConflictDoNothing()
        .returning(),
    );
    expect(again).toHaveLength(0);
  });
});

describe("saldon (stock_levels)", () => {
  async function levels(user: TestUser) {
    return asUser(user, (tx) =>
      tx
        .select({
          locationId: s.stockLevels.locationId,
          titleId: s.stockLevels.titleId,
          quantity: s.stockLevels.quantity,
        })
        .from(s.stockLevels)
        .where(sql`${s.stockLevels.organizationId} = ${F.orgId}`),
    );
  }

  it("räknar senaste inventering plus händelserna efter den", async () => {
    const fx = await seedTenantFixture();
    const result = await asUser(fx.owner, (tx) =>
      tx
        .select()
        .from(s.stockLevels)
        .where(sql`${s.stockLevels.organizationId} = ${fx.orgId}`),
    );
    const level = (location: string, title: string) =>
      result.find((r) => r.locationId === location && r.titleId === title)?.quantity;
    // Automat, titel 1: påfyllning 10, inventering 10, försäljning −1.
    expect(level(fx.machineLocationId, fx.titleId)).toBe(9);
    // Automat, titel 2: flytt in 5, försäljning −1.
    expect(level(fx.machineLocationId, fx.secondTitleId)).toBe(4);
    // Centrallager: inleverans 36 av titel 1, flytt ut 5 av titel 2.
    expect(level(fx.centralLocationId, fx.titleId)).toBe(36);
    expect(level(fx.centralLocationId, fx.secondTitleId)).toBe(-5);

    const warehouse = await asUser(fx.owner, (tx) =>
      tx
        .select()
        .from(s.warehouseStock)
        .where(sql`${s.warehouseStock.organizationId} = ${fx.orgId}`),
    );
    expect(warehouse.every((w) => w.locationId === fx.centralLocationId)).toBe(true);
    // Titel 1 och 2, och fixturens mystery pack (delen 0, mystery-packet 1).
    expect(warehouse).toHaveLength(4);
  });

  it("en inventering ersätter allt före den", async () => {
    await asUser(refiller, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: F.orgId,
        locationId: F.machineLocationId,
        titleId: F.secondTitleId,
        kind: "count",
        quantity: 20,
        performedBy: refiller.id,
        occurredAt: new Date("2026-01-01T08:00:00Z"),
      }),
    );
    const own = await levels(F.owner);
    expect(
      own.find((l) => l.locationId === F.machineLocationId && l.titleId === F.secondTitleId)
        ?.quantity,
    ).toBe(20);
  });

  it("påfyllarens saldon stämmer med ägarens", async () => {
    const sort = (l: { locationId: string; titleId: string; quantity: number }[]) =>
      [...l].sort((a, b) =>
        `${a.locationId}${a.titleId}`.localeCompare(`${b.locationId}${b.titleId}`),
      );
    const own = await levels(F.owner);
    const theirs = await levels(refiller);
    expect(own.length).toBeGreaterThan(0);
    expect(sort(theirs)).toEqual(sort(own));
  });

  it("påfyllaren ser försäljningen men aldrig ordern eller beloppet", async () => {
    const visible = await asUser(refiller, async (tx) => ({
      sales: (
        await one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.stock_events where kind = 'sale'`,
        )
      ).n,
      orders: (await one<{ n: number }>(tx, sql`select count(*)::int as n from public.orders`)).n,
    }));
    expect(visible.sales).toBeGreaterThan(0);
    expect(visible.orders).toBe(0);
  });

  it("en flytt som inte går jämnt ut nekas vid commit", async () => {
    const outcome = await settle(
      asUser(refiller, (tx) =>
        tx.insert(s.stockEvents).values({
          organizationId: F.orgId,
          locationId: F.centralLocationId,
          titleId: F.titleId,
          kind: "transfer_out",
          quantity: -3,
          transferGroupId: randomUUID(),
          performedBy: refiller.id,
        }),
      ),
    );
    expect(outcome.code).toBe("BL017");
  });

  it("inleverans kan inte minska", async () => {
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.purchase_order_lines set received_quantity = 1 where organization_id = ${F.orgId}`,
        ),
      ),
    );
    expect(outcome.code).toBe("22023");
  });
});
