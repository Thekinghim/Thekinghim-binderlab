/**
 * VMB-momsen på vår vinst (vyknappen "Med VMB") och avtalens "Dra av VMB-moms före delning"
 * går ihop med försäljningen, butikens andel och bokföringen.
 *
 * Seeden (src/seed, samma som `npm run db:seed`) körs i en EGEN organisation. Avtalen görs
 * om till vinstdelning 50/50 utan hyra (Spelbutiken och Kiosken från 1 okt., Gallerian först
 * från 20 okt.), titlarna utan inköpspris får ett pris och två kundärenden återbetalas. Moms
 * 0 och kortavgift 0 i Inställningar: bolaget redovisar moms med VMB.
 *
 * Sidorna anropas med SAMMA laddare som i appen: loadDomainInput + buildLonsamhetModel och
 * resultAfterProfit (Lönsamhet, som page.tsx), loadHome (Hem), loadStoreList (Butiker),
 * loadOverview (Automater) och loadBokforingFor (Ekonomi → Bokföring).
 *
 * Vyknappen: proxyn sätter headern x-binderlab-vmb från ?vmb=1; här mockas next/headers.
 *
 * Kontrollerna (vy av/på × avtal på/av):
 *   försäljning = vår vinst efter återbetalningar + butikens andel + VMB-moms (bara vy på)
 *                 + inköp + kortavgifter + återbetalningar                (exakt, på öret)
 *   butikens andel = Σ per butik och månad 50 % × (vinst efter kostnader − VMB om avtalet på)
 *   Bokföringen räknar VMB-momsen bara med "VMB i bokföringen" på (standard av), oberoende
 *   av vyknappen
 *   vår vinst − butikens andel = vinsten på order före avtalets start + avrundningen per
 *                                butik och månad + (Σ butikernas VMB − samlad VMB)
 *   oktober (avslutad hel månad): Lönsamhetens VMB-moms = Bokföringens VMB-moms
 *
 * Klockan står still på 3 nov. 2026 kl. 11 svensk tid (bara Date fejkas).
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

// Vyknappen "Med VMB": headern som proxyn sätter från ?vmb=1. Vyknappen "Visa butikernas
// andel" är på (x-binderlab-andel): testerna här prövar vår vinst EFTER butikens andel.
// Standardläget (före andelen): consistency-andel.test.ts.
const view = vi.hoisted(() => ({ vmb: false }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-binderlab-andel": "1", ...(view.vmb ? { "x-binderlab-vmb": "1" } : {}) }),
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
import { loadHome } from "@/app/(app)/_hem/load";
import type { HomeData } from "@/app/(app)/_hem/data";
import { loadOverview } from "@/app/(app)/automater/_lib/data";
import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { buildLonsamhetModel, type LonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import { resultAfterProfit, type ResultAfterProfit } from "@/app/(app)/lonsamhet/_lib/result";
import { carriedQuery, type SearchParamsInput } from "@/components/shell/period-state";
import { buildLedger, profitability, vmbChain, vmbVatOfMargin } from "@/domain";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor } from "@/server/access";
import {
  loadBokforingFor,
  saveBokforingSettingsFor,
  setBokforingVmbFor,
} from "@/server/bokforing/service";
import { DEFAULT_PLAN } from "@/server/bokforing/plan";
import { loadProfitAdjustmentsFor } from "@/server/data/adjustments";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";
import { runSeed } from "@/seed/run-seed";

import { db, rows, uniqueSuffix } from "./helpers";

const NOW = new Date("2026-11-03T10:00:00Z");
const TODAY = "2026-11-03";
/** Hela seedperioden (13 okt.–1 nov.): korsar månadsskiftet, VMB-momsen är preliminär. */
const SEED_RANGE = { from: "2026-10-13", to: "2026-11-01" } as const;
/** Oktober: en avslutad hel månad. */
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" } as const;
const GALLERIAN_FROM = "2026-10-20";

let orgId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };
const storeIds = new Map<string, string>();
const machineIds = new Map<string, string>();

function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  session.current = owner;
  return fn();
}

