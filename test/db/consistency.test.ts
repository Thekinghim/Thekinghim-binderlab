/**
 * Fas 4:s krav: siffrorna stämmer mellan sidorna, och en prisändring slår igenom överallt.
 *
 * Seeden (src/seed, samma generator och import som `npm run db:seed`) körs mot
 * binderlab_test i en EGEN organisation med egna användare (runSeed med `organization` och
 * `users`), så att test/db/seed.test.ts kan köras före eller efter utan att påverkas.
 * Data: 460 order 13 okt.–1 nov. 2026, 79 987 kr, tre butiker (s1 provision 12 %, s2 hyra
 * 1 500 kr/mån, s3 provision 8 % + hyra 750 kr/mån), moms 0, kortavgift 0.
 *
 * Sidorna anropas med SAMMA laddare som i appen: loadHome (Hem), loadTodos (Att göra),
 * loadPeriod + loadDomainInput + buildLonsamhetModel (Lönsamhet, som page.tsx),
 * listArgsFrom + loadOrderListFor (Order), loadOverview (Automater), loadStoreList
 * (Butiker). Det enda som ersätts är sessionen (vem som är inloggad) och Nexts
 * redirect/revalidatePath. Nya inköpspris läggs in med server action `addPurchasePrice`
 * från /inkopspriser, alltså samma kod som formuläret anropar.
 *
 * Klockan står still på 2 nov. 2026 kl. 11 svensk tid (bara Date fejkas).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/db/client";
import type { OrganizationMembership, SessionUser } from "@/server/access";

// ---------------------------------------------------------------------------
// Sessionen och Next: den inloggade är `session.current`.
// ---------------------------------------------------------------------------

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

// Vyknappen "Visa butikernas andel" på (headern som proxyn sätter från ?andel=1 eller kakan):
// testerna här prövar vinsten EFTER butikernas andel (vår del) mot handräkning och SQL-facit.
// Standardläget (före andelen) och båda lägena mot varandra: consistency-andel.test.ts.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-binderlab-andel": "1" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  permanentRedirect: (url: string) => {
    throw new RedirectSignal(url);
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
  // Obetalda avräkningar cachas (src/server/settlements/cache.ts); här läses de direkt.
  unstable_cache: <T>(fn: T) => fn,
}));

// Importeras efter mockarna (vi.mock hissas, så ordningen här är bara för läsbarheten).
import { addPurchasePrice } from "@/app/(app)/inkopspriser/actions";
import { loadTitleDetailFor } from "@/app/(app)/inkopspriser/_lib/data";
import { loadHome } from "@/app/(app)/_hem/load";
import type { HomeData } from "@/app/(app)/_hem/data";
import { buildLonsamhetModel, type LonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import { listArgsFrom, currentViewer as orderViewer } from "@/app/(app)/order/_lib/session";
import { loadOrderListFor } from "@/app/(app)/order/_lib/service";
import { loadOverview } from "@/app/(app)/automater/_lib/data";
import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { carriedQuery, type SearchParamsInput } from "@/components/shell/period-state";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor } from "@/server/access";
import { loadDomainInput, loadPeriod, loadTodos, requireRoute } from "@/server/data/core";
import { profitability } from "@/domain";
import { EXPECTED_TOTAL_ORE, ORDER_COUNT } from "@/seed/catalog";
import { runSeed } from "@/seed/run-seed";

import { db, one, rows, uniqueSuffix } from "./helpers";

const NOW = new Date("2026-11-02T10:00:00Z");
/** Eget intervall: hela seedperioden. */
const SEED_RANGE = { from: "2026-10-13", to: "2026-11-01" } as const;

let orgId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };
let reader: { user: SessionUser; organization: OrganizationMembership };
const titleIds = new Map<string, string>();
const machineIds = new Map<string, string>();
const storeIds = new Map<string, string>();

async function membership(user: SessionUser): Promise<OrganizationMembership> {
  const org = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!org) throw new Error("Saknar medlemskap");
  return org;
}

function as<T>(who: typeof owner, fn: () => Promise<T>): Promise<T> {
  session.current = who;
  return fn();
}

// ---------------------------------------------------------------------------
// Sidorna, med sidornas laddare
// ---------------------------------------------------------------------------

/** Lönsamhet exakt som page.tsx bygger modellen (utan tomt läge). */
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

