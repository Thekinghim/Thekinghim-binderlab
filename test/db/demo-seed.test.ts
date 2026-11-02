/**
 * Demoseeden mot testdatabasen: körs två gånger (idempotens) och kontrolleras
 * mot generatorn och katalogen med SQL direkt i databasen. Orderna har gått
 * genom importen (en Awish-CSV per månad).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "../../src/import/file-store";
import { verifyPassword } from "../../src/server/auth/password";
import {
  DEMO_MACHINES,
  DEMO_NOW,
  DEMO_ORGANIZATION,
  DEMO_PAYOUT,
  DEMO_TITLES_WITHOUT_PRICE,
  DEMO_USERS,
} from "../../src/seed/demo/catalog";
import { generateDemo, ordersByMonth } from "../../src/seed/demo/generate";
import { runDemoSeed, type RunDemoSeedResult } from "../../src/seed/demo/run-demo-seed";
import { stockholmToUtcMs } from "../../src/seed/orders";
import { db, one, rows } from "./helpers";

const PASSWORD = "binderlab-dev-test";
const gen = generateDemo();

let first: RunDemoSeedResult;
let second: RunDemoSeedResult;
let org: string;
let countsAfterFirst: Record<string, number>;

const TABLES = [
  "memberships",
  "invitations",
  "stores",
  "contracts",
  "store_agreements",
  "machines",
  "machine_placements",
  "machine_investments",
  "machine_slots",
  "titles",
  "title_aliases",
  "purchase_prices",
  "data_sources",
  "source_machines",
  "imports",
  "orders",
  "stock_events",
  "suppliers",
  "supplier_items",
  "purchase_orders",
  "purchase_order_lines",
  "goals",
  "baselines",
  "effect_measurements",
  "fixed_costs",
  "expansion_leads",
  "report_recipients",
  "releases",
  "release_allocations",
  "owner_shares",
  "incidents",
  "payout_imports",
  "payouts",
  "payout_lines",
  "alerts",
  "alert_runs",
  "audit_log",
];

async function tableCounts(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(t)}
          where organization_id = ${orgId}::uuid`,
    );
    out[t] = r.n;
  }
  return out;
}

beforeAll(async () => {
  const fileStore = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-demo-")));
  first = await runDemoSeed(db(), { password: PASSWORD, manageUsers: true, fileStore });
  org = first.organizationId;
  countsAfterFirst = await tableCounts(org);
  second = await runDemoSeed(db(), { password: PASSWORD, manageUsers: true, fileStore });
}, 300_000);

describe("demo: order via importen", () => {
  it("samma order och summa som generatorn, en import per månad", async () => {
    const revenue = gen.orders.reduce((n, o) => n + o.amountOre, 0);
    expect(first.totals).toEqual({ orders: gen.orders.length, revenueOre: revenue });
    const perMonth = await rows<{ month: string; n: number }>(
      db(),
      sql`select to_char(business_date, 'YYYY-MM') as month, count(*)::int as n
          from public.orders where organization_id = ${org}::uuid group by 1 order by 1`,
    );
    expect(perMonth).toEqual(
      [...ordersByMonth(gen.orders)].map(([month, l]) => ({ month, n: l.length })),
    );
    const imports = await one<{ n: number; rows_new: number; failed: number }>(
      db(),
      sql`select count(*)::int as n, sum(rows_new)::int as rows_new,
                 count(*) filter (where status <> 'succeeded')::int as failed
          from public.imports where organization_id = ${org}::uuid`,
    );
    expect(imports).toEqual({ n: 10, rows_new: gen.orders.length, failed: 0 });
    const unmapped = await one<{ n: number }>(
      db(),
      sql`select count(*) filter (where machine_id is null or title_id is null)::int as n
          from public.orders where organization_id = ${org}::uuid`,
    );
    expect(unmapped.n).toBe(0);
  });

  it("perioden 1 feb – 2 nov, tio automater, lördag säljer mer än tisdag", async () => {
    const r = await one<{
      first: string;
      last: string;
      machines: number;
      sat: string;
      tue: string;
    }>(
      db(),
      sql`select min(business_date)::text as first, max(business_date)::text as last,
                 count(distinct machine_id)::int as machines,
                 sum(amount_ore) filter (where extract(isodow from business_date) = 6)::text as sat,
                 sum(amount_ore) filter (where extract(isodow from business_date) = 2)::text as tue
          from public.orders where organization_id = ${org}::uuid`,
    );
    expect(r.first).toBe("2026-02-01");
    expect(r.last).toBe("2026-11-02");
    expect(r.machines).toBe(DEMO_MACHINES.length);
    expect(Number(r.sat)).toBeGreaterThan(Number(r.tue) * 1.5);
  });

  it("två titlar saknar inköpspris, prisändringar finns", async () => {
    const r = await rows<{ name: string }>(
      db(),
      sql`select t.name from public.titles t
          where t.organization_id = ${org}::uuid
            and not exists (select 1 from public.purchase_prices p
                            where p.organization_id = t.organization_id and p.title_id = t.id)
          order by t.name`,
    );
    expect(r.map((x) => x.name)).toEqual([...DEMO_TITLES_WITHOUT_PRICE].sort());
    const changed = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from (
            select title_id from public.purchase_prices where organization_id = ${org}::uuid
            group by title_id having count(*) > 1) x`,
    );
    expect(changed.n).toBeGreaterThanOrEqual(3);
  });
});

describe("demo: butiker, avtal och automater", () => {
  it("automaten som flyttar har två placeringar i följd", async () => {
    const r = await rows<{ store: string; from: string; to: string | null }>(
      db(),
      sql`select s.name as store, mp.valid_from::text as "from", mp.valid_to::text as "to"
          from public.machine_placements mp
          join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
          join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
          where mp.organization_id = ${org}::uuid and m.code = 'NA-05' order by mp.valid_from`,
    );
    expect(r).toEqual([
      { store: "Stationskiosken Arboga", from: "2026-02-01", to: "2026-06-14" },
      { store: "Rutor och Rollspel", from: "2026-06-15", to: null },
    ]);
  });

  it("avtal: provision, hyra, båda, och ett som löper ut inom 90 dagar", async () => {
    const r = await one<{ commission: number; rent: number; both: number; expiring: number }>(
      db(),
      sql`select count(*) filter (where commission_bp is not null and monthly_rent_ore is null)::int as commission,
                 count(*) filter (where commission_bp is null and monthly_rent_ore is not null)::int as rent,
                 count(*) filter (where commission_bp is not null and monthly_rent_ore is not null)::int as both,
                 count(*) filter (where valid_to between ${DEMO_NOW.date}::date and ${DEMO_NOW.date}::date + 90)::int as expiring
          from public.store_agreements where organization_id = ${org}::uuid`,
    );
    expect(r.commission).toBeGreaterThan(0);
    expect(r.rent).toBeGreaterThan(0);
    expect(r.both).toBeGreaterThan(0);
    expect(r.expiring).toBe(1);
    const contract = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.contracts
          where organization_id = ${org}::uuid and valid_to between ${DEMO_NOW.date}::date and ${DEMO_NOW.date}::date + 90`,
    );
    expect(contract.n).toBe(1);
  });

  it("användarna har rätt roller och lösenord", async () => {
    const r = await rows<{ email: string; role: string; pw: string }>(
      db(),
      sql`select u.email::text as email, m.role::text as role, u.encrypted_password as pw
          from public.memberships m join auth.users u on u.id = m.user_id
          where m.organization_id = ${org}::uuid order by u.email`,
    );
    expect(Object.fromEntries(r.map((x) => [x.email, x.role]))).toEqual({
      [DEMO_USERS.owner.email]: "owner",
      [DEMO_USERS.viewer.email]: "viewer",
      [DEMO_USERS.refiller.email]: "refiller",
    });
    for (const u of r) {
      expect(await verifyPassword(PASSWORD, u.pw)).toBe(true);
    }
    const o = await one<{ name: string }>(
      db(),
      sql`select name from public.organizations where id = ${org}::uuid`,
    );
    expect(o.name).toBe(DEMO_ORGANIZATION.name);
  });
});

describe("demo: lager och inköp", () => {
  it("inget saldo är negativt, några är slut", async () => {
    const r = await one<{ negative: number; empty: number; total: number }>(
      db(),
      sql`select count(*) filter (where quantity < 0)::int as negative,
                 count(*) filter (where quantity = 0)::int as empty, count(*)::int as total
          from public.stock_levels where organization_id = ${org}::uuid`,
    );
    expect(r.negative).toBe(0);
    expect(r.empty).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThan(100);
  });

  it("slutsålda perioder: inventeringar som hittar titeln slut", async () => {
    // Inventeringar i automaterna som hittade titeln slut (i sortimentet, före påfyllning).
    const r = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events e
          where e.organization_id = ${org}::uuid and e.kind = 'count' and e.quantity = 0
            and e.note like 'Inventering vid månadens%'`,
    );
    expect(r.n).toBeGreaterThan(0);
    expect(gen.lostSales.length).toBeGreaterThan(150);
  });

  it("påfyllaren fyller på i automaterna, ägaren sköter centrallagret", async () => {
    const r = await rows<{ email: string; central: boolean; kinds: string[] }>(
      db(),
      sql`select u.email::text as email, l.is_central as central,
                 array_agg(distinct e.kind::text order by e.kind::text) as kinds
          from public.stock_events e
          join public.stock_locations l on l.organization_id = e.organization_id and l.id = e.location_id
          join auth.users u on u.id = e.performed_by
          where e.organization_id = ${org}::uuid and e.kind <> 'sale'
          group by 1, 2 order by 1, 2`,
    );
    expect(r).toHaveLength(2);
    expect(r).toEqual(
      expect.arrayContaining([
        { email: DEMO_USERS.owner.email, central: true, kinds: ["adjustment", "count", "receipt"] },
        { email: DEMO_USERS.refiller.email, central: false, kinds: ["count", "refill", "waste"] },
      ]),
    );
  });

  it("inköpsorder: inleveranser med historisk tid, inget stämplat med dagens tid", async () => {
    const now = new Date(stockholmToUtcMs(DEMO_NOW.date, DEMO_NOW.time)).toISOString();
    const late = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events
          where organization_id = ${org}::uuid and occurred_at > ${now}::timestamptz`,
    );
    expect(late.n).toBe(0);
    const po = await rows<{ status: string; n: number; received: number; lines: number }>(
      db(),
      sql`select po.status::text as status, count(distinct po.id)::int as n,
                 sum(l.received_quantity)::int as received, count(l.id)::int as lines
          from public.purchase_orders po
          join public.purchase_order_lines l on l.organization_id = po.organization_id and l.purchase_order_id = po.id
          where po.organization_id = ${org}::uuid group by 1 order by 1`,
    );
    const byStatus = Object.fromEntries(po.map((p) => [p.status, p]));
    expect(Object.keys(byStatus).sort()).toEqual(["draft", "ordered", "received"]);
    const receipts = await one<{ n: number; q: number }>(
      db(),
      sql`select count(*)::int as n, sum(quantity)::int as q from public.stock_events
          where organization_id = ${org}::uuid and kind = 'receipt'`,
    );
    expect(receipts).toEqual({ n: byStatus.received?.lines, q: byStatus.received?.received });
    expect(byStatus.ordered?.received).toBe(0);
  });
});

describe("demo: ekonomi, drift och planering", () => {
  it("utbetalningar per månad med en avsiktlig avvikelse", async () => {
    const r = await rows<{
      reference: string;
      month: string;
      paid: string;
      sales: string;
      refunds: string;
    }>(
      db(),
      sql`select p.reference, to_char(p.period_start, 'YYYY-MM') as month, p.amount_ore::text as paid,
                 (select coalesce(sum(o.amount_ore), 0) from public.orders o
                  where o.organization_id = p.organization_id
                    and o.business_date between p.period_start and p.period_end)::text as sales,
                 (select coalesce(sum(i.refunded_ore), 0) from public.incidents i
                  where i.organization_id = p.organization_id
                    and i.refunded_on between p.period_start and p.period_end)::text as refunds
          from public.payouts p where p.organization_id = ${org}::uuid order by p.period_start`,
    );
    expect(r).toHaveLength(9);
    for (const p of r) {
      const diff = Number(p.sales) - Number(p.refunds) - Number(p.paid);
      if (p.month === DEMO_PAYOUT.deviationMonth) {
        expect(diff).toBeGreaterThan(0);
      } else {
        expect(diff, p.reference).toBe(0);
      }
    }
    const missing = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders o
          join public.payouts p on p.organization_id = o.organization_id and p.reference = ${`${DEMO_PAYOUT.referencePrefix}${DEMO_PAYOUT.linesMonth}`}
          where o.organization_id = ${org}::uuid
            and o.business_date between p.period_start and p.period_end
            and not exists (select 1 from public.payout_lines l
                            where l.organization_id = o.organization_id and l.payout_id = p.id
                              and l.external_id = o.external_id)`,
    );
    expect(missing.n).toBe(DEMO_PAYOUT.missingOrders);
  });

  it("kundärenden, larm, fasta kostnader, mål, utgångsläge och expansion", async () => {
    const c = await tableCounts(org);
    expect(c.incidents).toBe(5);
    expect(c.fixed_costs).toBe(6);
    expect(c.goals).toBe(33);
    expect(c.baselines).toBe(4);
    expect(c.expansion_leads).toBe(6);
    expect(c.report_recipients).toBe(7);
    expect(c.suppliers).toBe(2);
    expect(c.releases).toBe(4);
    expect(c.release_allocations).toBeGreaterThan(20);
    const alerts = await rows<{ kind: string }>(
      db(),
      sql`select distinct kind from public.alerts where organization_id = ${org}::uuid and status = 'open'`,
    );
    expect(alerts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["machine_offline", "low_stock"]),
    );
    const refunds = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.incidents
          where organization_id = ${org}::uuid and refunded_ore > 0 and order_id is not null`,
    );
    expect(refunds.n).toBe(2);
  });
});

describe("demo: idempotens", () => {
  it("en andra körning skapar inget nytt", async () => {
    expect(await tableCounts(org)).toEqual(countsAfterFirst);
    for (const [name, s] of Object.entries(second.sections)) {
      expect(s.created, name).toBe(0);
    }
    expect(second.imports.every((i) => i.imported === null)).toBe(true);
    expect(second.stockEvents).toBe(0);
    expect(second.alerts).toBeNull();
    expect(second.organizationId).toBe(org);
    expect(second.totals).toEqual(first.totals);
  });
});
