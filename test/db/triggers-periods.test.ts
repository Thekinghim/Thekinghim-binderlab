/**
 * Månadsstängning och prisperioder.
 */

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
  type TenantFixture,
  type TestUser,
} from "./helpers";

describe("månadsstängning (mars 2025 stängd)", () => {
  let F: TenantFixture;
  let admin: TestUser;
  let t3: string;

  beforeAll(async () => {
    F = await seedTenantFixture();
    admin = await createMember(F.orgId, "admin");
    t3 = await asUser(F.owner, async (tx) => {
      const [title] = await tx
        .insert(s.titles)
        .values({ organizationId: F.orgId, name: "Prismatic Evolutions" })
        .returning();
      await tx.insert(s.purchasePrices).values([
        { organizationId: F.orgId, titleId: title!.id, unitCostOre: 6000, validFrom: "2025-01-01" },
        { organizationId: F.orgId, titleId: title!.id, unitCostOre: 6200, validFrom: "2025-02-01" },
      ]);
      return title!.id;
    });
    await asUser(F.owner, (tx) =>
      tx.execute(sql`select public.close_period(${F.orgId}, '2025-03-01'::date)`),
    );
  });

  function insertPrice(titleId: string, validFrom: string, unitCostOre = 4900) {
    return asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp
          .insert(s.purchasePrices)
          .values({ organizationId: F.orgId, titleId, unitCostOre, validFrom }),
      ),
    );
  }

  it("sparar en sammanfattning av månaden", async () => {
    const { snapshot } = await one<{ snapshot: { database: Record<string, number> } }>(
      db(),
      sql`select snapshot from public.period_closes where organization_id = ${F.orgId} and month = '2025-03-01'`,
    );
    expect(snapshot.database).toMatchObject({
      order_count: 2,
      revenue_ore: 16_800,
      cost_of_goods_ore: 9_700,
      orders_without_price: 0,
    });
  });

  it("nytt pris med valid_from i stängd månad nekas", async () => {
    expect((await insertPrice(F.titleId, "2025-03-15")).code).toBe("BL004");
  });

  it("nytt pris före stängd månad som skulle gälla in i den nekas", async () => {
    expect((await insertPrice(F.titleId, "2025-02-01")).code).toBe("BL004");
  });

  it("nytt pris före stängd månad som slutar före den är tillåtet", async () => {
    expect((await insertPrice(t3, "2025-01-15")).ok).toBe(true);
  });

  it("nytt pris efter stängd månad är tillåtet", async () => {
    expect((await insertPrice(F.titleId, "2025-04-01")).ok).toBe(true);
  });

  it("ändrat pris som gäller i stängd månad nekas, men en anteckning går bra", async () => {
    const cost = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.purchase_prices set unit_cost_ore = 1 where id = ${F.priceId}`,
        ),
      ),
    );
    expect(cost.code).toBe("BL004");
    const note = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.purchase_prices set note = 'Kontrollerat' where id = ${F.priceId}`,
        ),
      ),
    );
    expect(note.ok).toBe(true);
  });

  it("lagerjustering i stängd månad nekas, efter går bra", async () => {
    const refill = (occurredAt: string) =>
      asUser(F.owner, (tx) =>
        attempt(tx, (sp) =>
          sp.insert(s.stockEvents).values({
            organizationId: F.orgId,
            locationId: F.machineLocationId,
            titleId: F.titleId,
            kind: "refill",
            quantity: 3,
            occurredAt: new Date(occurredAt),
          }),
        ),
      );
    expect((await refill("2025-03-20T10:00:00Z")).code).toBe("BL004");
    // 31 mars 22:30 UTC är 1 april 00:30 i Stockholm: öppen månad.
    expect((await refill("2025-03-31T22:30:00Z")).ok).toBe(true);
  });

  it("en order som importeras sent till stängd månad sparas och flaggas", async () => {
    const [order] = await asUser(F.owner, (tx) =>
      tx
        .insert(s.orders)
        .values({
          organizationId: F.orgId,
          dataSourceId: F.dataSourceId,
          externalId: "late-1",
          rawTitle: "Pokemon 151",
          titleId: F.titleId,
          orderedAt: new Date("2025-03-20T12:00:00Z"),
          amountOre: 7900,
          machineId: F.machineId,
          sourceHash: "late",
        })
        .returning(),
    );
    expect(order!.lateInClosedPeriod).toBe(true);
    expect(order!.businessDate).toBe("2025-03-20");
    const events = await rows(
      db(),
      sql`select 1 from public.stock_events where order_id = ${order!.id} and kind = 'sale'`,
    );
    expect(events).toHaveLength(1);
  });

  it("nytt avtal som täcker stängd månad nekas", async () => {
    const outcome = await asUser(F.owner, async (tx) => {
      const [store] = await tx
        .insert(s.stores)
        .values({ organizationId: F.orgId, name: "Ny butik" })
        .returning();
      return attempt(tx, (sp) =>
        sp
          .insert(s.storeAgreements)
          .values({
            organizationId: F.orgId,
            storeId: store!.id,
            validFrom: "2025-02-01",
            commissionBp: 1500,
          }),
      );
    });
    expect(outcome.code).toBe("BL004");
  });

  it("ett tillsvidareavtal kan avslutas efter stängd månad, men villkoren kan inte ändras", async () => {
    const end = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_agreements set valid_to = '2025-06-30' where id = ${F.agreementId}`,
        ),
      ),
    );
    expect(end.ok).toBe(true);
    const terms = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_agreements set commission_bp = 2500 where id = ${F.agreementId}`,
        ),
      ),
    );
    expect(terms.code).toBe("BL004");
  });

  it("placering som ändras in i stängd månad nekas", async () => {
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.machine_placements set valid_to = '2025-02-15' where organization_id = ${F.orgId}`,
        ),
      ),
    );
    expect(outcome.code).toBe("BL004");
  });

  it("admin kan stänga men inte öppna; ägaren kan öppna", async () => {
    const close = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.close_period(${F.orgId}, '2025-05-01'::date)`),
      ),
    );
    expect(close.ok).toBe(true);
    const adminReopen = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.reopen_period(${F.orgId}, '2025-05-01'::date)`),
      ),
    );
    expect(adminReopen.code).toBe("42501");
    const ownerReopen = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.reopen_period(${F.orgId}, '2025-05-01'::date)`),
      ),
    );
    expect(ownerReopen.ok).toBe(true);
  });

  it("felaktiga anrop nekas", async () => {
    const call = (query: ReturnType<typeof sql>) =>
      asUser(F.owner, (tx) => attempt(tx, (sp) => sp.execute(query)));
    expect((await call(sql`select public.close_period(${F.orgId}, '2025-03-01'::date)`)).code).toBe(
      "BL015",
    );
    expect((await call(sql`select public.close_period(${F.orgId}, '2025-06-15'::date)`)).code).toBe(
      "22023",
    );
    expect(
      (await call(sql`select public.close_period(${F.orgId}, date_trunc('month', now())::date)`))
        .code,
    ).toBe("22023");
    expect(
      (await call(sql`select public.reopen_period(${F.orgId}, '2025-07-01'::date)`)).code,
    ).toBe("BL016");
  });

  it("öppning loggas med aktör, och därefter går prisändringen igenom", async () => {
    await asUser(F.owner, (tx) =>
      tx.execute(sql`select public.reopen_period(${F.orgId}, '2025-03-01'::date)`),
    );
    const log = await rows<{ action: string; actor_id: string; reopened: string | null }>(
      db(),
      sql`select a.action, a.actor_id, a.after ->> 'reopened_at' as reopened
          from public.audit_log a
          join public.period_closes pc on pc.id = a.row_id
          where a.table_name = 'period_closes' and pc.organization_id = ${F.orgId} and pc.month = '2025-03-01'
          order by a.occurred_at, a.action`,
    );
    expect(log.map((l) => l.action)).toEqual(["insert", "update"]);
    expect(log[1]!.actor_id).toBe(F.owner.id);
    expect(log[1]!.reopened).not.toBeNull();
    expect((await insertPrice(F.titleId, "2025-03-15")).ok).toBe(true);
  });

  it("en stängning kan inte ändras eller raderas direkt", async () => {
    const update = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.period_closes set snapshot = '{}' where organization_id = ${F.orgId}`,
        ),
      ),
    );
    expect(update.code).toBe("42501");
    const system = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.period_closes set month = '2020-01-01' where organization_id = ${F.orgId}`,
        ),
      ),
    );
    expect(system.code).toBe("BL004");
  });
});