/** Order-sidans huvud (antal och summa) som page.tsx laddar det. */
async function orderList(sp: SearchParamsInput) {
  const ctx = await requireRoute("order");
  const { args } = await listArgsFrom(sp);
  return loadOrderListFor(await orderViewer(), args, new Date(ctx.now));
}

function kpi(home: HomeData, id: string): number | null {
  const k = home.model.kpis.find((x) => x.id === id);
  if (!k) throw new Error(`Hem saknar nyckeltalet ${id}`);
  return k.value;
}

/**
 * Vår vinst på Hem. Nyckeltalet "Vår vinst" är samma tal som Lönsamhetens vinst (en
 * betydelse överallt); hela vinsten före butikernas andel finns bara i delningen.
 */
function ourProfit(home: HomeData): number | null {
  const split = home.model.profitSplit;
  const shown = home.model.kpis.find((x) => x.id === "profit")?.value ?? null;
  expect(shown).toBe(split ? split.ourOre : null);
  return split ? split.ourOre : null;
}

/** Provision på order utan pris per kontroll (för handräkningen i första testet). */
const unpricedCommissionSeen = new Map<string, number>();

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);

const LINE_COLUMNS = [
  "orders",
  "revenueOre",
  "costOre",
  "feesOre",
  "compensationOre",
  "profitOre",
  "unpricedOrders",
  "unpricedRevenueOre",
] as const;

/** (b): raderna i varje vy summerar till totalen, och totalen är densamma i alla vyer. */
function expectViewsConsistent(m: LonsamhetModel): void {
  for (const view of ["title", "machine", "store"] as const) {
    const lines = m.views[view];
    for (const col of LINE_COLUMNS) {
      expect(
        sum(lines, (l) => l[col]),
        `${view}.${col}`,
      ).toBe(m.totals[col]);
    }
  }
  // Vattenfallet: intäkt − inköp − avgifter − butiksersättning = vinst, och samma som totalen.
  const b = m.bridge;
  expect(b.revenueOre).toBe(m.totals.revenueOre);
  expect(b.costOre).toBe(m.totals.costOre);
  expect(b.feesOre).toBe(m.totals.feesOre);
  expect(b.compensationOre).toBe(m.totals.compensationOre);
  expect(b.profitOre).toBe(m.totals.profitOre);
  expect(b.revenueOre - b.costOre - b.feesOre - b.compensationOre).toBe(b.profitOre);
  expect(b.commissionOre + b.rentOre).toBe(b.compensationOre);
  expect(b.unpricedRevenueOre).toBe(m.totals.unpricedRevenueOre);
  // Antal order på raderna = alla order (även utan pris, som också räknas separat).
  expect(m.totals.orders).toBe(m.orders);
  expect(m.totals.unpricedOrders).toBe(m.unpriced.orders);
  // Tidsserierna (dag, vecka, månad) summerar också till totalen.
  for (const key of ["day", "week", "month"] as const) {
    const t = m.trend[key];
    expect(sum(t.buckets, (x) => x.profitOre) + t.unallocatedProfitOre, `trend.${key}`).toBe(
      m.totals.profitOre,
    );
    expect(
      sum(t.buckets, (x) => x.revenueOre),
      `trend.${key}.revenue`,
    ).toBe(m.totals.revenueOre);
    expect(
      sum(t.buckets, (x) => x.orders),
      `trend.${key}.orders`,
    ).toBe(m.orders);
  }
}

