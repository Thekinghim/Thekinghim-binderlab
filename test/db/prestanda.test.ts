/**
 * Prestanda (fas 7): samma svar som före optimeringarna.
 *
 * - queryOrders läser orderna med rå SQL i stället för Drizzles select: samma order,
 *   samma ordning, samma format på tidpunkten (Date.toISOString), order utan titel
 *   räknade men inte med.
 * - Vyn stock_levels (20261102230000_prestanda_stock_levels.sql) ger samma rader som den
 *   tidigare definitionen (20261102100500_stock.sql), som står här som facit.
 */

import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AnalyticsOrder } from "@/analytics/todos";
import * as s from "@/db/schema";
import { withUserDbFor } from "@/server/access";
import { queryOrders } from "@/server/data/core/queries";

import { asUser, db, rows, seedTenantFixture, type TenantFixture } from "./helpers";

const RANGE = { start: "2025-01-01", end: "2025-12-31" };
const NO_SCOPE = { storeId: null, machineId: null };

/** Den tidigare frågan (Drizzle), som facit. */
async function reference(fx: TenantFixture, machineId: string | null) {
  return withUserDbFor({ userId: fx.owner.id, email: fx.owner.email }, async (tx) => {
    const conditions = [
      eq(s.orders.organizationId, fx.orgId),
      gte(s.orders.businessDate, RANGE.start),
      lte(s.orders.businessDate, RANGE.end),
    ];
    if (machineId) conditions.push(eq(s.orders.machineId, machineId));
    const rows = await tx
      .select({
        id: s.orders.id,
        externalId: s.orders.externalId,
        titleId: s.orders.titleId,
        machineId: s.orders.machineId,
        businessDate: s.orders.businessDate,
        amountOre: s.orders.amountOre,
        orderedAt: s.orders.orderedAt,
      })
      .from(s.orders)
      .where(and(...conditions))
      .orderBy(asc(s.orders.orderedAt), asc(s.orders.id));
    const orders: AnalyticsOrder[] = [];
    let withoutTitle = 0;
    for (const r of rows) {
      if (r.titleId === null) {
        withoutTitle += 1;
        continue;
      }
      orders.push({
        id: r.id,
        externalId: r.externalId,
        titleId: r.titleId,
        machineId: r.machineId,
        businessDate: r.businessDate,
        amountOre: r.amountOre,
        orderedAt: r.orderedAt.toISOString(),
      });
    }
    return { orders, withoutTitle };
  });
}

let fx: TenantFixture;

beforeAll(async () => {
  fx = await seedTenantFixture();
  // Fler order: samma tidpunkt (ordningen avgörs av id), mikrosekunder, utan titel och
  // utan automat, och ett belopp över 2^31.
  await asUser(fx.owner, async (tx) => {
    const base = {
      organizationId: fx.orgId,
      dataSourceId: fx.dataSourceId,
      paymentMethod: "card" as const,
      sourceMachineId: fx.sourceMachineId,
      importId: fx.importId,
    };
    await tx.insert(s.orders).values([
      {
        ...base,
        externalId: "p-1",
        rawTitle: "Pokemon 151",
        titleId: fx.titleId,
        machineId: fx.machineId,
        // Mikrosekunder (Date kan inte bära dem): ska kortas till millisekunder som förut.
        orderedAt: sql`'2025-04-01T08:00:00.999999Z'::timestamptz`,
        amountOre: 7900,
        sourceHash: "p1",
      },
      {
        ...base,
        externalId: "p-2",
        rawTitle: "Pokemon 151",
        titleId: fx.secondTitleId,
        machineId: fx.machineId,
        orderedAt: sql`'2025-04-01T08:00:00.999999Z'::timestamptz`,
        amountOre: 3_000_000_000,
        sourceHash: "p2",
      },
      {
        ...base,
        externalId: "p-3",
        rawTitle: "Okänd",
        titleId: null,
        machineId: fx.machineId,
        orderedAt: new Date("2025-04-02T23:30:00Z"),
        amountOre: 5900,
        sourceHash: "p3",
      },
      {
        ...base,
        externalId: "p-5",
        rawTitle: "Pokemon 151",
        titleId: fx.titleId,
        machineId: fx.machineId,
        orderedAt: sql`'2025-04-01T08:00:00.123456Z'::timestamptz`,
        amountOre: 4900,
        sourceHash: "p5",
      },
      {
        ...base,
        externalId: "p-4",
        rawTitle: "Pokemon 151",
        titleId: fx.titleId,
        machineId: null,
        orderedAt: new Date("2025-06-30T22:15:00Z"),
        amountOre: 0,
        sourceHash: "p4",
      },
    ]);
  });
});

