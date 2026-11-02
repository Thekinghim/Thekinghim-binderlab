/**
 * Seeden mot binderlab_test: körs två gånger (idempotens) och kontrolleras
 * mot facit med SQL direkt i databasen. Orderna har gått genom importen.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "../../src/import/file-store";
import { verifyPassword } from "../../src/server/auth/password";
import { SEED_LAST_ORDERS, SEED_USERS } from "../../src/seed/catalog";
import { runSeed, type RunSeedResult } from "../../src/seed/run-seed";
import { db, one, rows } from "./helpers";

const PASSWORD = "binderlab-dev-test";

let first: RunSeedResult;
let second: RunSeedResult;
let org: string;

/** Antal rader per tabell för organisationen (för idempotensen). */
async function tableCounts(orgId: string): Promise<Record<string, number>> {
  const tables = [
    "memberships",
    "profiles",
    "invitations",
    "organization_settings",
    "ledger_accounts",
    "stores",
    "store_agreements",
    "machines",
    "machine_placements",
    "machine_investments",
    "titles",
    "title_aliases",
    "purchase_prices",
    "data_sources",
    "source_machines",
    "imports",
    "import_rows",
    "orders",
    "stock_locations",
    "stock_events",
    "audit_log",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(t)}
          where organization_id = ${orgId}::uuid`,
    );
    out[t] = r.n;
  }
  return out;
}

let countsAfterFirst: Record<string, number>;

beforeAll(async () => {
  const fileStore = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-seed-")));
  first = await runSeed(db(), { password: PASSWORD, manageUsers: true, fileStore });
  org = first.organizationId;
  countsAfterFirst = await tableCounts(org);
  second = await runSeed(db(), { password: PASSWORD, manageUsers: true, fileStore });
}, 120_000);

describe("seed: order (via importen)", () => {
  it("460 order, 79 987 kr, snitt 173,88 kr", async () => {
    const r = await one<{ n: number; total: string; avg: string }>(
      db(),
      sql`select count(*)::int as n, sum(amount_ore)::text as total,
                 round(avg(amount_ore))::text as avg
          from public.orders where organization_id = ${org}::uuid`,
    );
    expect(r.n).toBe(460);
    expect(r.total).toBe("7998700");
    expect(r.avg).toBe("17388");
    expect(first.totals).toEqual({ orders: 460, revenueOre: 7_998_700 });
  });

  it("per titel exakt", async () => {
    const r = await rows<{ name: string; n: number; kr: string }>(
      db(),
      sql`select t.name, count(*)::int as n, (sum(o.amount_ore) / 100)::text as kr
          from public.orders o
          join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
          where o.organization_id = ${org}::uuid
          group by t.name order by count(*) desc, t.name`,
    );
    const map = Object.fromEntries(r.map((x) => [x.name, [x.n, Number(x.kr)]]));
    expect(map).toEqual({
      "30th Celebration": [150, 26_475],
      "Mystery Pack": [62, 12_338],
      "Surging Sparks": [48, 5_830],
      "Prismatic Evolution": [45, 8_740],
      "Ascended Heroes": [43, 8_127],
      "Phantasmal Flames": [20, 3_580],
      "Black bolt": [20, 2_980],
      "Destin Rivals": [16, 2_704],
      "Perfect Order": [15, 2_235],
      "Mega Evolution": [14, 2_226],
      "White Flair": [10, 1_590],
      "Paldea Evolved": [9, 1_170],
      "Mystery pack premium": [8, 1_992],
    });
    const others = r.filter((x) => x.n < 43);
    expect(others.reduce((n, x) => n + x.n, 0)).toBe(112);
    expect(others.reduce((n, x) => n + Number(x.kr), 0)).toBe(18_477);
  });

  it("bästa dagen är 26 okt med 8 300–8 500 kr (svenskt affärsdatum)", async () => {
    const r = await rows<{ day: string; kr: string }>(
      db(),
      sql`select business_date::text as day, (sum(amount_ore) / 100)::text as kr
          from public.orders where organization_id = ${org}::uuid
          group by business_date order by sum(amount_ore) desc limit 2`,
    );
    expect(r[0]?.day).toBe("2026-10-26");
    const best = Number(r[0]?.kr);
    expect(best).toBeGreaterThanOrEqual(8_300);
    expect(best).toBeLessThanOrEqual(8_500);
    expect(Number(r[1]?.kr)).toBeLessThan(best);
    const days = await one<{ n: number; first: string; last: string }>(
      db(),
      sql`select count(distinct business_date)::int as n, min(business_date)::text as first,
                 max(business_date)::text as last
          from public.orders where organization_id = ${org}::uuid`,
    );
    expect(days).toEqual({ n: 20, first: "2026-10-13", last: "2026-11-01" });
  });

  it("de fyra senaste orderna med svensk tid", async () => {
    const r = await rows<{
      external_id: string;
      raw_title: string;
      local: string;
      amount_ore: string;
    }>(
      db(),
      sql`select external_id, raw_title,
                 to_char(ordered_at at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI:SS') as local,
                 amount_ore::text as amount_ore
          from public.orders where organization_id = ${org}::uuid
          order by ordered_at desc limit 4`,
    );
    expect(
      r.reverse().map((o) => ({
        externalId: o.external_id,
        title: o.raw_title,
        amountOre: Number(o.amount_ore),
        stockholmTime: o.local,
      })),
    ).toEqual(SEED_LAST_ORDERS);
    const last = await one<{ utc: string; shanghai: string }>(
      db(),
      sql`select to_char(ordered_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc,
                 to_char(ordered_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') as shanghai
          from public.orders where organization_id = ${org}::uuid and external_id = '42780'`,
    );
    expect(last).toEqual({ utc: "2026-11-01 16:17", shanghai: "2026-11-02 00:17" });
  });

  it("ordernumren 42321–42780 ligger i tidsordning", async () => {
    const r = await one<{ min: string; max: string; out_of_order: number }>(
      db(),
      sql`select min(external_id::int)::text as min, max(external_id::int)::text as max,
                 count(*) filter (where prev_at >= ordered_at)::int as out_of_order
          from (
            select external_id, ordered_at,
                   lag(ordered_at) over (order by external_id::int) as prev_at
            from public.orders where organization_id = ${org}::uuid
          ) x`,
    );
    expect(r).toEqual({ min: "42321", max: "42780", out_of_order: 0 });
  });

  it("gick genom importen: en import, 460 nya rader, automat och titel kopplade", async () => {
    const imp = await one<{ n: number; rows_new: number; parser: string; status: string }>(
      db(),
      sql`select count(*)::int as n, max(rows_new)::int as rows_new,
                 max(parser_version) as parser, max(status::text) as status
          from public.imports where organization_id = ${org}::uuid`,
    );
    expect(imp).toEqual({
      n: 1,
      rows_new: 460,
      parser: "awish_csv/2+pipeline/2",
      status: "succeeded",
    });
    expect(first.import?.summary).toMatchObject({ new: 460, duplicate: 0, conflict: 0, error: 0 });
    expect(first.import?.firstRow).toMatchObject({
      externalId: "42780",
      sourceLocal: "2026-11-02 00:17:00",
      organizationLocal: "2026-11-01 17:17:00",
    });
    const unmapped = await one<{ n: number; sales: number }>(
      db(),
      sql`select count(*) filter (where machine_id is null or title_id is null or import_id is null)::int as n,
                 (select count(*)::int from public.stock_events e
                  where e.organization_id = ${org}::uuid and e.kind = 'sale') as sales
          from public.orders where organization_id = ${org}::uuid`,
    );
    expect(unmapped).toEqual({ n: 0, sales: 460 });
  });
});

describe("seed: inköpspriser", () => {
  it("två titlar saknar inköpspris", async () => {
    const r = await rows<{ name: string }>(
      db(),
      sql`select t.name from public.titles t
          where t.organization_id = ${org}::uuid
            and not exists (select 1 from public.purchase_prices p
                            where p.organization_id = t.organization_id and p.title_id = t.id)
          order by t.name`,
    );
    expect(r.map((x) => x.name)).toEqual(["Perfect Order", "White Flair"]);
  });

  it("30th Celebration byter inköpspris 27 okt: gamla order räknas med det gamla priset", async () => {
    const r = await rows<{ unit: string; n: number; first: string; last: string }>(
      db(),
      sql`select p.unit_cost_ore::text as unit, count(*)::int as n,
                 min(o.business_date)::text as first, max(o.business_date)::text as last
          from public.orders o
          join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
          join public.purchase_price_periods p
            on p.organization_id = o.organization_id and p.title_id = o.title_id
           and o.business_date >= p.valid_from
           and (p.valid_to is null or o.business_date <= p.valid_to)
          where o.organization_id = ${org}::uuid and t.name = '30th Celebration'
          group by p.unit_cost_ore order by p.unit_cost_ore`,
    );
    expect(r.map((x) => x.unit)).toEqual(["10500", "11200"]);
    expect(r[0]?.last).toBe("2026-10-26");
    expect(r[1]?.first).toBe("2026-10-27");
    expect((r[0]?.n ?? 0) + (r[1]?.n ?? 0)).toBe(150);
  });

  it("bruttomarginalen för order med pris är realistisk (30–45 %)", async () => {
    const r = await one<{ revenue: string; cost: string; unpriced: string }>(
      db(),
      sql`select sum(o.amount_ore) filter (where p.unit_cost_ore is not null)::text as revenue,
                 sum(p.unit_cost_ore)::text as cost,
                 sum(o.amount_ore) filter (where p.unit_cost_ore is null)::text as unpriced
          from public.orders o
          left join public.purchase_price_periods p
            on p.organization_id = o.organization_id and p.title_id = o.title_id
           and o.business_date >= p.valid_from
           and (p.valid_to is null or o.business_date <= p.valid_to)
          where o.organization_id = ${org}::uuid`,
    );
    const revenue = BigInt(r.revenue);
    const cost = BigInt(r.cost);
    const marginBp = ((revenue - cost) * 10_000n) / revenue;
    expect(marginBp).toBeGreaterThanOrEqual(3_000n);
    expect(marginBp).toBeLessThanOrEqual(4_500n);
    // Intäkt utan inköpspris: Perfect Order 2 235 kr + White Flair 1 590 kr.
    expect(r.unpriced).toBe("382500");
  });

  it("prisändringarna står i ändringsloggen med ägaren som aktör", async () => {
    const r = await one<{ n: number; actors: string[] }>(
      db(),
      sql`select count(*)::int as n, array_agg(distinct actor_id::text) as actors
          from public.audit_log
          where organization_id = ${org}::uuid and table_name = 'purchase_prices'`,
    );
    expect(r.n).toBe(12);
    expect(r.actors).toEqual([first.users.owner]);
  });
});

describe("seed: organisation, användare, butiker", () => {
  it("ägare och delägare (läsare via inbjudan) med lösenord i dev-formatet", async () => {
    const r = await rows<{ email: string; role: string; display_name: string; pw: string }>(
      db(),
      sql`select u.email::text as email, m.role::text as role, p.display_name, u.encrypted_password as pw
          from public.memberships m
          join auth.users u on u.id = m.user_id
          join public.profiles p on p.organization_id = m.organization_id and p.user_id = m.user_id
          where m.organization_id = ${org}::uuid order by m.role`,
    );
    expect(r.map((x) => [x.email, x.role, x.display_name])).toEqual([
      [SEED_USERS.owner.email, "owner", "Ägare"],
      [SEED_USERS.partner.email, "viewer", "Delägare"],
    ]);
    for (const u of r) {
      expect(u.pw).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
      expect(await verifyPassword(PASSWORD, u.pw)).toBe(true);
      expect(await verifyPassword("fel-lösenord-123", u.pw)).toBe(false);
    }
    const inv = await one<{ n: number; accepted: number }>(
      db(),
      sql`select count(*)::int as n, count(accepted_at)::int as accepted
          from public.invitations where organization_id = ${org}::uuid`,
    );
    expect(inv).toEqual({ n: 1, accepted: 1 });
  });

  it("tre exempelbutiker med var sin automat och olika avtal", async () => {
    const r = await rows<{
      store: string;
      store_example: boolean;
      code: string;
      machine_example: boolean;
      commission_bp: number | null;
      rent: string | null;
      from: string;
    }>(
      db(),
      sql`select s.name as store, s.is_example as store_example, m.code, m.is_example as machine_example,
                 a.commission_bp, a.monthly_rent_ore::text as rent, mp.valid_from::text as "from"
          from public.machine_placements mp
          join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
          join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
          join public.store_agreements a on a.organization_id = s.organization_id and a.store_id = s.id
          where mp.organization_id = ${org}::uuid order by m.code`,
    );
    expect(r.map((x) => [x.code, x.commission_bp, x.rent, x.from])).toEqual([
      ["BL-001", 1200, null, "2026-10-01"],
      ["BL-002", null, "150000", "2026-10-01"],
      ["BL-003", 800, "75000", "2026-10-01"],
    ]);
    for (const x of r) {
      expect(x.store).toMatch(/\(exempel\)$/);
      expect(x.store_example && x.machine_example).toBe(true);
    }
    const inv = await one<{ n: number; machines: number }>(
      db(),
      sql`select count(*)::int as n, count(distinct machine_id)::int as machines
          from public.machine_investments where organization_id = ${org}::uuid`,
    );
    expect(inv).toEqual({ n: 4, machines: 3 });
  });

  it("inställningar, konton och datakälla", async () => {
    const s = await one<{ vat: number; card: number }>(
      db(),
      sql`select vat_rate_bp as vat, card_fee_bp as card
          from public.organization_settings where organization_id = ${org}::uuid`,
    );
    expect(s).toEqual({ vat: 0, card: 0 });
    const accounts = await rows<{ key: string; bas: string }>(
      db(),
      sql`select key, bas_account as bas from public.ledger_accounts
          where organization_id = ${org}::uuid order by key`,
    );
    expect(Object.fromEntries(accounts.map((a) => [a.key, a.bas]))).toMatchObject({
      sales: "3004",
      cogs: "4010",
      rent: "5010",
      store_commission: "6050",
      card_fees: "6040",
      vat_out: "2611",
      bank: "1930",
    });
    const ds = await one<{ provider: string; tz: string; mapped: number }>(
      db(),
      sql`select d.provider::text as provider, d.source_timezone as tz,
                 (select count(*)::int from public.source_machines sm
                  where sm.organization_id = d.organization_id and sm.data_source_id = d.id
                    and sm.machine_id is not null) as mapped
          from public.data_sources d where d.organization_id = ${org}::uuid`,
    );
    expect(ds).toEqual({ provider: "awish_csv", tz: "Asia/Shanghai", mapped: 3 });
  });
});

describe("seed: lager", () => {
  it("inget saldo är negativt; ett par slut, några låga, en titel slut i centrallagret", async () => {
    const levels = await rows<{ location: string; central: boolean; title: string; qty: number }>(
      db(),
      sql`select l.name as location, l.is_central as central, t.name as title, sl.quantity as qty
          from public.stock_levels sl
          join public.stock_locations l on l.organization_id = sl.organization_id and l.id = sl.location_id
          join public.titles t on t.organization_id = sl.organization_id and t.id = sl.title_id
          where sl.organization_id = ${org}::uuid`,
    );
    expect(levels).toHaveLength(4 * 13);
    expect(Math.min(...levels.map((l) => l.qty))).toBe(0);
    const machines = levels.filter((l) => !l.central);
    expect(machines.filter((l) => l.qty === 0)).toHaveLength(1);
    expect(machines.filter((l) => l.qty >= 1 && l.qty <= 2).length).toBeGreaterThanOrEqual(3);
    expect(levels.filter((l) => l.central && l.qty === 0).map((l) => l.title)).toEqual([
      "Prismatic Evolution",
    ]);
  });

  it("inventering 12 okt, påfyllningar under perioden, leverans 27 okt", async () => {
    const r = await rows<{ kind: string; n: number; first: string; last: string }>(
      db(),
      sql`select kind::text as kind, count(*)::int as n, min(business_date)::text as first,
                 max(business_date)::text as last
          from public.stock_events where organization_id = ${org}::uuid
          group by kind order by kind`,
    );
    const byKind = Object.fromEntries(r.map((x) => [x.kind, x]));
    expect(byKind.count).toMatchObject({ n: 52, first: "2026-10-12", last: "2026-10-12" });
    expect(byKind.receipt).toMatchObject({ n: 1, first: "2026-10-27" });
    expect(byKind.refill?.first).toBe("2026-10-15");
    expect(byKind.refill?.last).toBe("2026-10-30");
    expect(byKind.adjustment?.n).toBe(byKind.refill?.n);
    expect(byKind.sale?.n).toBe(460);
    const performer = await one<{ performers: string[] }>(
      db(),
      sql`select array_agg(distinct performed_by::text) as performers from public.stock_events
          where organization_id = ${org}::uuid and kind <> 'sale'`,
    );
    expect(performer.performers).toEqual([first.users.owner]);
  });
});

describe("seed: idempotens", () => {
  it("en andra körning skapar inget nytt", async () => {
    expect(await tableCounts(org)).toEqual(countsAfterFirst);
    for (const [name, s] of Object.entries(second.sections)) {
      expect(s.created, name).toBe(0);
    }
    expect(second.import).toBeNull();
    expect(second.stockEvents).toBe(0);
    expect(second.organizationId).toBe(org);
    expect(second.totals).toEqual(first.totals);
  });

  it("första körningen skapade allt", () => {
    expect(first.sections).toMatchObject({
      users: { created: 2 },
      organization: { created: 1 },
      memberships: { created: 1 },
      stores: { created: 3 },
      machines: { created: 3 },
      titles: { created: 13 },
      purchase_prices: { created: 12 },
      source_machines: { created: 3 },
    });
    expect(first.stockEvents).toBeGreaterThan(300);
  });
});