/** (b) + (e): Hem, Lönsamhet, Order, Automater och Butiker för samma URL. */
async function expectPagesAgree(sp: SearchParamsInput, label: string) {
  const home = await loadHome(sp);
  const lons = await lonsamhet(sp);
  const order = await orderList(sp);
  const machines = await loadOverview(sp);

  const revenue = kpi(home, "revenue");
  const profit = ourProfit(home);
  const orders = kpi(home, "orders");

  // Lönsamhet mot Hem: all intäkt = prissatt + utan pris; vinst och marginal identiska.
  expect(lons.period, label).toEqual(home.model.period);
  expect(lons.totals.revenueOre + lons.totals.unpricedRevenueOre, label).toBe(revenue);
  expect(lons.orders, label).toBe(orders);
  expect(lons.totals.profitOre, label).toBe(profit);
  // Hem visar vår vinst, som Lönsamhet; hela vinsten = vår vinst + butikernas andel.
  expect(kpi(home, "profit"), label).toBe(lons.totals.profitOre);
  expect(home.model.profitSplit?.totalOre ?? null, label).toBe(
    home.model.profitSplit ? lons.totals.profitOre + lons.totals.compensationOre : null,
  );
  expect(lons.bridge.marginBp, label).toBe(kpi(home, "margin"));
  expectViewsConsistent(lons);

  // Order: betalt belopp (moms 0 ⇒ = nettointäkt) och antal.
  expect(order.period, label).toEqual(home.model.period);
  expect(order.totals.count, label).toBe(orders);
  expect(order.totals.amountOre, label).toBe(revenue);

  // Automater: totalen = raderna + övriga rader, och samma som Hem.
  const o = machines.overview;
  expect(machines.period.start, label).toBe(home.model.period.start);
  expect(machines.period.end, label).toBe(home.model.period.end);
  if (!machines.focused) {
    expect(o.totals.revenueOre, label).toBe(revenue);
    expect(o.totals.orders, label).toBe(orders);
    expect(o.totals.profitOre, label).toBe(profit);
    expect(sum(o.rows, (r) => r.revenueOre) + sum(o.others, (r) => r.revenueOre), label).toBe(
      o.totals.revenueOre,
    );
    expect(sum(o.rows, (r) => r.profitOre) + sum(o.others, (r) => r.profitOre), label).toBe(
      o.totals.profitOre,
    );
  } else {
    // Automatfilter: automatens rad är summan, och den är Hems siffra för automaten.
    expect(
      o.rows.map((r) => r.id),
      label,
    ).toEqual([home.scope?.id]);
    expect(o.rows[0]!.revenueOre, label).toBe(revenue);
    expect(o.rows[0]!.orders, label).toBe(orders);
  }

  // Butiker (listan visar butiker; automatfiltret gäller inte listan).
  if (home.scope?.kind !== "machine") {
    const stores = await loadStoreList(sp);
    expect(
      sum(stores.rows, (r) => r.revenueOre),
      label,
    ).toBe(revenue);
    expect(
      sum(stores.rows, (r) => r.orders),
      label,
    ).toBe(orders);
    expect(stores.kpis.find((k) => k.id === "revenue")?.value, label).toBe(revenue);
    // Butikens vinst inkluderar butikens ej fördelade hyra: summan = Lönsamhets vinst.
    expect(
      sum(stores.rows, (r) => r.profitOre),
      label,
    ).toBe(lons.totals.profitOre);
    // Butikernas andel på Butiker är andelen som dras från vår vinst, samma som Lönsamhet
    // (andelen + vår del = vår vinst före andelen). Provisionen på order utan inköpspris
    // ingår inte, eftersom de orderna inte ingår i vinsten (beräkningslagrets summa nedan).
    const p = await loadPeriod(sp);
    const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
    const unpricedCommission = profitability(input.current, "store").totals.unpricedCommissionOre;
    expect(
      sum(stores.rows, (r) => r.compensationOre),
      label,
    ).toBe(lons.totals.compensationOre);
    unpricedCommissionSeen.set(label, unpricedCommission);
  }
  return { home, lons, order, machines };
}

