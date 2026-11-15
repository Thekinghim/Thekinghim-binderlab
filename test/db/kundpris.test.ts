/**
 * Pris mot kund (purchase_prices.customer_price_ore, 20261216000000_kundpris.sql) mot
 * testdatabasen: vem som får läsa och skriva, att det följer prisperioderna, att det får
 * vara tomt men inte negativt, och att butikernas portal aldrig ser det.
 *
 * Fixturen har priser från 1 jan. 2025 och december 2024 är stängd. Att inga siffror
 * ändras av priset: kundpris-orord.test.ts.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addPurchasePriceFor,
  correctPurchasePriceFor,
  loadPricePageFor,
  loadTitleDetailFor,
  setCustomerPriceFor,
} from "../../src/app/(app)/inkopspriser/_lib/data";
import { PRICE_MESSAGES, priceLog } from "../../src/app/(app)/inkopspriser/_lib/model";
import { AuthorizationError, type SessionUser } from "../../src/server/access";
import { asUser, attempt, createMember, db, rows, type TestUser } from "./helpers";
import { seedPriceFixture, type PriceFixture } from "./inkopspriser-fixture";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

const su = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });
const TODAY = "2025-03-20";

let fx: PriceFixture;
let owner: SessionUser;
let admin: SessionUser;
let viewer: SessionUser;
let refiller: SessionUser;
let refillerUser: TestUser;
let viewerUser: TestUser;
let other: PriceFixture;
let otherOwner: SessionUser;

beforeAll(async () => {
  fx = await seedPriceFixture();
  owner = su(fx.owner);
  admin = su(await createMember(fx.orgId, "admin"));
  viewerUser = await createMember(fx.orgId, "viewer");
  viewer = su(viewerUser);
  refillerUser = await createMember(fx.orgId, "refiller");
  refiller = su(refillerUser);
  other = await seedPriceFixture();
  otherOwner = su(other.owner);
});

/** Titelns prisperioder som de ligger i databasen, äldst först. */
async function periods(titleId: string, orgId = fx.orgId) {
  return rows<{ valid_from: string; cost: number; customer: number | null }>(
    db(),
    sql`select valid_from::text as valid_from, unit_cost_ore::int as cost,
               customer_price_ore::int as customer
        from public.purchase_prices
        where organization_id = ${orgId} and title_id = ${titleId}
        order by valid_from`,
  );
}

describe("kolumnen", () => {
  it("är valfri: befintliga priser har inget pris mot kund", async () => {
    expect(await periods(fx.titleId)).toEqual([
      { valid_from: "2025-01-01", cost: 4500, customer: null },
    ]);
    const page = await loadPricePageFor(owner, fx.orgId);
    expect(page.prices.every((p) => p.customerPriceOre === null)).toBe(true);
  });

  it("tar emot 0 och uppåt, men inte ett negativt pris", async () => {
    await asUser(fx.owner, async (tx) => {
      const negative = await attempt(tx, (sp) =>
        sp.execute(
          sql`update public.purchase_prices set customer_price_ore = -1
              where organization_id = ${fx.orgId} and title_id = ${fx.secondTitleId}`,
        ),
      );
      expect(negative.ok).toBe(false);
      // 23514 = check_violation.
      expect(negative.code).toBe("23514");
      expect(negative.message).toContain("purchase_prices_customer_price_ore_check");

      const zero = await attempt(tx, (sp) =>
        sp.execute(
          sql`update public.purchase_prices set customer_price_ore = 0
              where organization_id = ${fx.orgId} and title_id = ${fx.secondTitleId}`,
        ),
      );
      expect(zero.ok).toBe(true);
    });
    expect((await periods(fx.secondTitleId))[0]?.customer).toBe(0);
    await db().execute(
      sql`update public.purchase_prices set customer_price_ore = null
          where organization_id = ${fx.orgId} and title_id = ${fx.secondTitleId}`,
    );
  });
});

