/**
 * Oberoende revision av test/db/consistency.test.ts (fas 2–5, avstämning).
 *
 * consistency.test.ts jämför sidorna med VARANDRA. Hem, Lönsamhet, Automater och Butiker
 * bygger alla på loadDomainInput + profitability(), så den jämförelsen kan inte upptäcka ett
 * fel i själva beräkningen (t.ex. fel hyra per dag): alla sidor blir fel på samma sätt. Det
 * testet kontrollerar aldrig den totala vinsten mot ett handräknat tal, bara skillnader.
 *
 * Här kontrolleras sidorna mot facit som INTE går via beräkningslagret:
 *   1. handräknade tal (uträkningen står i kommentarerna, bara seedens rådata används),
 *   2. en fristående SQL-uträkning av reglerna i docs/berakningar.md (pris som gällde
 *      orderns business_date, provision på belopp exkl. moms enligt butikens avtal den dagen,
 *      hyra per butik och månad = round(månadshyra × dagar / dagar i månaden)).
 *
 * Seeden körs i en egen organisation (runSeed med organization/users), som i
 * consistency.test.ts. Klockan står på 2 nov. 2026 kl. 11 svensk tid.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/db/client";
import type { OrganizationMembership, SessionUser } from "@/server/access";

const session = vi.hoisted(() => ({
  current: null as null | { user: SessionUser; organization: OrganizationMembership },
}));

vi.mock("@/server/session", async () => {
  const access = await import("@/server/access");
  const who = () => {
    if (!session.current) throw new Error("Ingen inloggad i testet.");
    return session.current;
  };
  return {
    AuthorizationError: access.AuthorizationError,
    getSessionUser: async () => session.current?.user ?? null,
    requireUser: async () => who().user,
    getActiveOrganization: async () => who().organization,
    withUserDb: <T>(fn: (tx: Tx) => Promise<T>) => access.withUserDbFor(who().user, fn),
    requireRole: async (organizationId: string, roles: readonly string[]) => {
      const user = who().user;
      const role = await access.requireRoleFor(user, organizationId, roles as never);
      return { user, role };
    },
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  permanentRedirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

// Den aktiva organisationen läses ur cookien (loadViewer): den inloggades organisation.
vi.mock("@/server/auth/next-cookies", () => ({
  nextCookieJar: async () => ({
    get: () => session.current?.organization.id,
    getAll: () => [],
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
}));

import { addPurchasePrice } from "@/app/(app)/inkopspriser/actions";
import { loadHome } from "@/app/(app)/_hem/load";
import type { HomeData } from "@/app/(app)/_hem/data";
import { buildLonsamhetModel, type LonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import { loadOverview } from "@/app/(app)/automater/_lib/data";
import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { carriedQuery, type SearchParamsInput } from "@/components/shell/period-state";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor } from "@/server/access";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";
import { runSeed } from "@/seed/run-seed";

import { db, one, rows, uniqueSuffix } from "./helpers";

const NOW = new Date("2026-11-02T10:00:00Z");
const SEED_RANGE = { from: "2026-10-13", to: "2026-11-01" } as const;

let orgId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };
const titleIds = new Map<string, string>();
const machineIds = new Map<string, string>();
const storeIds = new Map<string, string>();

const id = (m: Map<string, string>, key: string) => {
  const v = m.get(key);
  if (!v) throw new Error(`Saknar ${key}`);
  return v;
};

async function lonsamhet(sp: SearchParamsInput): Promise<LonsamhetModel> {
  const ctx = await requireRoute("lonsamhet");
  const p = await loadPeriod(sp);
  const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
  return buildLonsamhetModel(
    {
      current: input.current,
      previous: input.previous,
      titles: input.titles,
      machines: input.machines,
      stores: input.stores,
      scope: input.scope,
    },
    { today: ctx.today, carry: carriedQuery(sp).replace(/^\?/, ""), lastOrderDate: null },
  );
}

function kpi(home: HomeData, k: string): number | null {
  const x = home.model.kpis.find((y) => y.id === k);
  if (!x) throw new Error(`Hem saknar ${k}`);
  return x.value;
}

// ---------------------------------------------------------------------------
// Fristående facit i SQL (använder inte src/domain).
// ---------------------------------------------------------------------------

interface Facit {
  orders: number;
  revenueAll: number;
  revenuePriced: number;
  cost: number;
  fees: number;
  commissionPriced: number;
  commissionUnpriced: number;
  rent: number;
  profit: number;
  marginBp: number | null;
}

async function facit(from: string, to: string, machineCode?: string): Promise<Facit> {
  const r = await one<Record<string, string | number | null>>(
    db(),
    sql`
    with s as (
      select vat_rate_bp::numeric vat, card_fee_bp::numeric card
      from public.organization_settings where organization_id = ${orgId}::uuid
    ), o as (
      select o.business_date d, o.amount_ore::numeric b, m.code,
        (select p.unit_cost_ore from public.purchase_prices p
          where p.organization_id = o.organization_id and p.title_id = o.title_id
            and p.valid_from <= o.business_date
          order by p.valid_from desc limit 1) as cost,
        (select pl.store_id from public.machine_placements pl
          where pl.organization_id = o.organization_id and pl.machine_id = o.machine_id
            and o.business_date between pl.valid_from and coalesce(pl.valid_to, '9999-12-31'))
          as store_id
      from public.orders o
      left join public.machines m on m.organization_id = o.organization_id and m.id = o.machine_id
      where o.organization_id = ${orgId}::uuid
        and o.business_date between ${from}::date and ${to}::date
    ), o2 as (
      select o.*, round(o.b * s.vat / (10000 + s.vat)) as vat_ore,
             round(o.b * s.card / 10000) as fee
      from o, s
    ), o3 as (
      select o2.*, o2.b - o2.vat_ore as net,
        coalesce((select round((o2.b - o2.vat_ore) * a.commission_bp / 10000)
          from public.store_agreements a
          where a.organization_id = ${orgId}::uuid and a.store_id = o2.store_id
            and o2.d between a.valid_from and coalesce(a.valid_to, '9999-12-31')), 0) as comm
      from o2
      where ${machineCode ?? null}::text is null or o2.code = ${machineCode ?? null}::text
    ), days as (
      select g::date d from generate_series(${from}::date, ${to}::date, interval '1 day') g
    ), rent as (
      select a.store_id, date_trunc('month', days.d) m,
        round(sum(a.monthly_rent_ore)::numeric
          / extract(day from date_trunc('month', days.d) + interval '1 month - 1 day')) rent
      from days
      join public.store_agreements a on a.organization_id = ${orgId}::uuid
        and days.d between a.valid_from and coalesce(a.valid_to, '9999-12-31')
        and a.monthly_rent_ore is not null
      -- hyran hör till butiken; med automatfilter bara butiker där automaten stod
      where ${machineCode ?? null}::text is null or a.store_id in (
        select pl.store_id from public.machine_placements pl
        join public.machines m on m.id = pl.machine_id
        where m.organization_id = ${orgId}::uuid and m.code = ${machineCode ?? null}::text
          and days.d between pl.valid_from and coalesce(pl.valid_to, '9999-12-31'))
      group by 1, 2
    )
    select count(*)::int as orders,
      coalesce(sum(net), 0)::bigint as revenue_all,
      coalesce(sum(net) filter (where cost is not null), 0)::bigint as revenue_priced,
      coalesce(sum(cost), 0)::bigint as cost,
      coalesce(sum(fee) filter (where cost is not null), 0)::bigint as fees,
      coalesce(sum(comm) filter (where cost is not null), 0)::bigint as comm_priced,
      coalesce(sum(comm) filter (where cost is null), 0)::bigint as comm_unpriced,
      (select coalesce(sum(rent), 0) from rent)::bigint as rent
    from o3`,
  );
  const n = (k: string) => Number(r[k]);
  const revenuePriced = n("revenue_priced");
  const profit = revenuePriced - n("cost") - n("fees") - n("comm_priced") - n("rent");
  return {
    orders: n("orders"),
    revenueAll: n("revenue_all"),
    revenuePriced,
    cost: n("cost"),
    fees: n("fees"),
    commissionPriced: n("comm_priced"),
    commissionUnpriced: n("comm_unpriced"),
    rent: n("rent"),
    profit,
    // round half up (bort från noll)
    marginBp:
      revenuePriced === 0
        ? null
        : Math.sign(profit) * Math.round(Math.abs(profit * 10_000) / revenuePriced),
  };
}

async function expectPagesMatchFacit(sp: SearchParamsInput, from: string, to: string) {
  const f = await facit(from, to);
  const home = await loadHome(sp);
  const l = await lonsamhet(sp);
  const label = JSON.stringify(sp);
  expect(home.model.period, label).toMatchObject({ start: from, end: to });
  expect(kpi(home, "revenue"), label).toBe(f.revenueAll);
  expect(kpi(home, "orders"), label).toBe(f.orders);
  expect(kpi(home, "profit"), label).toBe(f.profit);
  expect(kpi(home, "margin"), label).toBe(f.marginBp);
  expect(l.totals.revenueOre, label).toBe(f.revenuePriced);
  expect(l.totals.costOre, label).toBe(f.cost);
  expect(l.totals.feesOre, label).toBe(f.fees);
  expect(l.bridge.commissionOre, label).toBe(f.commissionPriced);
  expect(l.bridge.rentOre, label).toBe(f.rent);
  expect(l.totals.profitOre, label).toBe(f.profit);
  expect(l.bridge.marginBp, label).toBe(f.marginBp);
  return f;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-revision",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-revision-"))),
    organization: { name: `Revision ${suffix}`, slug: `revision-${suffix}` },
    users: {
      owner: { email: `rev-agare-${suffix}@test.binderlab.se`, fullName: "Ägare", role: "owner" },
      partner: {
        email: `rev-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  const user = { userId: seeded.users.owner, email: `rev-agare-${suffix}@test.binderlab.se` };
  const org = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!org) throw new Error("Saknar medlemskap");
  owner = { user, organization: org };
  session.current = owner;

  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.titles where organization_id = ${orgId}::uuid`,
  ))
    titleIds.set(r.name, r.id);
  for (const r of await rows<{ id: string; code: string }>(
    db(),
    sql`select id, code from public.machines where organization_id = ${orgId}::uuid`,
  ))
    machineIds.set(r.code, r.id);
  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.stores where organization_id = ${orgId}::uuid`,
  ))
    storeIds.set(r.name, r.id);

  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 180_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
});

describe("handräknat mot seedens rådata (moms 0, kortavgift 0)", () => {
  /*
   * Rådata (se SQL-frågorna i testet nedan; alla 460 order har automat och titel):
   *   BL-001 Spelbutiken Centrum, 12 %, ingen hyra:   205 order, 3 537 600; prissatta 196 / 3 399 500,
   *                                                    inköp 2 111 350, utan pris 138 100
   *   BL-002 Gallerian Väst, 1 500 kr/mån:            141 order, 2 473 600; prissatta 134 / 2 365 300,
   *                                                    inköp 1 467 950, utan pris 108 300
   *   BL-003 Kiosken Stationen, 8 % + 750 kr/mån:     114 order, 1 987 500; prissatta 105 / 1 851 400,
   *                                                    inköp 1 142 100, utan pris 136 100
   * Provision prissatta: 3 399 500 × 12 % = 407 940; 1 851 400 × 8 % = 148 112; summa 556 052
   * Provision utan pris: 138 100 × 12 % = 16 572;    136 100 × 8 % = 10 888;    summa 27 460
   *
   * Hyra 13 okt.–1 nov. (19 dagar av 31 i okt., 1 av 30 i nov.):
   *   Gallerian: round(150 000 × 19 / 31) = round(91 935,48) = 91 935; nov 150 000 / 30 = 5 000
   *   Kiosken:   round( 75 000 × 19 / 31) = round(45 967,74) = 45 968; nov  75 000 / 30 = 2 500
   *   summa 145 403
   * Vinst = 7 616 200 − 4 721 400 − 0 − 556 052 − 145 403 = 2 193 345
   * Marginal = round(2 193 345 × 10 000 / 7 616 200) = round(2 879,8) = 2 880 bp
   */
  it("rådatan är den som handräkningen bygger på", async () => {
    const perMachine = await rows<Record<string, string | number>>(
      db(),
      sql`with o as (
            select m.code, o.amount_ore,
              (select p.unit_cost_ore from public.purchase_prices p
                where p.organization_id = o.organization_id and p.title_id = o.title_id
                  and p.valid_from <= o.business_date order by p.valid_from desc limit 1) cost
            from public.orders o join public.machines m on m.id = o.machine_id
            where o.organization_id = ${orgId}::uuid)
          select code, count(*)::int n, sum(amount_ore)::bigint rev,
            count(cost)::int np, sum(amount_ore) filter (where cost is not null)::bigint revp,
            sum(cost)::bigint cost
          from o group by code order by code`,
    );
    expect(
      perMachine.map((r) => [r.code, r.n, Number(r.rev), r.np, Number(r.revp), Number(r.cost)]),
    ).toEqual([
      ["BL-001", 205, 3_537_600, 196, 3_399_500, 2_111_350],
      ["BL-002", 141, 2_473_600, 134, 2_365_300, 1_467_950],
      ["BL-003", 114, 1_987_500, 105, 1_851_400, 1_142_100],
    ]);
  });

  it("13 okt.–1 nov.: Hem och Lönsamhet visar 21 933,45 kr vinst", async () => {
    const home = await loadHome(SEED_RANGE);
    expect(kpi(home, "revenue")).toBe(7_998_700);
    expect(kpi(home, "orders")).toBe(460);
    expect(kpi(home, "profit")).toBe(2_193_345);
    expect(kpi(home, "margin")).toBe(2_880);

    const l = await lonsamhet(SEED_RANGE);
    expect(l.totals).toMatchObject({
      orders: 460,
      revenueOre: 7_616_200,
      costOre: 4_721_400,
      feesOre: 0,
      compensationOre: 556_052 + 145_403,
      profitOre: 2_193_345,
      unpricedOrders: 25,
      unpricedRevenueOre: 382_500,
    });
    expect(l.bridge).toMatchObject({ commissionOre: 556_052, rentOre: 145_403, marginBp: 2_880 });

    // Vyn per butik: butikens rad bär hela sin hyra (även ej fördelad).
    const store = (name: string) => l.views.store.find((r) => r.key === id(storeIds, name))!;
    expect(store("Spelbutiken Centrum (exempel)").compensationOre).toBe(407_940);
    expect(store("Gallerian Väst (exempel)").compensationOre).toBe(91_935 + 5_000);
    expect(store("Kiosken Stationen (exempel)").compensationOre).toBe(148_112 + 45_968 + 2_500);

    // Butiker: provision på ALLA order + hyra.
    const list = await loadStoreList(SEED_RANGE);
    const b = (name: string) => list.rows.find((r) => r.id === id(storeIds, name))!;
    expect(b("Spelbutiken Centrum (exempel)").compensationOre).toBe(407_940 + 16_572);
    expect(b("Gallerian Väst (exempel)").compensationOre).toBe(96_935);
    expect(b("Kiosken Stationen (exempel)").compensationOre).toBe(196_580 + 10_888);
  });

  /*
   * 30 dagar = 4 okt.–2 nov. (28 dagar i okt., 2 i nov.); samma order.
   *   Gallerian: round(150 000 × 28 / 31) = round(135 483,87) = 135 484; nov 150 000 × 2 / 30 = 10 000
   *   Kiosken:   round( 75 000 × 28 / 31) = round( 67 741,94) =  67 742; nov  75 000 × 2 / 30 =  5 000
   *   hyra 218 226; vinst = 7 616 200 − 4 721 400 − 556 052 − 218 226 = 2 120 522
   *   marginal round(2 120 522 × 10 000 / 7 616 200) = round(2 784,2) = 2 784
   * Allt = 13 okt.–2 nov.: hyra 91 935 + 45 968 + 10 000 + 5 000 = 152 903; vinst 2 185 845
   */
  it("30 dagar och Allt: hyran räknas per dag, även dagar utan order", async () => {
    const d30 = await loadHome({ period: "30d" });
    expect(d30.model.period).toMatchObject({ start: "2026-10-04", end: "2026-11-02" });
    expect(kpi(d30, "profit")).toBe(2_120_522);
    expect(kpi(d30, "margin")).toBe(2_784);
    expect((await lonsamhet({ period: "30d" })).bridge.rentOre).toBe(218_226);

    const all = await loadHome({ period: "allt" });
    expect(all.model.period).toMatchObject({ start: "2026-10-13", end: "2026-11-02" });
    expect(kpi(all, "profit")).toBe(2_185_845);
  });

  /*
   * Seedens egen prisändring mitt i perioden: 30th Celebration 105,00 kr från 1 okt.,
   * 112,00 kr från 27 okt. 150 order: 101 före 27 okt., 49 från 27 okt.
   *   inköp = 101 × 10 500 + 49 × 11 200 = 1 060 500 + 548 800 = 1 609 300
   *   27 okt.–1 nov.: bara det nya priset, 49 × 11 200 = 548 800
   */
  it("seedens prisändring 27 okt. (30th Celebration) räknas per orderns dag", async () => {
    const t = id(titleIds, "30th Celebration");
    const whole = await lonsamhet(SEED_RANGE);
    expect(whole.views.title.find((r) => r.key === t)).toMatchObject({
      orders: 150,
      costOre: 1_609_300,
    });
    const late = await lonsamhet({ from: "2026-10-27", to: "2026-11-01" });
    expect(late.views.title.find((r) => r.key === t)).toMatchObject({
      orders: 49,
      costOre: 548_800,
    });
  });
});

