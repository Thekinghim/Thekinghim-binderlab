/**
 * "Rätta priset" mot testdatabasen: det nya priset gäller all försäljning hittills, i en
 * transaktion, utan att röra stängda månader. Varje ändrad rad loggas och bara ägare och
 * admin får rätta.
 *
 * Fixturen: priser från 1 jan. 2025, tre order 10–11 mars 2025, december 2024 stängd.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addPurchasePriceFor,
  correctPurchasePriceFor,
} from "../../src/app/(app)/inkopspriser/_lib/data";
import { PRICE_MESSAGES } from "../../src/app/(app)/inkopspriser/_lib/model";
import type { SessionUser } from "../../src/server/access";
import { createMember, db, rows, type TestUser } from "./helpers";
import { seedPriceFixture, type PriceFixture } from "./inkopspriser-fixture";

const su = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });
const TODAY = "2025-03-20";

let fx: PriceFixture;
let owner: SessionUser;
let admin: SessionUser;
let viewer: SessionUser;
let refiller: SessionUser;
let otherOwner: SessionUser;

beforeAll(async () => {
  fx = await seedPriceFixture();
  owner = su(fx.owner);
  admin = su(await createMember(fx.orgId, "admin"));
  viewer = su(await createMember(fx.orgId, "viewer"));
  refiller = su(await createMember(fx.orgId, "refiller"));
  otherOwner = su((await seedPriceFixture()).owner);
});

/** Inköpet per order för titeln, som Lönsamhet räknar det (prisperioden på orderdagen). */
async function orderCosts(titleId: string): Promise<Array<number | null>> {
  const r = await rows(
    db(),
    sql`select pp.unit_cost_ore::int as cost
        from public.orders o
        left join public.purchase_price_periods pp
          on pp.organization_id = o.organization_id and pp.title_id = o.title_id
         and o.business_date >= pp.valid_from
         and (pp.valid_to is null or o.business_date <= pp.valid_to)
        where o.organization_id = ${fx.orgId} and o.title_id = ${titleId}
        order by o.business_date, o.external_id`,
  );
  return r.map((x) => (x.cost === null ? null : Number(x.cost)));
}

async function storedPrices(titleId: string) {
  return rows(
    db(),
    sql`select valid_from::text as valid_from, unit_cost_ore::int as ore
        from public.purchase_prices
        where organization_id = ${fx.orgId} and title_id = ${titleId}
        order by valid_from`,
  );
}

describe("correctPurchasePriceFor", () => {
  it("alla sålda order får det nya priset och vinstens förändring stämmer", async () => {
    // Ägaren lade ett nytt pris från 11 mars: bara den sista ordern fick det.
    const added = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_800,
      validFrom: "2025-03-11",
    });
    expect(added.ok).toBe(true);
    expect(await orderCosts(fx.titleId)).toEqual([4_500, 4_500, 4_800]);

    const r = await correctPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 5_000,
      note: "Rätt pris enligt faktura",
      today: TODAY,
    });
    // 2·(5000−4500) + 1·(5000−4800) = 1 200 öre dyrare: vinsten −12 kr.
    expect(r).toEqual({
      ok: true,
      data: {
        start: "2025-01-01",
        affectedOrders: 3,
        ordersGainingPrice: 0,
        profitDeltaOre: -1_200,
      },
    });
    expect(await orderCosts(fx.titleId)).toEqual([5_000, 5_000, 5_000]);
    expect(await storedPrices(fx.titleId)).toEqual([
      { valid_from: "2025-01-01", ore: 5_000 },
      { valid_from: "2025-03-11", ore: 5_000 },
    ]);
  });

  it("varje ändrad rad loggas med vem, före och efter", async () => {
    const log = await rows(
      db(),
      sql`select a.actor_id, (a.before ->> 'unit_cost_ore')::int as before_ore,
                 (a.after ->> 'unit_cost_ore')::int as after_ore, a.after ->> 'note' as note
          from public.audit_log a
          where a.organization_id = ${fx.orgId} and a.table_name = 'purchase_prices'
            and a.action::text = 'update' and a.after ->> 'title_id' = ${fx.titleId}
          order by a.before ->> 'valid_from'`,
    );
    expect(log).toEqual([
      { actor_id: owner.userId, before_ore: 4_500, after_ore: 5_000, note: null },
      {
        actor_id: owner.userId,
        before_ore: 4_800,
        after_ore: 5_000,
        note: "Rätt pris enligt faktura",
      },
    ]);
  });

  it("samma pris igen avvisas", async () => {
    const r = await correctPurchasePriceFor(admin, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 5_000,
      today: TODAY,
    });
    expect(r).toEqual({ ok: false, error: PRICE_MESSAGES.correctionUnchanged });
  });

  it("en stängd månad rörs inte: rättelsen börjar efter den", async () => {
    // Titelns enda pris (60 kr från 1 nov. 2024) gäller i den stängda december 2024.
    const r = await correctPurchasePriceFor(admin, {
      organizationId: fx.orgId,
      titleId: fx.closedTitleId,
      unitCostOre: 6_500,
      today: TODAY,
    });
    expect(r).toMatchObject({ ok: true, data: { start: "2025-01-01" } });
    expect(await storedPrices(fx.closedTitleId)).toEqual([
      { valid_from: "2024-11-01", ore: 6_000 },
      { valid_from: "2025-01-01", ore: 6_500 },
    ]);
  });

  it("är dagens månad stängd går det inte att rätta", async () => {
    const r = await correctPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.secondTitleId,
      unitCostOre: 9_999,
      today: "2024-12-15",
    });
    expect(r).toEqual({ ok: false, error: PRICE_MESSAGES.correctionClosed });
    expect(await storedPrices(fx.secondTitleId)).toEqual([
      { valid_from: "2025-01-01", ore: 5_200 },
    ]);
  });

  it("läsare, påfyllare, andra organisationer och utloggade får inte rätta", async () => {
    const input = {
      organizationId: fx.orgId,
      titleId: fx.secondTitleId,
      unitCostOre: 1,
      today: TODAY,
    };
    for (const u of [viewer, refiller, otherOwner]) {
      expect(await correctPurchasePriceFor(u, input)).toEqual({
        ok: false,
        error: PRICE_MESSAGES.forbidden,
      });
    }
    expect(await correctPurchasePriceFor(null, input)).toEqual({
      ok: false,
      error: "Du är inte inloggad.",
    });
    expect(await storedPrices(fx.secondTitleId)).toEqual([
      { valid_from: "2025-01-01", ore: 5_200 },
    ]);
  });

  it("ogiltig indata och sammanslagna titlar avvisas", async () => {
    const base = { organizationId: fx.orgId, titleId: fx.titleId, today: TODAY };
    for (const bad of [
      { ...base, unitCostOre: -1 },
      { ...base, unitCostOre: 1.5 },
      { ...base, unitCostOre: 100, today: "2025-02-30" },
    ]) {
      expect(await correctPurchasePriceFor(owner, bad)).toEqual({
        ok: false,
        error: PRICE_MESSAGES.invalid,
      });
    }
    expect(
      await correctPurchasePriceFor(owner, { ...base, titleId: fx.mergedTitleId, unitCostOre: 1 }),
    ).toEqual({ ok: false, error: PRICE_MESSAGES.titleMerged });
  });
});