describe("queryOrders (rå SQL)", () => {
  it("ger exakt samma svar som den tidigare Drizzle-frågan", async () => {
    const user = { userId: fx.owner.id, email: fx.owner.email };
    for (const machineId of [null, fx.machineId]) {
      const expected = await reference(fx, machineId);
      const actual = await withUserDbFor(user, (tx) =>
        queryOrders(tx, fx.orgId, RANGE, { ...NO_SCOPE, machineId }),
      );
      expect(actual).toEqual(expected);
      expect(actual.withoutTitle).toBe(1);
      expect(actual.orders.some((o) => o.amountOre === 3_000_000_000)).toBe(true);
      for (const o of actual.orders)
        expect(o.orderedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
  });
});

/** Den tidigare definitionen av stock_levels, som facit. */
const OLD_STOCK_LEVELS = sql`
  with last_count as (
    select distinct on (e.organization_id, e.location_id, e.title_id)
      e.organization_id, e.location_id, e.title_id, e.quantity, e.occurred_at, e.seq
    from public.stock_events e
    where e.kind = 'count'
    order by e.organization_id, e.location_id, e.title_id, e.occurred_at desc, e.seq desc
  )
  select
    e.organization_id, e.location_id, e.title_id,
    (
      coalesce(max(lc.quantity), 0)
      + coalesce(
          sum(e.quantity) filter (
            where e.kind <> 'count'
              and (lc.seq is null or (e.occurred_at, e.seq) > (lc.occurred_at, lc.seq))
          ),
          0
        )
    )::integer as quantity,
    max(lc.occurred_at) as last_counted_at,
    max(e.occurred_at) as last_event_at
  from public.stock_events e
  left join last_count lc
    on lc.organization_id = e.organization_id
   and lc.location_id = e.location_id
   and lc.title_id = e.title_id
  group by e.organization_id, e.location_id, e.title_id`;

describe("stock_levels", () => {
  it("ger samma saldo som den tidigare definitionen", async () => {
    // Fler händelser: inventering mitt i, samma tidpunkt som en påfyllning (seq avgör),
    // en serie helt utan inventering och en där inventeringen är sist.
    await asUser(fx.owner, async (tx) => {
      const base = { organizationId: fx.orgId, locationId: fx.machineLocationId };
      const at = (iso: string) => new Date(iso);
      await tx.insert(s.stockEvents).values([
        {
          ...base,
          titleId: fx.titleId,
          kind: "refill",
          quantity: 5,
          occurredAt: at("2025-05-01T08:00:00Z"),
        },
        {
          ...base,
          titleId: fx.titleId,
          kind: "count",
          quantity: 7,
          occurredAt: at("2025-05-01T08:00:00Z"),
        },
        {
          ...base,
          titleId: fx.titleId,
          kind: "waste",
          quantity: -1,
          occurredAt: at("2025-05-01T08:00:00Z"),
        },
        {
          ...base,
          titleId: fx.titleId,
          kind: "adjustment",
          quantity: -2,
          occurredAt: at("2025-05-02T08:00:00Z"),
        },
        {
          ...base,
          titleId: fx.secondTitleId,
          kind: "refill",
          quantity: 9,
          occurredAt: at("2025-05-03T08:00:00Z"),
        },
        {
          ...base,
          titleId: fx.secondTitleId,
          kind: "waste",
          quantity: -3,
          occurredAt: at("2025-05-04T08:00:00Z"),
        },
        {
          ...base,
          locationId: fx.centralLocationId,
          titleId: fx.titleId,
          kind: "receipt",
          quantity: 40,
          occurredAt: at("2025-05-01T07:00:00Z"),
        },
        {
          ...base,
          locationId: fx.centralLocationId,
          titleId: fx.titleId,
          kind: "count",
          quantity: 38,
          occurredAt: at("2025-05-05T07:00:00Z"),
        },
      ]);
    });
    const order = sql`order by organization_id, location_id, title_id`;
    const expected = await rows(db(), sql`select * from (${OLD_STOCK_LEVELS}) o ${order}`);
    const actual = await rows(
      db(),
      sql`select organization_id, location_id, title_id, quantity, last_counted_at, last_event_at
          from public.stock_levels ${order}`,
    );
    expect(actual.length).toBeGreaterThan(2);
    expect(actual).toEqual(expected);
  });
});