describe("ny prisändring mitt i perioden via /inkopspriser", () => {
  /*
   * Mega Evolution kostar 99,50 kr (9 950) från 1 okt. Nytt pris 108,00 kr (10 800) från 22 okt.
   * Seeden har 14 Mega Evolution-order, 11 från 22 okt.: BL-001 6, BL-002 2, BL-003 3.
   *   inköpet ökar med 11 × 850 = 9 350 (provision och hyra beror inte på inköpet)
   *   vinst 13 okt.–1 nov. = 2 193 345 − 9 350 = 2 183 995
   *   marginal round(2 183 995 × 10 000 / 7 616 200) = round(2 867,56) = 2 868
   * BL-001 (ingen hyra) som rad, före: 3 399 500 − 2 111 350 − 407 940 = 880 210
   *                              efter: 880 210 − 6 × 850 = 875 110
   */
  it("Hem, Lönsamhet och Automater visar den handräknade vinsten", async () => {
    const counts = await rows<{ code: string; n: number }>(
      db(),
      sql`select m.code, count(*)::int n from public.orders o
          join public.machines m on m.id = o.machine_id
          where o.organization_id = ${orgId}::uuid and o.title_id = ${id(titleIds, "Mega Evolution")}::uuid
            and o.business_date >= '2026-10-22' group by m.code order by m.code`,
    );
    expect(counts).toEqual([
      { code: "BL-001", n: 6 },
      { code: "BL-002", n: 2 },
      { code: "BL-003", n: 3 },
    ]);
    const bl001 = id(machineIds, "BL-001");
    const machineRow = async () =>
      (await lonsamhet(SEED_RANGE)).views.machine.find((r) => r.key === bl001)!;
    expect((await machineRow()).profitOre).toBe(880_210);

    const res = await addPurchasePrice({
      titleId: id(titleIds, "Mega Evolution"),
      unitCostOre: 10_800,
      validFrom: "2026-10-22",
    });
    expect(res).toMatchObject({ ok: true });

    const home = await loadHome(SEED_RANGE);
    expect(kpi(home, "profit")).toBe(2_183_995);
    expect(kpi(home, "margin")).toBe(2_868);
    const l = await lonsamhet(SEED_RANGE);
    expect(l.totals.costOre).toBe(4_721_400 + 9_350);
    expect(l.totals.profitOre).toBe(2_183_995);
    expect(await machineRow()).toMatchObject({
      revenueOre: 3_399_500,
      costOre: 2_111_350 + 6 * 850,
      compensationOre: 407_940,
      profitOre: 875_110,
    });
    const overview = await loadOverview(SEED_RANGE);
    expect(overview.overview.rows.find((r) => r.id === bl001)?.profitOre).toBe(875_110);
  });

  it("fristående SQL-facit stämmer för flera perioder efter prisändringen", async () => {
    await expectPagesMatchFacit(SEED_RANGE, "2026-10-13", "2026-11-01");
    await expectPagesMatchFacit({ period: "30d" }, "2026-10-04", "2026-11-02");
    await expectPagesMatchFacit({ period: "7d" }, "2026-10-27", "2026-11-02");
    await expectPagesMatchFacit(
      { from: "2026-10-20", to: "2026-10-26" },
      "2026-10-20",
      "2026-10-26",
    );
    await expectPagesMatchFacit(
      { from: "2026-10-21", to: "2026-10-23" },
      "2026-10-21",
      "2026-10-23",
    );
  });
});