interface Page {
  readonly model: LonsamhetModel;
  readonly result: ResultAfterProfit;
  readonly input: Awaited<ReturnType<typeof loadDomainInput>>;
}

/** Lönsamhet som page.tsx: modellen och raderna efter vinsten (återbetalningar). */
async function lonsamhet(sp: SearchParamsInput): Promise<Page> {
  view.vmb = (sp as Record<string, string>).vmb === "1";
  const ctx = await requireRoute("lonsamhet");
  const p = await loadPeriod(sp);
  const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
  const adjustments = await loadProfitAdjustmentsFor(owner, p.period);
  const model = buildLonsamhetModel(
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
  const result = resultAfterProfit({
    current: input.current,
    organization: input.current,
    refunds: adjustments.refunds,
    fixedCosts: [],
    scope: p.scope,
    machines: input.machines.map((m) => ({ id: m.id, name: m.code || m.name })),
  });
  return { model, result, input };
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

/** Försäljning inkl. moms för order med inköpspris (moms 0: = intäkten med pris). */
function pricedSales(page: Page): number {
  return buildLedger(page.input.current).entries.reduce(
    (n, e) => (e.priced ? n + e.grossOre : n),
    0,
  );
}

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-vmb",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-vmb-"))),
    organization: { name: `VMB ${suffix}`, slug: `vmb-${suffix}` },
    users: {
      owner: { email: `vmb-agare-${suffix}@test.binderlab.se`, fullName: "Ägare", role: "owner" },
      partner: {
        email: `vmb-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  const ownerUser = { userId: seeded.users.owner, email: `vmb-agare-${suffix}@test.binderlab.se` };
  const org = (await listOrganizationsFor(ownerUser)).find((o) => o.id === orgId);
  if (!org) throw new Error("Saknar medlemskap");
  owner = { user: ownerUser, organization: org };

  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.stores where organization_id = ${orgId}::uuid`,
  ))
    storeIds.set(r.name, r.id);
  for (const r of await rows<{ id: string; code: string }>(
    db(),
    sql`select id, code from public.machines where organization_id = ${orgId}::uuid`,
  ))
    machineIds.set(r.code, r.id);

  // Vinstdelning 50/50 utan hyra; Gallerians avtal börjar först 20 okt. Avtalens "Dra av
  // VMB-moms före delning" på (standard av), så att vyn på och avtalet på kan jämföras; båda
  // lägena prövas nedan.
  await db().execute(sql`
    update public.store_agreements
       set commission_base = 'profit_after_costs', commission_bp = 5000,
           monthly_rent_ore = null, loss_treatment = 'zero', vmb_before_split = true
     where organization_id = ${orgId}::uuid`);
  await db().execute(sql`
    update public.store_agreements a set valid_from = ${GALLERIAN_FROM}::date
      from public.stores s
     where a.organization_id = ${orgId}::uuid and s.id = a.store_id
       and s.name = 'Gallerian Väst (exempel)'`);
  // Inköpspris för titlarna som saknar det, så att Bokföringen och Lönsamheten har samma underlag.
  await db().execute(sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    select t.organization_id, t.id, 9500, '2026-10-01'
      from public.titles t
     where t.organization_id = ${orgId}::uuid
       and not exists (select 1 from public.purchase_prices p
                        where p.organization_id = t.organization_id and p.title_id = t.id)`);
  // Två återbetalningar: 149 kr på BL-001 i oktober och 50 kr på BL-003 1 nov.
  for (const [code, ore, day] of [
    ["BL-001", 14_900, "2026-10-21"],
    ["BL-003", 5_000, "2026-11-01"],
  ] as const) {
    await db().execute(sql`
      insert into public.incidents (organization_id, machine_id, kind, started_at, description,
                                    refunded_ore, refunded_on)
      values (${orgId}::uuid, ${machineIds.get(code)!}::uuid, 'customer', ${`${day}T12:00:00Z`},
              'Fick inget pack', ${ore}, ${day}::date)`);
  }

  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 180_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
});

const ON = { vmb: "1" } as const;
const SEED_ON = { ...SEED_RANGE, ...ON };
const OCTOBER_ON = { ...OCTOBER, ...ON };

describe("vyknappen Med VMB på (seedad databas, vinstdelning 50/50)", () => {
  it("försäljning = vår vinst + butikens andel + VMB-moms + inköp + avgifter + återbetalningar", async () => {
    await asOwner(async () => {
      for (const sp of [SEED_ON, OCTOBER_ON, { period: "7d", ...ON }, { period: "30d", ...ON }]) {
        const page = await lonsamhet(sp);
        const t = page.model.totals;
        const label = JSON.stringify(sp);
        expect(t.unpricedOrders, label).toBe(0);
        expect(page.model.bridge.vmbVatOre, label).toBe(t.vmbVatOre);
        expect(t.vmbVatOre, label).toBeGreaterThan(0);
        const sales = pricedSales(page);
        expect(sales, label).toBe(t.revenueOre);
        expect(
          page.result.profitAfterRefundsOre +
            t.compensationOre +
            t.vmbVatOre +
            t.costOre +
            t.feesOre +
            page.result.refundOre,
          label,
        ).toBe(sales);
        // Vattenfallet summerar till vinsten med steget VMB-moms.
        const b = page.model.bridge;
        expect(b.revenueOre - b.vmbVatOre! - b.costOre - b.feesOre - b.compensationOre).toBe(
          b.profitOre,
        );
      }
    });
  });

  it("vår vinst och butikens andel skiljer bara på order före avtalets start, avrundning och VMB-perioden", async () => {
    await asOwner(async () => {
      const page = await lonsamhet(SEED_ON);
      const ledger = buildLedger(page.input.current);
      const splits = ledger.profitSplits;
      const storeShare = splits.reduce((n, s) => n + s.result.storeShareOre, 0);
      expect(page.model.totals.compensationOre).toBe(storeShare);
      // Order utan avtal (Gallerian före 20 okt.): hela vinsten är vår, ingen VMB i butikens del.
      const gallerian = storeIds.get("Gallerian Väst (exempel)")!;
      const before = ledger.entries.filter(
        (e) => e.storeId === gallerian && e.order.businessDate < GALLERIAN_FROM,
      );
      expect(before.length).toBeGreaterThan(0);
      const beforeProfit = before.reduce(
        (n, e) => n + e.grossOre - e.costOre - e.cardFeeOre - e.vmbVatOre,
        0,
      );
      const beforeVmb = before.reduce((n, e) => n + e.vmbVatOre, 0);
      const rounding = splits.reduce(
        (n, s) => n + s.result.operatorShareOre - s.result.storeShareOre,
        0,
      );
      const splitVmb = splits.reduce((n, s) => n + s.result.vmbVatOre, 0);
      const splitRefunds = splits.reduce((n, s) => n + s.result.refundsOre, 0);
      const vmb = page.model.totals.vmbVatOre;
      const ours = page.result.profitAfterRefundsOre;
      expect(ours - storeShare).toBe(
        beforeProfit +
          rounding +
          (splitVmb - (vmb - beforeVmb)) +
          (splitRefunds - page.result.refundOre),
      );
      // Med avtalets regel på orderna före avtalet (VMB 20 % av deras marginal) är skillnaden
      // bara öresavrundningen per butik och månad.
      const beforeMargin = before.reduce((n, e) => n + e.grossOre - e.costOre, 0);
      const beforeAtSplitRule =
        before.reduce((n, e) => n + e.grossOre - e.costOre - e.cardFeeOre, 0) -
        vmbVatOfMargin(beforeMargin);
      expect(Math.abs(ours - beforeAtSplitRule - storeShare)).toBeLessThanOrEqual(
        2 * splits.length,
      );
    });
  });

  it("Hem, Butiker och Automater visar samma vinst efter VMB-moms som Lönsamhet", async () => {
    await asOwner(async () => {
      const page = await lonsamhet(SEED_ON);
      expect(carriedQuery(SEED_ON)).toContain("vmb=1");
      const home = await loadHome(SEED_ON);
      expect(ourProfit(home)).toBe(page.model.totals.profitOre);
      // Hem visar vår vinst; hela vinsten = vår vinst + butikernas andel, efter VMB-moms.
      expect(kpi(home, "profit")).toBe(page.model.totals.profitOre);
      expect(home.model.profitSplit?.totalOre).toBe(
        page.model.totals.profitOre + page.model.totals.compensationOre,
      );
      expect(home.model.kpis.find((k) => k.id === "profit")?.note).toBe(
        "efter VMB-moms (preliminär)",
      );
      const stores = await loadStoreList(SEED_ON);
      expect(stores.rows.reduce((n, r) => n + r.profitOre, 0)).toBe(page.model.totals.profitOre);
      const machines = await loadOverview(SEED_ON);
      expect(machines.overview.totals.profitOre).toBe(page.model.totals.profitOre);
    });
  });

  it("butiks- och automatfilter: samma VMB-moms (och för butiken samma vinst) som raden", async () => {
    await asOwner(async () => {
      const page = await lonsamhet(SEED_ON);
      const byStore = profitability(page.input.current, "store");
      const byMachine = profitability(page.input.current, "machine");
      for (const [name, id] of storeIds) {
        const row = byStore.rows.find((r) => r.key === id);
        if (!row) continue;
        const filtered = await lonsamhet({ ...SEED_ON, butik: id });
        expect(filtered.model.totals.vmbVatOre, name).toBe(row.vmbVatOre);
        expect(filtered.model.totals.profitOre, name).toBe(row.profitOre);
        // Hem med butiksfilter: butikens hela vinst och delning, samma som butikens rad.
        view.vmb = true;
        const home = await loadHome({ ...SEED_ON, butik: id });
        expect(home.model.profitSplit, name).toEqual({
          totalOre: row.profitOre + row.compensationOre,
          ourOre: row.profitOre,
          storesOre: row.compensationOre,
        });
        expect(kpi(home, "profit"), name).toBe(row.profitOre);
      }
      // Vy av: samma kontroll utan VMB-moms.
      const off = await lonsamhet(SEED_RANGE);
      const offByStore = profitability(off.input.current, "store");
      for (const [name, id] of storeIds) {
        const row = offByStore.rows.find((r) => r.key === id);
        if (!row) continue;
        view.vmb = false;
        const home = await loadHome({ ...SEED_RANGE, butik: id });
        expect(home.model.profitSplit?.ourOre, name).toBe(row.profitOre);
        expect(kpi(home, "profit"), name).toBe(row.profitOre);
        expect(home.model.profitSplit?.totalOre, name).toBe(row.profitOre + row.compensationOre);
      }
      for (const [code, id] of machineIds) {
        const row = byMachine.rows.find((r) => r.key === id);
        if (!row) continue;
        const filtered = await lonsamhet({ ...SEED_ON, automat: id });
        expect(filtered.model.totals.vmbVatOre, code).toBe(row.vmbVatOre);
      }
    });
  });

  it("delmånad är preliminär; oktober är avslutad och lika med Bokföringens VMB-moms", async () => {
    await asOwner(async () => {
      expect((await lonsamhet(SEED_ON)).model.bridge.vmbPreliminary).toBe(true);
      const oct = await lonsamhet(OCTOBER_ON);
      expect(oct.model.bridge.vmbPreliminary).toBe(false);

      // Bokföringen med inköpsvärdet för sålda pack som VMB-underlag (samma som Lönsamhet).
      await saveBokforingSettingsFor(owner, {
        plan: DEFAULT_PLAN,
        series: "BL",
        orgNumber: "",
        purchaseBasis: "cost_of_goods",
        openingCarryOre: 0,
      });
      await setBokforingVmbFor(owner, true);
      const book = await loadBokforingFor(owner, TODAY);
      const october = book.months.find((m) => m.month === "2026-10");
      expect(october).toBeDefined();
      expect(october!.book.vmb.vatOre).toBe(oct.model.totals.vmbVatOre);
      expect(october!.book.vmb.carryInOre).toBe(0);

      // Och samma som den gemensamma uträkningen på månadens siffror.
      const chain = vmbChain([
        {
          month: "2026-10",
          salesInclVatOre: oct.model.totals.revenueOre - oct.result.refundOre,
          purchasesOre: oct.model.totals.costOre,
        },
      ]);
      expect(chain.get("2026-10")!.vatOre).toBe(oct.model.totals.vmbVatOre);
    });
  });
});

/** Sätter avtalens "Dra av VMB-moms före delning" för hela organisationen. */
async function setBeforeSplit(on: boolean): Promise<void> {
  await db().execute(sql`
    update public.store_agreements set vmb_before_split = ${on}
     where organization_id = ${orgId}::uuid`);
}

/** Avstämningen för en vy: alla belopp i öre. */
async function reconcile(sp: SearchParamsInput) {
  const page = await lonsamhet(sp);
  const t = page.model.totals;
  const ledger = buildLedger(page.input.current);
  const splits = ledger.profitSplits;
  const sales = pricedSales(page);
  return {
    sales,
    refunds: page.result.refundOre,
    purchases: t.costOre,
    cardFees: t.feesOre,
    storeShare: t.compensationOre,
    vmbInProfit: t.vmbVatOre,
    vmbInSplits: splits.reduce((n, x) => n + x.result.vmbVatOre, 0),
    profit: t.profitOre,
    profitAfterRefunds: page.result.profitAfterRefundsOre,
    splits,
    page,
  };
}

describe("vy av/på × avtal på/av: vinsten stämmer exakt", () => {
  afterAll(async () => {
    await setBeforeSplit(true);
  });

  it("vy av (standard): ingen VMB-moms i vår vinst och inget steg i vattenfallet", async () => {
    await asOwner(async () => {
      await setBeforeSplit(true);
      const off = await reconcile(SEED_RANGE);
      expect(off.vmbInProfit).toBe(0);
      expect(off.page.model.bridge.vmbVatOre).toBeNull();
      const home = await loadHome(SEED_RANGE);
      expect(ourProfit(home)).toBe(off.profit);
      expect(kpi(home, "profit")).toBe(off.profit);
      expect(home.model.profitSplit?.totalOre).toBe(off.profit + off.storeShare);
      expect(home.model.kpis.find((k) => k.id === "profit")?.note ?? null).toBeNull();
      const stores = await loadStoreList(SEED_RANGE);
      expect(stores.rows.reduce((n, r) => n + r.profitOre, 0)).toBe(off.profit);
      const machines = await loadOverview(SEED_RANGE);
      expect(machines.overview.totals.profitOre).toBe(off.profit);
    });
  });

  it("vår vinst = försäljning − återbetalningar − inköp − kortavgifter − butikens andel (− VMB med vyn)", async () => {
    await asOwner(async () => {
      interface Row {
        sales: number;
        refunds: number;
        purchases: number;
        cardFees: number;
        storeShare: number;
        vmbInSplits: number;
        vmbInProfit: number;
        profitAfterRefunds: number;
      }
      const table: Record<string, Row> = {};
      for (const beforeSplit of [true, false]) {
        await setBeforeSplit(beforeSplit);
        const off = await reconcile(SEED_RANGE);
        const on = await reconcile(SEED_ON);
        for (const [name, x] of [
          ["av", off],
          ["på", on],
        ] as const) {
          const label = `vy ${name}, avtal ${beforeSplit ? "på" : "av"}`;
          expect(x.page.model.totals.unpricedOrders, label).toBe(0);
          expect(
            x.sales - x.refunds - x.purchases - x.cardFees - x.storeShare - x.vmbInProfit,
            label,
          ).toBe(x.profitAfterRefunds);
          // Butikens andel = Σ 50 % × (vinst efter kostnader − VMB om avtalet drar av den).
          for (const sp of x.splits) {
            const r = sp.result;
            const base =
              r.salesInclVatOre - r.refundsOre - r.purchasesOre - r.cardFeesOre - r.vmbVatOre;
            expect(r.vmbVatOre, label).toBe(
              beforeSplit ? vmbVatOfMargin(r.salesInclVatOre - r.refundsOre - r.purchasesOre) : 0,
            );
            expect(r.storeShareOre, label).toBe(base >= 0 ? Math.round(base / 2) : 0);
          }
          table[label] = {
            sales: x.sales,
            refunds: x.refunds,
            purchases: x.purchases,
            cardFees: x.cardFees,
            storeShare: x.storeShare,
            vmbInSplits: x.vmbInSplits,
            vmbInProfit: x.vmbInProfit,
            profitAfterRefunds: x.profitAfterRefunds,
          };
        }
        // Vyknappen ändrar bara vår vinst, inte butikens andel.
        expect(on.storeShare).toBe(off.storeShare);
        expect(off.profitAfterRefunds - on.profitAfterRefunds).toBe(on.vmbInProfit);
        expect(on.vmbInProfit).toBeGreaterThan(0);
      }
      // Avtalet av: butiken får hälften av VMB-momsen mer (± öresavrundning per butik och månad).
      const a = table["vy av, avtal på"]!;
      const b = table["vy av, avtal av"]!;
      expect(b.vmbInSplits).toBe(0);
      expect(Math.abs(b.storeShare - a.storeShare - a.vmbInSplits / 2)).toBeLessThanOrEqual(10);
      console.info(`AVSTAMNING ${JSON.stringify(table)}`);
    });
  });

  it("nya avtal drar inte av VMB före delningen (kolumnens standard är falskt)", async () => {
    const [row] = await rows<{ d: string | null }>(
      db(),
      sql`select column_default as d from information_schema.columns
           where table_schema = 'public' and table_name = 'store_agreements'
             and column_name = 'vmb_before_split'`,
    );
    expect(row!.d).toBe("false");
  });

  it("Bokföringen räknar och bokför VMB-momsen med knappen på, oberoende av vyknappen, och butikernas andel enligt avtalet", async () => {
    await asOwner(async () => {
      await saveBokforingSettingsFor(owner, {
        plan: DEFAULT_PLAN,
        series: "BL",
        orgNumber: "",
        purchaseBasis: "cost_of_goods",
        openingCarryOre: 0,
      });
      await setBokforingVmbFor(owner, true);
      for (const beforeSplit of [true, false]) {
        await setBeforeSplit(beforeSplit);
        const octOn = await reconcile(OCTOBER_ON);
        const octOff = await reconcile(OCTOBER);
        view.vmb = false;
        const book = await loadBokforingFor(owner, TODAY);
        const october = book.months.find((m) => m.month === "2026-10")!;
        expect(october.book.vmb.vatOre).toBeGreaterThan(0);
        expect(october.book.vmb.vatOre).toBe(octOn.vmbInProfit);
        // Butikernas andel i Bokföringen = Lönsamhetens (samma avtal), oavsett vyknappen.
        expect(october.book.storeShareOre).toBe(octOff.storeShare);
        expect(october.book.storeShareOre).toBe(octOn.storeShare);
        for (const st of october.book.stores.filter((x) => x.split)) {
          expect(st.split!.vmbBeforeSplit).toBe(beforeSplit);
        }
        console.info(
          `BOKFORING avtal ${beforeSplit ? "på" : "av"} ${JSON.stringify({
            vmb: october.book.vmb.vatOre,
            storeShare: october.book.storeShareOre,
            result: october.book.resultOre,
          })}`,
        );
      }
      // Knappen av (standard): samma butiksandel, ingen VMB-moms och resultatet utan VMB.
      const on = (await loadBokforingFor(owner, TODAY)).months.find(
        (m) => m.month === "2026-10",
      )!.book;
      await setBokforingVmbFor(owner, false);
      const off = (await loadBokforingFor(owner, TODAY)).months.find(
        (m) => m.month === "2026-10",
      )!.book;
      expect(off.vmbEnabled).toBe(false);
      expect(off.vmb.vatOre).toBe(0);
      expect(off.storeShareOre).toBe(on.storeShareOre);
      expect(off.resultOre - on.resultOre).toBe(on.vmb.vatOre);
    });
  });
});
