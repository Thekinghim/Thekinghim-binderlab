/**
 * Butiksportalens funktioner (portal_*): bara den egna butikens försäljning och
 * ersättning, aldrig inköp, marginal, vinst eller andra butikers data. Samma
 * felmeddelande för en butik/automat/rapport som finns hos någon annan som för en
 * som inte finns. Portalens siffror stämmer med appens beräkning.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { storeCompensation, type OrderLine } from "../../src/domain";
import {
  buildPortalOverview,
  firstPortalMonth,
  portalSources,
} from "../../src/server/portal/model";
import {
  queryPortalAgreements,
  queryPortalFaults,
  queryPortalMachines,
  queryPortalReport,
  queryPortalReports,
  queryPortalSales,
  queryPortalStores,
} from "../../src/server/portal/queries";

import { asAnon, asPostgres, asUser, attempt, db, one, rows, type TestUser } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

let f: PortalFixture;
const RANDOM = "00000000-0000-4000-8000-000000000000";
const MARCH = { start: "2025-03-01", end: "2025-03-31" } as const;

beforeAll(async () => {
  f = await seedPortalFixture();
});

const STORE_FUNCTIONS = (storeId: string) => [
  sql`select * from public.portal_sales(${storeId}::uuid, '2025-01-01', '2025-12-31')`,
  sql`select * from public.portal_agreements(${storeId}::uuid)`,
  sql`select * from public.portal_machines(${storeId}::uuid)`,
  sql`select * from public.portal_reports(${storeId}::uuid)`,
  sql`select * from public.portal_faults(${storeId}::uuid)`,
  sql`select * from public.portal_report(${storeId}::uuid, ${RANDOM}::uuid)`,
];

async function failure(user: TestUser, query: ReturnType<typeof sql>) {
  const outcome = await asUser(user, (tx) => attempt(tx, (sp) => sp.execute(query)));
  return outcome.ok ? null : { code: outcome.code, message: outcome.message };
}

describe("vem som når portalen", () => {
  it("portal_stores ger bara den egna butiken", async () => {
    const a1 = await asUser(f.storeA1, queryPortalStores);
    expect(a1.map((s) => [s.storeId, s.organizationId])).toEqual([[f.a.storeId, f.a.orgId]]);
    const b1 = await asUser(f.storeB1, queryPortalStores);
    expect(b1.map((s) => s.storeId)).toEqual([f.b.storeId]);
  });

  it("ägare, admin, läsare och påfyllare är inte butiksanvändare", async () => {
    for (const user of [f.a.owner, f.adminA, f.viewerA, f.refillerA]) {
      expect(await asUser(user, queryPortalStores)).toEqual([]);
      for (const q of STORE_FUNCTIONS(f.a.storeId)) {
        expect((await failure(user, q))?.code).toBe("42501");
      }
    }
  });

  it("anon kan inte köra någon portalfunktion", async () => {
    for (const q of [sql`select * from public.portal_stores()`, ...STORE_FUNCTIONS(f.a.storeId)]) {
      const outcome = await asAnon((tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(outcome.code).toBe("42501");
    }
  });

  it("en butik når aldrig en annan butiks data, och felet är detsamma som för en butik som inte finns", async () => {
    const pairs: [TestUser, string][] = [
      [f.storeA1, f.a2.storeId], // annan butik i samma organisation
      [f.storeA1, f.b.storeId], // butik i en annan organisation
      [f.storeA2, f.a.storeId],
      [f.storeB1, f.a.storeId],
    ];
    for (const [user, storeId] of pairs) {
      const queries = STORE_FUNCTIONS(storeId);
      const missing = STORE_FUNCTIONS(RANDOM);
      for (let i = 0; i < queries.length; i++) {
        const foreign = await failure(user, queries[i]!);
        const none = await failure(user, missing[i]!);
        expect(foreign).not.toBeNull();
        expect(foreign).toEqual(none);
        expect(foreign!.message).not.toMatch(/Coop|ICA|Fixtur|Automat|BL-0/);
      }
    }
  });

  it("en arkiverad butik stänger portalen", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`update public.stores set archived_at = now() where id = ${f.a2.storeId}`),
    );
    try {
      expect(await asUser(f.storeA2, queryPortalStores)).toEqual([]);
      expect((await failure(f.storeA2, STORE_FUNCTIONS(f.a2.storeId)[0]!))?.code).toBe("42501");
    } finally {
      await asPostgres((tx) =>
        tx.execute(sql`update public.stores set archived_at = null where id = ${f.a2.storeId}`),
      );
    }
  });
});

describe("vad funktionerna lämnar ut", () => {
  it("inga kolumner med inköp, kostnad, marginal, vinst eller ordernummer", async () => {
    const results = await rows<{ name: string; result: string }>(
      db(),
      sql`select p.proname as name, pg_get_function_result(p.oid) as result
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'portal\\_%'`,
    );
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect([r.name, r.result]).not.toEqual([
        r.name,
        expect.stringMatching(
          /cost|margin|profit|purchase|inkop|vinst|external|ordered_at|owner|note|serial|action_taken|refund/i,
        ),
      ]);
    }
  });

  it("portal_sales ger exakt butikens order (placeringen avgör), utan andra butikers", async () => {
    const sales = await asUser(f.storeA1, (tx) => queryPortalSales(tx, f.a.storeId, MARCH));
    const truth = await one<{ n: number; sum: number }>(
      db(),
      sql`select count(*)::int as n, coalesce(sum(o.amount_ore), 0)::int as sum
          from public.orders o
          join public.machine_placements mp on mp.organization_id = o.organization_id
            and mp.machine_id = o.machine_id and mp.store_id = ${f.a.storeId}
            and o.business_date >= mp.valid_from
            and (mp.valid_to is null or o.business_date <= mp.valid_to)
          where o.organization_id = ${f.a.orgId}
            and o.title_id is not null
            and o.business_date between '2025-03-01' and '2025-03-31'`,
    );
    expect(truth.n).toBeGreaterThan(0);
    expect(sales.reduce((s, r) => s + r.orderCount, 0)).toBe(truth.n);
    expect(sales.reduce((s, r) => s + r.orderCount * r.amountOre, 0)).toBe(truth.sum);
    expect(new Set(sales.map((r) => r.machineId))).toEqual(new Set([f.a.machineId]));

    const a2 = await asUser(f.storeA2, (tx) => queryPortalSales(tx, f.a2.storeId, MARCH));
    expect(a2.reduce((s, r) => s + r.orderCount, 0)).toBe(3);
    expect(new Set(a2.map((r) => r.machineId))).toEqual(new Set([f.a2.machineId]));
  });

  it("order utan titelkoppling räknas inte (som appens beräkningar och butiksrapporten)", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
                                       ordered_at, amount_ore, machine_id, source_hash)
            values (${f.a.orgId}, ${f.a.dataSourceId}, 'utan-titel-1', 'Okänd titel',
                    '2025-04-02T10:00:00Z', 9900, ${f.a.machineId}, 'utan-titel-1')`,
      ),
    );
    const april = await asUser(f.storeA1, (tx) =>
      queryPortalSales(tx, f.a.storeId, { start: "2025-04-01", end: "2025-04-30" }),
    );
    expect(april).toEqual([]);
  });

  it("efter en flytt följer försäljningen placeringen, inte automaten", async () => {
    // BL-002 flyttar från A2 till A1 den 14 mars: orden den 14 mars blir A1:s.
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`update public.machine_placements set valid_to = '2025-03-13'
            where machine_id = ${f.a2.machineId} and store_id = ${f.a2.storeId}`,
      );
      await tx.execute(
        sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from, valid_to)
            values (${f.a.orgId}, ${f.a2.machineId}, ${f.a.storeId}, '2025-03-14', '2025-03-31')`,
      );
    });
    try {
      const a1 = await asUser(f.storeA1, (tx) => queryPortalSales(tx, f.a.storeId, MARCH));
      expect(a1.filter((r) => r.machineId === f.a2.machineId).map((r) => r.businessDate)).toEqual([
        "2025-03-14",
      ]);
      const a2 = await asUser(f.storeA2, (tx) => queryPortalSales(tx, f.a2.storeId, MARCH));
      expect(a2.reduce((s, r) => s + r.orderCount, 0)).toBe(2);
      // A2 ser bara perioden då automaten stod hos A2, inte vart den flyttade.
      const machines = await asUser(f.storeA2, (tx) => queryPortalMachines(tx, f.a2.storeId));
      expect(machines).toEqual([
        {
          machineId: f.a2.machineId,
          code: "BL-002",
          name: "Automat 2",
          placedFrom: "2025-01-01",
          placedTo: "2025-03-13",
        },
      ]);
    } finally {
      await asPostgres(async (tx) => {
        // Placeringar raderas aldrig av klienter; testet städar som systemjobb.
        await tx.execute(sql`select set_config('binderlab.allow_purge', 'on', true)`);
        await tx.execute(
          sql`delete from public.machine_placements
              where machine_id = ${f.a2.machineId} and store_id = ${f.a.storeId}`,
        );
        await tx.execute(
          sql`update public.machine_placements set valid_to = null
              where machine_id = ${f.a2.machineId} and store_id = ${f.a2.storeId}`,
        );
      });
    }
  });

  it("portal_agreements ger bara butikens villkor (andel, underlag och hyra)", async () => {
    const a1 = await asUser(f.storeA1, (tx) => queryPortalAgreements(tx, f.a.storeId));
    expect(a1).toEqual([
      {
        validFrom: "2025-01-01",
        validTo: null,
        commissionBp: 2000,
        monthlyRentOre: null,
        commissionBase: "net_excl_vat",
        lossTreatment: "zero",
        vmbBeforeSplit: false,
      },
    ]);
    const a2 = await asUser(f.storeA2, (tx) => queryPortalAgreements(tx, f.a2.storeId));
    expect(a2).toEqual([
      {
        validFrom: "2025-01-01",
        validTo: null,
        commissionBp: 1500,
        monthlyRentOre: 50000,
        commissionBase: "net_excl_vat",
        lossTreatment: "zero",
        vmbBeforeSplit: false,
      },
    ]);
  });

  it("perioden är begränsad till tre år", async () => {
    const outcome = await failure(
      f.storeA1,
      sql`select * from public.portal_sales(${f.a.storeId}::uuid, '2015-01-01', '2025-12-31')`,
    );
    expect(outcome?.code).toBe("22023");
  });
});

describe("rapporter", () => {
  it("portal_reports listar bara butikens butiksrapporter (inte delägarrapporten eller andra butikers)", async () => {
    const a1 = await asUser(f.storeA1, (tx) => queryPortalReports(tx, f.a.storeId));
    expect(a1.map((r) => r.reportId)).toEqual([f.reportA1]);
    expect(a1.map((r) => r.reportId)).not.toContain(f.ownerReportA);
    const a2 = await asUser(f.storeA2, (tx) => queryPortalReports(tx, f.a2.storeId));
    expect(a2.map((r) => r.reportId)).toEqual([f.a2.reportId]);
  });

  it("en annan butiks rapport och delägarrapporten ger samma fel som en rapport som inte finns", async () => {
    const call = (reportId: string) =>
      sql`select * from public.portal_report(${f.a.storeId}::uuid, ${reportId}::uuid)`;
    const none = await failure(f.storeA1, call(RANDOM));
    expect(none).toEqual({ code: "P0002", message: "Rapporten finns inte." });
    expect(await failure(f.storeA1, call(f.a2.reportId))).toEqual(none);
    expect(await failure(f.storeA1, call(f.ownerReportA))).toEqual(none);
  });

  it("innehållet lämnas bara ut om det är en säker butiksrapport för butiken", async () => {
    const safe = {
      kind: "store",
      store: { id: f.a.storeId, name: "ICA Testbutik" },
      sales: { revenueOre: 16800, orders: 2 },
      weeks: [{ evidence: { scope: { storeId: f.a.storeId } } }],
    };
    const cases: [unknown, boolean][] = [
      [safe, true],
      [{ report: safe, sources: { prices: [{ unitCostOre: 4500 }] } }, true],
      [{ ...safe, sales: { revenueOre: 16800, unitCostOre: 4500 } }, false],
      [{ ...safe, weeks: [{ marginBp: 2500 }] }, false],
      [{ ...safe, weeks: [[{ profitOre: 1 }]] }, false],
      [{ ...safe, weeks: [{ evidence: { scope: { storeId: f.a2.storeId } } }] }, false],
      [{ ...safe, stores: [{ id: f.a2.storeId, name: "Coop" }] }, false],
      [{ ...safe, orders: [{ amountOre: 1 }] }, false],
      [{ ...safe, store: { id: f.a2.storeId, name: "Coop" } }, false],
      [{ revenueOre: 16800 }, false],
    ];
    for (const [snapshot, visible] of cases) {
      await asPostgres((tx) =>
        tx.execute(
          sql`update public.reports set data_snapshot = ${JSON.stringify(snapshot)}::jsonb
              where id = ${f.reportA1}`,
        ),
      );
      const detail = await asUser(f.storeA1, (tx) =>
        queryPortalReport(tx, f.a.storeId, f.reportA1),
      );
      expect([snapshot, detail.report !== null]).toEqual([snapshot, visible]);
      if (visible) {
        expect(detail.report).toEqual(safe);
        expect(JSON.stringify(detail.report)).not.toMatch(/cost|prices/i);
      }
    }
  });
});

describe("felanmälan", () => {
  it("blir ett ärende på automaten, skapat av butiksanvändaren, som ägaren ser", async () => {
    const id = await asUser(f.storeA1, (tx) =>
      one<{ id: string }>(
        tx,
        sql`select public.portal_report_fault(${f.a.storeId}::uuid, ${f.a.machineId}::uuid,
                                              'store_payment', 'Kortläsaren svarar inte') as id`,
      ),
    );
    const seen = await asUser(f.a.owner, (tx) =>
      one<{ machine_id: string; kind: string; created_by: string; status: string }>(
        tx,
        sql`select machine_id, kind, created_by, status from public.incidents where id = ${id.id}`,
      ),
    );
    expect(seen).toEqual({
      machine_id: f.a.machineId,
      kind: "store_payment",
      created_by: f.storeA1.id,
      status: "open",
    });
    const own = await asUser(f.storeA1, (tx) => queryPortalFaults(tx, f.a.storeId));
    expect(own.map((x) => x.incidentId)).toContain(id.id);
    expect(own.find((x) => x.incidentId === id.id)?.status).toBe("open");
    // A2 ser inte A1:s anmälan, inte ens om den frågar efter sin egen butik.
    const a2 = await asUser(f.storeA2, (tx) => queryPortalFaults(tx, f.a2.storeId));
    expect(a2.map((x) => x.incidentId)).not.toContain(id.id);
  });

  it("ärenden som operatören skapat syns inte i portalen", async () => {
    const own = await asUser(f.storeA1, (tx) => queryPortalFaults(tx, f.a.storeId));
    const internal = await rows<{ id: string }>(
      db(),
      sql`select id from public.incidents where organization_id = ${f.a.orgId} and kind not like 'store\\_%'`,
    );
    expect(internal.length).toBeGreaterThan(0);
    for (const i of internal) expect(own.map((x) => x.incidentId)).not.toContain(i.id);
  });

  it("anmälan finns kvar i butikens lista när operatören byter typ och status i Inkorgen", async () => {
    const id = await asUser(f.storeA1, (tx) =>
      one<{ id: string }>(
        tx,
        sql`select public.portal_report_fault(${f.a.storeId}::uuid, ${f.a.machineId}::uuid,
                                              'store_stuck', 'Packet fastnade') as id`,
      ),
    );
    await asUser(f.a.owner, (tx) =>
      tx.execute(
        sql`update public.incidents set kind = 'machine_fault', status = 'in_progress'
            where id = ${id.id}`,
      ),
    );
    const own = await asUser(f.storeA1, (tx) => queryPortalFaults(tx, f.a.storeId));
    const row = own.find((x) => x.incidentId === id.id);
    expect(row?.status).toBe("in_progress");
    expect(row?.kind).toBe("machine_fault");
  });

  it("en annan butiks automat ger samma fel som en automat som inte finns", async () => {
    const call = (machineId: string) =>
      sql`select public.portal_report_fault(${f.a.storeId}::uuid, ${machineId}::uuid, 'store_stuck', null)`;
    const none = await failure(f.storeA1, call(RANDOM));
    expect(none).toEqual({ code: "22023", message: "Automaten står inte i butiken." });
    expect(await failure(f.storeA1, call(f.a2.machineId))).toEqual(none);
    expect(await failure(f.storeA1, call(f.b.machineId))).toEqual(none);
  });

  it("validerar typ och beskrivning", async () => {
    const call = (kind: string, d: string | null) =>
      sql`select public.portal_report_fault(${f.a.storeId}::uuid, ${f.a.machineId}::uuid, ${kind}, ${d})`;
    expect((await failure(f.storeA1, call("drop_table", null)))?.code).toBe("22023");
    expect((await failure(f.storeA1, call("store_other", "  ")))?.code).toBe("22023");
    expect((await failure(f.storeA1, call("store_other", "x".repeat(1001))))?.code).toBe("22023");
  });

  it("högst 20 anmälningar per användare och dygn", async () => {
    const call = sql`select public.portal_report_fault(${f.b.storeId}::uuid, ${f.b.machineId}::uuid, 'store_empty', null)`;
    for (let i = 0; i < 20; i++) {
      expect(await failure(f.storeB1, call)).toBeNull();
    }
    expect((await failure(f.storeB1, call))?.code).toBe("BL030");
  });
});

describe("portalens siffror stämmer med appens beräkning", () => {
  it("ersättningen för mars 2025 är densamma som storeCompensation med all data", async () => {
    for (const [user, storeId] of [
      [f.storeA1, f.a.storeId],
      [f.storeA2, f.a2.storeId],
    ] as const) {
      const [store] = await asUser(user, queryPortalStores);
      const portal = await asUser(user, async (tx) => {
        const machines = await queryPortalMachines(tx, storeId);
        const agreements = await queryPortalAgreements(tx, storeId);
        const sales = await queryPortalSales(tx, storeId, {
          start: "2025-02-01",
          end: "2025-03-31",
        });
        return { machines, agreements, sales };
      });
      const sources = portalSources(store!, portal.sales, portal.agreements, portal.machines);
      const first = firstPortalMonth(portal.machines, null, "2025-03-31");
      const overview = buildPortalOverview(sources, storeId, "2025-03", first, "2025-04-15");

      // Appens beräkning med ALL organisationens data (läst som databasägare).
      const all = await asPostgres(async (tx) => {
        const orders = await rows<{
          id: string;
          external_id: string;
          title_id: string;
          machine_id: string | null;
          business_date: string;
          amount_ore: string;
        }>(
          tx,
          sql`select id, external_id, title_id, machine_id, business_date::text as business_date, amount_ore
              from public.orders where organization_id = ${f.a.orgId} and title_id is not null`,
        );
        const agreements = await rows<Record<string, unknown>>(
          tx,
          sql`select store_id, valid_from::text as valid_from, valid_to::text as valid_to,
                     commission_bp, monthly_rent_ore
              from public.store_agreements where organization_id = ${f.a.orgId}`,
        );
        const placements = await rows<Record<string, unknown>>(
          tx,
          sql`select machine_id, store_id, valid_from::text as valid_from, valid_to::text as valid_to
              from public.machine_placements where organization_id = ${f.a.orgId}`,
        );
        const prices = await rows<Record<string, unknown>>(
          tx,
          sql`select title_id, unit_cost_ore, valid_from::text as valid_from
              from public.purchase_prices where organization_id = ${f.a.orgId}`,
        );
        return { orders, agreements, placements, prices };
      });
      const app = storeCompensation({
        period: { start: "2025-03-01", end: "2025-03-31" },
        orders: all.orders.map((o): OrderLine => ({
          id: o.id,
          externalId: o.external_id,
          titleId: o.title_id,
          machineId: o.machine_id,
          businessDate: o.business_date,
          amountOre: Number(o.amount_ore),
        })),
        agreements: all.agreements.map((a) => ({
          storeId: String(a.store_id),
          validFrom: String(a.valid_from),
          validTo: a.valid_to === null ? null : String(a.valid_to),
          commissionBp: a.commission_bp === null ? null : Number(a.commission_bp),
          monthlyRentOre: a.monthly_rent_ore === null ? null : Number(a.monthly_rent_ore),
        })),
        placements: all.placements.map((p) => ({
          machineId: String(p.machine_id),
          storeId: String(p.store_id),
          from: String(p.valid_from),
          to: p.valid_to === null ? null : String(p.valid_to),
        })),
        prices: all.prices.map((p) => ({
          titleId: String(p.title_id),
          unitCostOre: Number(p.unit_cost_ore),
          validFrom: String(p.valid_from),
        })),
        settings: { vatRateBp: 0, cardFeeBp: 0 },
      });
      const expected = app.stores.find((s) => s.storeId === storeId)!;
      expect(overview.report.compensation.commissionOre).toBe(expected.commissionOre);
      expect(overview.report.compensation.rentOre).toBe(expected.rentOre);
      expect(overview.report.compensation.totalOre).toBe(expected.totalOre);
      expect(overview.report.compensation.totalOre).toBeGreaterThan(0);
      expect(JSON.stringify(overview)).not.toMatch(/unitCost|marginBp|profitOre|purchase/);
    }
  });
});