describe("moms 25 % och kortavgift 2,5 % (seeden har 0, så avrundningen prövas aldrig där)", () => {
  /*
   * BL-001 (12 %, ingen hyra) 20 okt.: 2 × 30th Celebration 185,00, Black bolt 149,00,
   * White Flair 159,00 (utan pris).
   *   185,00: moms round(18 500 × 2 500 / 12 500) = 3 700, netto 14 800,
   *           kortavgift round(462,5) = 463, provision round(14 800 × 0,12) = 1 776, inköp 10 500
   *   149,00: moms 2 980, netto 11 920, kortavgift round(372,5) = 373,
   *           provision round(11 920 × 0,12 = 1 430,4) = 1 430, inköp 9 200
   *   159,00: moms 3 180, netto 12 720 (utan pris, ingår inte i vinsten)
   *   intäkt med pris 2 × 14 800 + 11 920 = 41 520; inköp 30 200; avgifter 1 299;
   *   provision 4 982; vinst 41 520 − 30 200 − 1 299 − 4 982 = 5 039;
   *   marginal round(5 039 × 10 000 / 41 520) = round(1 213,6) = 1 214; Hem-intäkt 54 240
   */
  it("en dag på BL-001 räknad för hand, och SQL-facit för hela perioden", async () => {
    await db().execute(
      sql`update public.organization_settings set vat_rate_bp = 2500, card_fee_bp = 250
          where organization_id = ${orgId}::uuid`,
    );
    const sp = { from: "2026-10-20", to: "2026-10-20", automat: id(machineIds, "BL-001") };
    const l = await lonsamhet(sp);
    expect(l.totals).toMatchObject({
      orders: 4,
      revenueOre: 41_520,
      costOre: 30_200,
      feesOre: 1_299,
      compensationOre: 4_982,
      profitOre: 5_039,
      unpricedOrders: 1,
      unpricedRevenueOre: 12_720,
    });
    expect(l.bridge.marginBp).toBe(1_214);
    const home = await loadHome(sp);
    expect(kpi(home, "revenue")).toBe(54_240);
    expect(kpi(home, "profit")).toBe(5_039);

    expect((await facit("2026-10-20", "2026-10-20", "BL-001")).profit).toBe(5_039);
    await expectPagesMatchFacit(SEED_RANGE, "2026-10-13", "2026-11-01");
    await expectPagesMatchFacit({ period: "30d" }, "2026-10-04", "2026-11-02");
  });
});