// ---------------------------------------------------------------------------
// Uppsättning
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-consistency",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-consistency-"))),
    organization: { name: `Avstämning ${suffix}`, slug: `avstamning-${suffix}` },
    users: {
      owner: { email: `avst-agare-${suffix}@test.binderlab.se`, fullName: "Ägare", role: "owner" },
      partner: {
        email: `avst-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  expect(seeded.totals).toEqual({ orders: ORDER_COUNT, revenueOre: EXPECTED_TOTAL_ORE });

  const ownerUser = { userId: seeded.users.owner, email: `avst-agare-${suffix}@test.binderlab.se` };
  const readerUser = {
    userId: seeded.users.partner,
    email: `avst-delagare-${suffix}@test.binderlab.se`,
  };
  owner = { user: ownerUser, organization: await membership(ownerUser) };
  reader = { user: readerUser, organization: await membership(readerUser) };

  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.titles where organization_id = ${orgId}::uuid`,
  )) {
    titleIds.set(r.name, r.id);
  }
  for (const r of await rows<{ id: string; code: string }>(
    db(),
    sql`select id, code from public.machines where organization_id = ${orgId}::uuid`,
  )) {
    machineIds.set(r.code, r.id);
  }
  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.stores where organization_id = ${orgId}::uuid`,
  )) {
    storeIds.set(r.name, r.id);
  }

  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 180_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
});

const id = (m: Map<string, string>, key: string) => {
  const v = m.get(key);
  if (!v) throw new Error(`Saknar ${key}`);
  return v;
};

/** Antal order för en titel per automat, före och från ett datum (rådata, inga belopp räknas). */
async function orderCounts(title: string, from: string) {
  return rows<{ code: string; before: number; after: number; amounts: string }>(
    db(),
    sql`select m.code,
               count(*) filter (where o.business_date < ${from}::date)::int as before,
               count(*) filter (where o.business_date >= ${from}::date)::int as after,
               string_agg(distinct o.amount_ore::text, ',') as amounts
        from public.orders o
        join public.machines m on m.organization_id = o.organization_id and m.id = o.machine_id
        where o.organization_id = ${orgId}::uuid and o.title_id = ${id(titleIds, title)}::uuid
        group by m.code order by m.code`,
  );
}

// ---------------------------------------------------------------------------
// Testerna (körs i ordning: (b)/(e) före ändringarna, (a)/(c)/(d) ändrar priser)
// ---------------------------------------------------------------------------

describe("(b, e) samma siffror på alla sidor, före prisändringarna", () => {
  it("eget intervall 13 okt.–1 nov.: hela seeden, 460 order och 79 987 kr överallt", async () => {
    await as(owner, async () => {
      const { home, lons } = await expectPagesAgree(SEED_RANGE, "eget intervall");
      expect(home.periodKey).toBe("eget");
      expect(kpi(home, "orders")).toBe(460);
      expect(kpi(home, "revenue")).toBe(7_998_700);
      // Två titlar saknar pris i seeden (Perfect Order 15 order, White Flair 10 order).
      expect(lons.unpriced.titles.map((t) => t.name).sort()).toEqual([
        "Perfect Order",
        "White Flair",
      ]);
      expect(lons.totals.unpricedOrders).toBe(25);
      expect(lons.totals.unpricedRevenueOre).toBe(15 * 14_900 + 10 * 15_900);
      // Provision på order utan pris (ingår varken i vinsten eller i andelen på Butiker):
      //   Perfect Order (14 900): BL-001 5 × 1 788 = 8 940, BL-003 7 × 1 192 = 8 344
      //   White Flair   (15 900): BL-001 4 × 1 908 = 7 632, BL-003 2 × 1 272 = 2 544
      //   summa 27 460 (BL-002 har bara hyra)
      expect(unpricedCommissionSeen.get("eget intervall")).toBe(8_940 + 8_344 + 7_632 + 2_544);
    });
  });

  const periods: Record<string, string>[] = [
    { period: "7d" },
    { period: "30d" },
    { period: "allt" },
    { period: "manad" },
    { from: "2026-10-20", to: "2026-10-26" },
  ];
  for (const sp of periods) {
    it(`samma intäkt, vinst och antal för ${new URLSearchParams(sp).toString()}`, async () => {
      await as(owner, () => expectPagesAgree(sp, JSON.stringify(sp)));
    });
  }

  it("med butiksfilter (Gallerian Väst, bara hyra) och automatfilter (BL-003)", async () => {
    await as(owner, async () => {
      const store = id(storeIds, "Gallerian Väst (exempel)");
      const s = await expectPagesAgree({ ...SEED_RANGE, butik: store }, "butik");
      expect(s.home.scope).toMatchObject({ kind: "store", id: store, missing: false });
      const machine = id(machineIds, "BL-003");
      const m = await expectPagesAgree({ ...SEED_RANGE, automat: machine }, "automat");
      expect(m.home.scope).toMatchObject({ kind: "machine", code: "BL-003" });
      expect(m.machines.focused).toBe(true);
    });
  });

  it("läsaren ser samma siffror som ägaren", async () => {
    const mine = await as(owner, () => loadHome(SEED_RANGE));
    const theirs = await as(reader, () => loadHome(SEED_RANGE));
    for (const k of ["revenue", "profit", "margin", "orders", "aov"]) {
      expect(kpi(theirs, k), k).toBe(kpi(mine, k));
    }
    const lons = await as(reader, () => lonsamhet(SEED_RANGE));
    expect(lons.totals.profitOre).toBe(ourProfit(mine));
  });
});

describe("(a) prisändring mitt i perioden, via server action på /inkopspriser", () => {
  /*
   * Black bolt säljs alltid för 149,00 kr (14 900 öre) och kostar 92,00 kr (9 200 öre) från
   * 1 okt. Vi lägger in 100,00 kr (10 000 öre) från 24 okt., mitt i perioden 13 okt.–1 nov.
   *
   * Seedens Black bolt-order (20 st) per automat:
   *   BL-001 (Spelbutiken Centrum, provision 12 %, ingen hyra): 4 före 24 okt., 5 från 24 okt.
   *   BL-002 (Gallerian Väst, bara hyra 1 500 kr/mån):           3 före,         6 från
   *   BL-003 (Kiosken Stationen, 8 % + hyra 750 kr/mån):         1 före,         1 från
   *
   * Med automatfilter BL-001 finns ingen hyra, så raden kan räknas helt för hand:
   *   intäkt    = 9 × 14 900                         = 134 100
   *   inköp     = 4 × 9 200 + 5 × 10 000             =  36 800 + 50 000 = 86 800
   *   provision = 9 × round(14 900 × 1 200 / 10 000) = 9 × 1 788 = 16 092
   *   vinst     = 134 100 − 86 800 − 16 092           =  31 208
   *   (före ändringen: inköp 9 × 9 200 = 82 800, vinst 35 208; skillnad −4 000 = −5 × 800)
   *
   * Hela organisationen: 12 order från 24 okt. blir 800 öre dyrare var, inget annat ändras
   * (provisionen räknas på intäkten och hyran fördelas efter intäkt × hyra, inte inköp):
   *   Black bolts inköp = 8 × 9 200 + 12 × 10 000 = 73 600 + 120 000 = 193 600
   *   total vinst       = före − 12 × 800 = före − 9 600
   */
  it("räknar order före 24 okt. med 92 kr och från 24 okt. med 100 kr", async () => {
    expect(await orderCounts("Black bolt", "2026-10-24")).toEqual([
      { code: "BL-001", before: 4, after: 5, amounts: "14900" },
      { code: "BL-002", before: 3, after: 6, amounts: "14900" },
      { code: "BL-003", before: 1, after: 1, amounts: "14900" },
    ]);
    const bolt = id(titleIds, "Black bolt");
    const bl001 = { ...SEED_RANGE, automat: id(machineIds, "BL-001") };
    const row = (m: LonsamhetModel) => m.views.title.find((l) => l.key === bolt)!;

    await as(owner, async () => {
      const before = await lonsamhet(SEED_RANGE);
      const before001 = await lonsamhet(bl001);
      expect(row(before001)).toMatchObject({
        orders: 9,
        revenueOre: 134_100,
        costOre: 82_800,
        compensationOre: 16_092,
        profitOre: 35_208,
      });
      expect(row(before).costOre).toBe(20 * 9_200);

      // Samma anrop som formuläret på /inkopspriser gör.
      const result = await addPurchasePrice({
        titleId: bolt,
        unitCostOre: 10_000,
        validFrom: "2026-10-24",
        note: "Ny leverans 24 okt.",
      });
      expect(result).toMatchObject({ ok: true, data: { mode: "inserted" } });

      const after001 = await lonsamhet(bl001);
      expect(row(after001)).toMatchObject({
        orders: 9,
        revenueOre: 134_100,
        costOre: 86_800,
        feesOre: 0,
        compensationOre: 16_092,
        profitOre: 31_208,
      });

      const after = await lonsamhet(SEED_RANGE);
      expect(row(after).costOre).toBe(193_600);
      expect(row(after).compensationOre).toBe(row(before).compensationOre);
      expect(row(after).profitOre).toBe(row(before).profitOre - 9_600);
      expect(after.totals.profitOre).toBe(before.totals.profitOre - 9_600);
      expect(after.totals.costOre).toBe(before.totals.costOre + 9_600);
      expect(after.totals.revenueOre).toBe(before.totals.revenueOre);
      expectViewsConsistent(after);

      // Hem visar samma vinst direkt.
      const home = await loadHome(SEED_RANGE);
      expect(ourProfit(home)).toBe(after.totals.profitOre);
    });
  });

  it("ett pris före perioden påverkar inte perioden, ett pris efter den inte heller", async () => {
    await as(owner, async () => {
      const before = await lonsamhet(SEED_RANGE);
      // Från 2 nov. (dagen efter perioden): inga order i perioden berörs.
      const later = await addPurchasePrice({
        titleId: id(titleIds, "Black bolt"),
        unitCostOre: 12_000,
        validFrom: "2026-11-02",
      });
      expect(later.ok).toBe(true);
      const after = await lonsamhet(SEED_RANGE);
      expect(after.totals.profitOre).toBe(before.totals.profitOre);
    });
  });
});

describe("(c) ett nytt pris syns direkt i Hem, Att göra och Lönsamhet", () => {
  /*
   * White Flair saknar inköpspris: 10 order à 159,00 kr (15 900 öre).
   *   BL-001 (12 %): 4 order, provision round(15 900 × 0,12) = 1 908 per order
   *   BL-002 (hyra): 4 order, provision 0
   *   BL-003 (8 % + hyra): 2 order, provision round(15 900 × 0,08) = 1 272 per order
   * Vi ger titeln 95,00 kr (9 500 öre) från 1 okt. Orderna räknas då in i vinsten.
   * Hyran är redan dragen i sin helhet (som ej fördelad hyra) och flyttar bara till titelns rad.
   *   BL-001: 4 × (15 900 − 9 500 − 1 908) = 4 × 4 492 = 17 968
   *   BL-002: 4 × (15 900 − 9 500 − 0)     = 4 × 6 400 = 25 600
   *   BL-003: 2 × (15 900 − 9 500 − 1 272) = 2 × 5 128 = 10 256
   *   vinsten ökar med                                    53 824
   * Intäkt utan pris minskar med 10 × 15 900 = 159 000; total intäkt är oförändrad.
   */
  it("titeln försvinner ur 'saknar inköpspris' och vinsten ökar med 538,24 kr", async () => {
    expect(await orderCounts("White Flair", "2026-10-01")).toEqual([
      { code: "BL-001", before: 0, after: 4, amounts: "15900" },
      { code: "BL-002", before: 0, after: 4, amounts: "15900" },
      { code: "BL-003", before: 0, after: 2, amounts: "15900" },
    ]);
    const flair = id(titleIds, "White Flair");

    await as(owner, async () => {
      const homeBefore = await loadHome(SEED_RANGE);
      const lonsBefore = await lonsamhet(SEED_RANGE);
      const todosBefore = await loadTodos();
      const missingBefore = todosBefore.filter((t) => t.kind === "missing-price");
      expect(missingBefore.map((t) => t.key)).toContain(`missing-price:${flair}`);
      expect(homeBefore.model.unpriced?.titles.map((t) => t.id)).toContain(flair);

      const result = await addPurchasePrice({
        titleId: flair,
        unitCostOre: 9_500,
        validFrom: "2026-10-01",
      });
      expect(result).toMatchObject({ ok: true, data: { mode: "inserted" } });

      // Att göra: punkten för White Flair är borta, Perfect Order finns kvar.
      const todosAfter = await loadTodos();
      const missingAfter = todosAfter.filter((t) => t.kind === "missing-price");
      expect(missingAfter.map((t) => t.key)).not.toContain(`missing-price:${flair}`);
      expect(missingAfter.map((t) => t.key)).toContain(
        `missing-price:${id(titleIds, "Perfect Order")}`,
      );
      expect(missingAfter.length).toBe(missingBefore.length - 1);

      // Lönsamhet.
      const lonsAfter = await lonsamhet(SEED_RANGE);
      expect(lonsAfter.unpriced.titles.map((t) => t.titleId)).not.toContain(flair);
      expect(lonsAfter.totals.profitOre).toBe(lonsBefore.totals.profitOre + 53_824);
      expect(lonsAfter.totals.unpricedRevenueOre).toBe(
        lonsBefore.totals.unpricedRevenueOre - 159_000,
      );
      expect(lonsAfter.totals.revenueOre + lonsAfter.totals.unpricedRevenueOre).toBe(
        lonsBefore.totals.revenueOre + lonsBefore.totals.unpricedRevenueOre,
      );
      const flairRow = lonsAfter.views.title.find((l) => l.key === flair)!;
      expect(flairRow).toMatchObject({ orders: 10, revenueOre: 159_000, costOre: 95_000 });
      expect(flairRow.compensationOre - 4 * 1_908 - 2 * 1_272).toBeGreaterThan(0); // + hyra
      expectViewsConsistent(lonsAfter);

      // Hem.
      const homeAfter = await loadHome(SEED_RANGE);
      expect(homeAfter.model.unpriced?.titles.map((t) => t.id) ?? []).not.toContain(flair);
      expect(ourProfit(homeAfter)).toBe((ourProfit(homeBefore) ?? 0) + 53_824);
      expect(kpi(homeAfter, "revenue")).toBe(kpi(homeBefore, "revenue"));
      expect(homeAfter.model.topTitles.rows.find((r) => r.id === flair)?.unpriced ?? false).toBe(
        false,
      );

      // Och alla sidor stämmer fortfarande mot varandra.
      await expectPagesAgree(SEED_RANGE, "efter prisändringarna");
    });
  });
});

describe("(d) ändringen finns i audit_log med före, efter och aktör", () => {
  it("nytt pris loggas som insert, en rättelse samma dag som update med före och efter", async () => {
    const bolt = id(titleIds, "Black bolt");
    await as(owner, async () => {
      // Rättelse av priset från 24 okt.: 100,00 → 101,50 kr (samma dag ⇒ ändras, loggas).
      const fixed = await addPurchasePrice({
        titleId: bolt,
        unitCostOre: 10_150,
        validFrom: "2026-10-24",
        note: "Rättad faktura",
      });
      expect(fixed).toMatchObject({ ok: true, data: { mode: "replaced" } });
    });

    const log = await rows<{
      action: string;
      actor_id: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      db(),
      sql`select action::text as action, actor_id, before, after
          from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'
            and coalesce(after ->> 'title_id', before ->> 'title_id') = ${bolt}
            and coalesce(after ->> 'valid_from', before ->> 'valid_from') = '2026-10-24'
          order by occurred_at, id`,
    );
    expect(log.map((r) => r.action)).toEqual(["insert", "update"]);
    for (const r of log) expect(r.actor_id).toBe(owner.user.userId);
    expect(log[0]!.before).toBeNull();
    expect(log[0]!.after).toMatchObject({ unit_cost_ore: 10_000, valid_from: "2026-10-24" });
    expect(log[1]!.before).toMatchObject({ unit_cost_ore: 10_000, note: "Ny leverans 24 okt." });
    expect(log[1]!.after).toMatchObject({ unit_cost_ore: 10_150, note: "Rättad faktura" });

    // White Flairs nya pris från (c).
    const flair = await one<{ action: string; actor_id: string; after: Record<string, unknown> }>(
      db(),
      sql`select action::text as action, actor_id, after from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'
            and after ->> 'title_id' = ${id(titleIds, "White Flair")}`,
    );
    expect(flair).toMatchObject({
      action: "insert",
      actor_id: owner.user.userId,
      after: { unit_cost_ore: 9_500, valid_from: "2026-10-01" },
    });

    // Prisloggen på /inkopspriser visar samma händelser (läsaren ser den också).
    const detail = await loadTitleDetailFor(reader.user, orgId, bolt);
    const own = detail.events.filter((e) => (e.after ?? e.before)?.validFrom === "2026-10-24");
    expect(own.map((e) => [e.action, e.before?.unitCostOre ?? null, e.after?.unitCostOre])).toEqual(
      [
        ["insert", null, 10_000],
        ["update", 10_000, 10_150],
      ],
    );
    expect(own.every((e) => e.actorId === owner.user.userId)).toBe(true);
  });

  it("läsaren kan inte ändra priser; inget loggas", async () => {
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'`,
    );
    const result = await as(reader, () =>
      addPurchasePrice({
        titleId: id(titleIds, "Perfect Order"),
        unitCostOre: 9_000,
        validFrom: "2026-10-01",
      }),
    );
    expect(result.ok).toBe(false);
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'`,
    );
    expect(after.n).toBe(before.n);
  });
});