describe("prisperioder: priset som gällde orderns dag används", () => {
  let F: TenantFixture;

  beforeAll(async () => {
    F = await seedTenantFixture();
    await asUser(F.owner, async (tx) => {
      // Nytt pris mitt i maj.
      await tx
        .insert(s.purchasePrices)
        .values({
          organizationId: F.orgId,
          titleId: F.titleId,
          unitCostOre: 5000,
          validFrom: "2025-05-15",
        });
      const base = {
        organizationId: F.orgId,
        dataSourceId: F.dataSourceId,
        rawTitle: "Pokemon 151",
        titleId: F.titleId,
        amountOre: 7900,
        machineId: F.machineId,
      };
      await tx.insert(s.orders).values([
        {
          ...base,
          externalId: "may-10",
          orderedAt: new Date("2025-05-10T12:00:00Z"),
          sourceHash: "m10",
        },
        // 14 maj 22:30 UTC = 15 maj 00:30 svensk sommartid: nya priset.
        {
          ...base,
          externalId: "may-15",
          orderedAt: new Date("2025-05-14T22:30:00Z"),
          sourceHash: "m15",
        },
        {
          ...base,
          externalId: "may-20",
          orderedAt: new Date("2025-05-20T12:00:00Z"),
          sourceHash: "m20",
        },
      ]);
    });
  });

  it("purchase_price_periods ger inklusiva intervall", async () => {
    const periods = await asUser(F.owner, (tx) =>
      tx
        .select()
        .from(s.purchasePricePeriods)
        .where(sql`${s.purchasePricePeriods.titleId} = ${F.titleId}`)
        .orderBy(s.purchasePricePeriods.validFrom),
    );
    expect(periods.map((p) => [p.validFrom, p.validTo, p.unitCostOre])).toEqual([
      ["2025-01-01", "2025-05-14", 4500],
      ["2025-05-15", null, 5000],
    ]);
  });

  it("kostnaden per order följer affärsdatum i svensk tid", async () => {
    const costs = await asUser(F.owner, (tx) =>
      rows<{ external_id: string; business_date: string; unit_cost_ore: string }>(
        tx,
        sql`select o.external_id, o.business_date::text, p.unit_cost_ore
            from public.orders o
            join public.purchase_price_periods p
              on p.organization_id = o.organization_id and p.title_id = o.title_id
             and o.business_date between p.valid_from and coalesce(p.valid_to, 'infinity'::date)
            where o.organization_id = ${F.orgId} and o.external_id like 'may-%'
            order by o.external_id`,
      ),
    );
    expect(costs.map((c) => [c.external_id, c.business_date, Number(c.unit_cost_ore)])).toEqual([
      ["may-10", "2025-05-10", 4500],
      ["may-15", "2025-05-15", 5000],
      ["may-20", "2025-05-20", 5000],
    ]);
  });

  it("business_date som inte stämmer med ordered_at nekas", async () => {
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.orders).values({
          organizationId: F.orgId,
          dataSourceId: F.dataSourceId,
          externalId: "wrong-date",
          rawTitle: "x",
          orderedAt: new Date("2025-05-14T22:30:00Z"),
          businessDate: "2025-05-14",
          amountOre: 100,
          sourceHash: "w",
        }),
      ),
    );
    expect(outcome.code).toBe("22023");
  });
});