describe("setCustomerPriceFor", () => {
  it("ägaren sätter pris mot kund på perioden som gäller i dag; inköpspriset är orört", async () => {
    const r = await setCustomerPriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      customerPriceOre: 14_500,
      today: TODAY,
    });
    expect(r).toEqual({ ok: true, data: { customerPriceOre: 14_500 } });
    expect(await periods(fx.titleId)).toEqual([
      { valid_from: "2025-01-01", cost: 4500, customer: 14_500 },
    ]);
  });

  it("ändringen loggas med vem, före och efter, som en egen rad i ändringsloggen", async () => {
    const detail = await loadTitleDetailFor(viewer, fx.orgId, fx.titleId);
    const log = priceLog(detail.events, { [owner.userId]: "Ägaren" });
    expect(log[0]).toMatchObject({
      kind: "Pris mot kund",
      actor: "Ägaren",
      validFrom: "2025-01-01",
      beforeOre: null,
      afterOre: 14_500,
    });
  });

  it("samma belopp igen avvisas, och admin kan ta bort priset (null)", async () => {
    const base = { organizationId: fx.orgId, titleId: fx.titleId, today: TODAY };
    expect(await setCustomerPriceFor(admin, { ...base, customerPriceOre: 14_500 })).toEqual({
      ok: false,
      error: PRICE_MESSAGES.customerUnchanged,
    });
    expect(await setCustomerPriceFor(admin, { ...base, customerPriceOre: null })).toEqual({
      ok: true,
      data: { customerPriceOre: null },
    });
    expect((await periods(fx.titleId))[0]?.customer).toBeNull();
    expect((await setCustomerPriceFor(admin, { ...base, customerPriceOre: 14_500 })).ok).toBe(true);
  });

  it("läsare, påfyllare, andra organisationers ägare och utloggade får inte spara", async () => {
    const input = {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      customerPriceOre: 1,
      today: TODAY,
    };
    for (const u of [viewer, refiller, otherOwner]) {
      expect(await setCustomerPriceFor(u, input)).toEqual({
        ok: false,
        error: PRICE_MESSAGES.forbidden,
      });
    }
    expect((await setCustomerPriceFor(null, input)).ok).toBe(false);
    // En ägare i en annan organisation når inte titeln ens med sin egen organisation.
    expect(
      await setCustomerPriceFor(otherOwner, { ...input, organizationId: other.orgId }),
    ).toEqual({ ok: false, error: PRICE_MESSAGES.titleMissing });
    expect((await periods(fx.titleId))[0]?.customer).toBe(14_500);
  });

  it("ogiltiga belopp avvisas innan något händer", async () => {
    const base = { organizationId: fx.orgId, titleId: fx.titleId, today: TODAY };
    for (const customerPriceOre of [-1, 1.5, 10_000_001, Number.NaN]) {
      expect(await setCustomerPriceFor(owner, { ...base, customerPriceOre })).toEqual({
        ok: false,
        error: PRICE_MESSAGES.customerInvalid,
      });
    }
    expect((await periods(fx.titleId))[0]?.customer).toBe(14_500);
  });

  it("utan inköpspris finns inget att lägga priset på", async () => {
    const titleId = await asUser(fx.owner, async (tx) => {
      const r = await rows<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name)
            values (${fx.orgId}, 'Utan pris') returning id`,
      );
      return r[0]!.id;
    });
    expect(
      await setCustomerPriceFor(owner, {
        organizationId: fx.orgId,
        titleId,
        customerPriceOre: 9_900,
        today: TODAY,
      }),
    ).toEqual({ ok: false, error: PRICE_MESSAGES.customerNeedsCost });
  });

  it("får ändras i en stängd månad: inga siffror påverkas, och inköpspriset är fortfarande låst", async () => {
    // closedTitle: enda priset (1 nov. 2024) gäller i den stängda december 2024.
    const base = { organizationId: fx.orgId, titleId: fx.closedTitleId };
    expect(
      await setCustomerPriceFor(owner, { ...base, customerPriceOre: 8_900, today: TODAY }),
    ).toEqual({ ok: true, data: { customerPriceOre: 8_900 } });
    expect(await periods(fx.closedTitleId)).toEqual([
      { valid_from: "2024-11-01", cost: 6000, customer: 8_900 },
    ]);
    // Inköpspriset på samma rad går inte att ändra (BL004 via formulärets väg).
    const cost = await addPurchasePriceFor(owner, {
      ...base,
      unitCostOre: 6_100,
      validFrom: "2024-11-01",
    });
    expect(cost).toEqual({ ok: false, error: PRICE_MESSAGES.closedMonth(["2024-12"]) });
    // Och inte heller direkt i databasen ihop med pris mot kund.
    await asUser(fx.owner, async (tx) => {
      const both = await attempt(tx, (sp) =>
        sp.execute(
          sql`update public.purchase_prices set unit_cost_ore = 6100, customer_price_ore = 9000
              where organization_id = ${fx.orgId} and title_id = ${fx.closedTitleId}`,
        ),
      );
      expect(both.code).toBe("BL004");
    });
    expect((await periods(fx.closedTitleId))[0]).toMatchObject({ cost: 6000, customer: 8_900 });
  });
});

describe("historik över prisperioder", () => {
  it("ett nytt inköpspris med eget pris mot kund: varje period behåller sitt", async () => {
    const r = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_800,
      customerPriceOre: 14_900,
      validFrom: "2025-03-11",
    });
    expect(r).toMatchObject({ ok: true, data: { mode: "inserted" } });
    expect(await periods(fx.titleId)).toEqual([
      { valid_from: "2025-01-01", cost: 4500, customer: 14_500 },
      { valid_from: "2025-03-11", cost: 4800, customer: 14_900 },
    ]);
    const page = await loadPricePageFor(viewer, fx.orgId);
    expect(
      page.prices
        .filter((p) => p.titleId === fx.titleId)
        .map((p) => [p.validFrom, p.customerPriceOre]),
    ).toEqual([
      ["2025-01-01", 14_500],
      ["2025-03-11", 14_900],
    ]);
  });

  it("ett nytt inköpspris utan uppgift (t.ex. en leverans) tar över periodens pris mot kund", async () => {
    const r = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_900,
      validFrom: "2025-03-15",
    });
    expect(r.ok).toBe(true);
    // Mellan två perioder: den tar över från perioden som gällde dagen (1 jan.), inte nästa.
    const between = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_600,
      validFrom: "2025-02-01",
    });
    expect(between.ok).toBe(true);
    expect(await periods(fx.titleId)).toEqual([
      { valid_from: "2025-01-01", cost: 4500, customer: 14_500 },
      { valid_from: "2025-02-01", cost: 4600, customer: 14_500 },
      { valid_from: "2025-03-11", cost: 4800, customer: 14_900 },
      { valid_from: "2025-03-15", cost: 4900, customer: 14_900 },
    ]);
  });

  it("ett nytt inköpspris med tomt pris mot kund (null) tömmer det för den perioden", async () => {
    const r = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 5_000,
      customerPriceOre: null,
      validFrom: "2025-03-18",
    });
    expect(r.ok).toBe(true);
    const all = await periods(fx.titleId);
    expect(all.at(-1)).toEqual({ valid_from: "2025-03-18", cost: 5000, customer: null });
    // Äldre perioder är orörda.
    expect(all.slice(0, -1).map((p) => p.customer)).toEqual([14_500, 14_500, 14_900, 14_900]);
  });

  it("samma dag igen: bara pris mot kund ändrat sparas; allt lika avvisas", async () => {
    const base = {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 5_000,
      validFrom: "2025-03-18",
    };
    expect(await addPurchasePriceFor(owner, { ...base, customerPriceOre: 15_500 })).toMatchObject({
      ok: true,
      data: { mode: "replaced" },
    });
    expect((await periods(fx.titleId)).at(-1)?.customer).toBe(15_500);
    expect(await addPurchasePriceFor(owner, { ...base, customerPriceOre: 15_500 })).toEqual({
      ok: false,
      error: PRICE_MESSAGES.unchanged,
    });
    // Utan uppgift: priset mot kund rörs inte, och inget annat ändras heller.
    expect(await addPurchasePriceFor(owner, base)).toEqual({
      ok: false,
      error: PRICE_MESSAGES.unchanged,
    });
    expect((await periods(fx.titleId)).at(-1)?.customer).toBe(15_500);
  });

  it("Rätta priset: nytt inköpspris på alla perioder, pris mot kund bara på dagens period", async () => {
    const r = await correctPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 5_100,
      customerPriceOre: 16_000,
      today: TODAY,
    });
    expect(r.ok).toBe(true);
    const all = await periods(fx.titleId);
    expect(all.every((p) => p.cost === 5_100)).toBe(true);
    expect(all.map((p) => p.customer)).toEqual([14_500, 14_500, 14_900, 14_900, 16_000]);
  });

  it("Rätta priset utan uppgift rör inget pris mot kund", async () => {
    const r = await correctPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 5_200,
      today: TODAY,
    });
    expect(r.ok).toBe(true);
    const all = await periods(fx.titleId);
    expect(all.every((p) => p.cost === 5_200)).toBe(true);
    expect(all.map((p) => p.customer)).toEqual([14_500, 14_500, 14_900, 14_900, 16_000]);
  });
});

describe("RLS och rättigheter", () => {
  it("ägare, admin och läsare läser priset; påfyllaren ser inga prisrader alls", async () => {
    const read = (u: TestUser) =>
      asUser(u, (tx) =>
        rows<{ customer: number | null }>(
          tx,
          sql`select customer_price_ore::int as customer from public.purchase_prices
              where organization_id = ${fx.orgId} and title_id = ${fx.closedTitleId}`,
        ),
      );
    expect(await read(fx.owner)).toEqual([{ customer: 8_900 }]);
    expect(await read(viewerUser)).toEqual([{ customer: 8_900 }]);
    expect(await read(refillerUser)).toEqual([]);
    await expect(loadPricePageFor(refiller, fx.orgId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("en annan organisation ser ingenting och kan inte ändra något", async () => {
    await asUser(other.owner, async (tx) => {
      expect(
        await rows(
          tx,
          sql`select id from public.purchase_prices where organization_id = ${fx.orgId}`,
        ),
      ).toEqual([]);
      const changed = await rows(
        tx,
        sql`update public.purchase_prices set customer_price_ore = 1
            where organization_id = ${fx.orgId} returning id`,
      );
      expect(changed).toEqual([]);
    });
    expect((await periods(fx.closedTitleId))[0]?.customer).toBe(8_900);
    // Den andra organisationens egna priser är orörda av allt ovan.
    expect((await periods(other.titleId, other.orgId)).every((p) => p.customer === null)).toBe(
      true,
    );
  });

  it("läsare och påfyllare kan inte ändra priset direkt i databasen", async () => {
    for (const u of [viewerUser, refillerUser]) {
      await asUser(u, async (tx) => {
        const changed = await rows(
          tx,
          sql`update public.purchase_prices set customer_price_ore = 1
              where organization_id = ${fx.orgId} returning id`,
        );
        expect(changed).toEqual([]);
      });
    }
    expect((await periods(fx.closedTitleId))[0]?.customer).toBe(8_900);
  });

  it("uppdatering är tillåten per kolumn: bara belopp, datum, anteckning och pris mot kund", async () => {
    const granted = await rows<{ column_name: string }>(
      db(),
      sql`select column_name from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'purchase_prices'
            and grantee = 'authenticated' and privilege_type = 'UPDATE'
          order by column_name`,
    );
    expect(granted.map((g) => g.column_name)).toEqual([
      "customer_price_ore",
      "note",
      "unit_cost_ore",
      "valid_from",
    ]);
    const anon = await rows(
      db(),
      sql`select 1 from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'purchase_prices' and grantee = 'anon'`,
    );
    expect(anon).toEqual([]);
  });
});

describe("butikernas portal och databasens funktioner", () => {
  let portal: PortalFixture;

  beforeAll(async () => {
    portal = await seedPortalFixture();
    await db().execute(
      sql`update public.purchase_prices set customer_price_ore = 14500
          where organization_id = ${portal.a.orgId}`,
    );
  });

  it("butiksanvändaren ser varken inköpspris eller pris mot kund", async () => {
    await asUser(portal.storeA1, async (tx) => {
      expect(await rows(tx, sql`select * from public.purchase_prices`)).toEqual([]);
      expect(await rows(tx, sql`select * from public.purchase_price_periods`)).toEqual([]);
    });
  });

  it("vyn purchase_price_periods har inte fått kolumnen", async () => {
    const columns = await rows<{ column_name: string }>(
      db(),
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'purchase_price_periods'
          order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "id",
      "organization_id",
      "title_id",
      "unit_cost_ore",
      "valid_from",
      "valid_to",
    ]);
  });

  it("ingen funktion, vy eller policy i databasen läser kolumnen", async () => {
    const functions = await rows<{ name: string }>(
      db(),
      sql`select n.nspname || '.' || p.proname as name
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private') and p.prosrc ilike '%customer_price_ore%'`,
    );
    expect(functions).toEqual([]);
    const views = await rows<{ name: string }>(
      db(),
      sql`select schemaname || '.' || viewname as name from pg_views
          where schemaname in ('public', 'private') and definition ilike '%customer_price_ore%'`,
    );
    expect(views).toEqual([]);
    const policies = await rows<{ name: string }>(
      db(),
      sql`select policyname as name from pg_policies
          where coalesce(qual, '') ilike '%customer_price_ore%'
             or coalesce(with_check, '') ilike '%customer_price_ore%'`,
    );
    expect(policies).toEqual([]);
  });

  it("portalens funktioner lämnar aldrig ut ett fält med inköpspris eller pris mot kund", async () => {
    // Alla portal_*-funktioner: ingen har en kolumn eller ett JSON-fält som heter något med
    // kostnad eller pris mot kund (resultattyp och källtext).
    const leaks = await rows<{ name: string }>(
      db(),
      sql`select p.proname as name
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'portal\\_%'
            and (pg_get_function_result(p.oid) ~* '(unit_cost|customer_price|cost_ore)'
                 or p.prosrc ~* '(unit_cost_ore|customer_price_ore|purchase_prices)')`,
    );
    expect(leaks).toEqual([]);
  });
});
