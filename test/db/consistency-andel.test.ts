/**
 * Ägarens regel för butikernas andel, prövad på alla sidor mot samma seedade databas:
 *
 *   Av (standard):  vår vinst = försäljning − återbetalningar − inköp − avgifter
 *                   (butikernas andel dras INTE, inte heller hyran)
 *   På (vyknappen "Visa butikernas andel", eller vald butik):
 *                   vår del   = vinsten ovan − Σ varje butiks andel enligt sitt eget avtal
 *
 * och andelen är exakt det avräkningarna (det butikerna ska ha) räknar.
 *
 * Seeden (src/seed) körs i en EGEN organisation. Avtalen görs om så att alla sorter finns:
 *   Spelbutiken  vinstdelning 50 % av vinsten efter kostnader
 *   Gallerian    bara hyra 1 500 kr/mån (seedens)
 *   Kiosken      8 % av försäljningen + hyra 750 kr/mån (seedens)
 *   Utan avtal   ny butik utan avtal: BL-003 flyttas dit 27 okt.
 * Alla titlar får inköpspris (inga order utan pris), och en kund får 149 kr tillbaka.
 *
 * Sidorna anropas med SAMMA laddare som i appen: loadHome (Hem), loadDomainInput +
 * buildLonsamhetModel + resultAfterProfit (Lönsamhet, alla vyer och utvecklingen per dag,
 * vecka och månad), loadOverview (Automater), loadStoreList (Butiker),
 * currentPriceEconomics (Inköpspriser), marginAndTrend (Värde) och AI-verktyget nyckeltal.
 * Vyknappen: proxyn sätter headern x-binderlab-andel från ?andel=1 eller kakan; här mockas
 * next/headers.
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

// Vyknappen "Visa butikernas andel": headern som proxyn sätter från ?andel=1 eller kakan.
const view = vi.hoisted(() => ({ andel: false }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(view.andel ? { "x-binderlab-andel": "1" } : {}),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));

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
  unstable_cache: <T>(fn: T) => fn,
}));

import { loadHome } from "@/app/(app)/_hem/load";
import { loadOverview } from "@/app/(app)/automater/_lib/data";
import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { currentPriceEconomics } from "@/app/(app)/inkopspriser/_lib/price-economics";
import { buildLonsamhetModel, type LonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import { resultAfterProfit, type ResultAfterProfit } from "@/app/(app)/lonsamhet/_lib/result";
import { marginAndTrend } from "@/analytics/value";
import { carriedQuery, type SearchParamsInput } from "@/components/shell/period-state";
import { buildLedger, storeShareDeducted } from "@/domain";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, withUserDbFor } from "@/server/access";
import { toolContextFor } from "@/server/assistant/service";
import { keyMetricsTool } from "@/server/assistant/tools/economy";
import { loadProfitAdjustmentsFor } from "@/server/data/adjustments";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";
import { computeSettlementsTx } from "@/server/settlements/live";
import { runSeed } from "@/seed/run-seed";

import { db, one, rows, uniqueSuffix } from "./helpers";

const NOW = new Date("2026-11-03T10:00:00Z");
/** Hela seedperioden: korsar månadsskiftet och flytten av BL-003 (27 okt.). */
const SEED = { from: "2026-10-13", to: "2026-11-01" } as const;
/** Oktober: en hel månad, som avräkningarna. */
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" } as const;
/** Efter seedens prisändring (27 okt.): Inköpspriser räknar med dagens pris. */
const LATE = { from: "2026-10-27", to: "2026-11-01" } as const;
const MOVE_DAY = "2026-10-27";
const REFUND_ORE = 14_900;

let orgId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };
const storeIds = new Map<string, string>();
const machineIds = new Map<string, string>();

function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  session.current = owner;
  return fn();
}

/** Samma val som vyknappen: på = ?andel=1 (proxyn sätter headern). */
function withToggle(sp: Record<string, string>, on: boolean): Record<string, string> {
  view.andel = on;
  return on ? { ...sp, andel: "1" } : sp;
}

// ---------------------------------------------------------------------------
// Fristående facit i SQL (använder inte src/domain). Moms 0 och kortavgift 0.
// ---------------------------------------------------------------------------

/** Vinst före butikernas andel: Σ (betalt − inköpspriset som gällde orderns dag). */
async function beforeShareFacit(from: string, to: string): Promise<number> {
  const r = await one<{ profit: string }>(
    db(),
    sql`select coalesce(sum(o.amount_ore - (
              select p.unit_cost_ore from public.purchase_prices p
               where p.organization_id = o.organization_id and p.title_id = o.title_id
                 and p.valid_from <= o.business_date
               order by p.valid_from desc limit 1)), 0)::bigint as profit
          from public.orders o
         where o.organization_id = ${orgId}::uuid
           and o.business_date between ${from}::date and ${to}::date`,
  );
  return Number(r.profit);
}

// ---------------------------------------------------------------------------
// Sidorna, med sidornas laddare
// ---------------------------------------------------------------------------

interface LonsamhetPage {
  readonly model: LonsamhetModel;
  readonly result: ResultAfterProfit;
  readonly input: Awaited<ReturnType<typeof loadDomainInput>>;
}

async function lonsamhet(sp: SearchParamsInput): Promise<LonsamhetPage> {
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

/** Allt som sidorna visar som vår vinst för perioden, i samma läge. */
async function everyPage(sp: Record<string, string>) {
  const page = await lonsamhet(sp);
  const m = page.model;
  const sum = (xs: readonly { profitOre: number }[]) => xs.reduce((n, x) => n + x.profitOre, 0);
  const trend = (k: "day" | "week" | "month") =>
    sum(m.trend[k].buckets) + m.trend[k].unallocatedProfitOre;
  const home = await loadHome(sp);
  const automater = await loadOverview(sp);
  const butiker = await loadStoreList(sp);
  const tool = await keyMetricsTool.run(
    toolContextFor(owner, "owner", NOW, false, view.andel),
    keyMetricsTool.input.parse({ fran: sp.from, till: sp.to, jamfor: false }),
  );
  const toolData = tool.data as { nyckeltal: { vinstOre: number }; vinstRegel: string };
  return {
    page,
    figures: {
      "Lönsamhet nyckeltal": m.kpis.find((k) => k.id === "profit")!.value,
      "Lönsamhet vattenfall": m.bridge.profitOre,
      "Lönsamhet per titel": sum(m.views.title),
      "Lönsamhet per automat": sum(m.views.machine),
      "Lönsamhet per butik": sum(m.views.store),
      "Lönsamhet utveckling per dag": trend("day"),
      "Lönsamhet utveckling per vecka": trend("week"),
      "Lönsamhet utveckling per månad": trend("month"),
      "Lönsamhet efter vinsten (start)": page.result.profitOre,
      "Hem nyckeltal": home.model.kpis.find((k) => k.id === "profit")!.value,
      "Hem delning": home.model.profitSplit?.ourOre ?? null,
      "Automater nyckeltal": automater.overview.totals.profitOre,
      "Automater rader": sum(automater.overview.rows) + sum(automater.overview.others),
      "Butiker rader": sum(butiker.rows),
      "AI nyckeltal": toolData.nyckeltal.vinstOre,
    } as Record<string, number | null>,
    home,
    butiker,
    automater,
    toolRule: toolData.vinstRegel,
  };
}

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-andel",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-andel-"))),
    organization: { name: `Andel ${suffix}`, slug: `andel-${suffix}` },
    users: {
      owner: {
        email: `andel-agare-${suffix}@test.binderlab.se`,
        fullName: "Ägare",
        role: "owner",
      },
      partner: {
        email: `andel-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  const ownerUser = {
    userId: seeded.users.owner,
    email: `andel-agare-${suffix}@test.binderlab.se`,
  };
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

  // Spelbutiken: vinstdelning 50 % av vinsten efter kostnader (ingen hyra).
  await db().execute(sql`
    update public.store_agreements a
       set commission_base = 'profit_after_costs', commission_bp = 5000, monthly_rent_ore = null
      from public.stores s
     where a.organization_id = ${orgId}::uuid and s.id = a.store_id
       and s.name = 'Spelbutiken Centrum (exempel)'`);
  // En butik utan avtal: BL-003 flyttas dit från Kiosken 27 okt.
  const noDeal = await one<{ id: string }>(
    db(),
    sql`insert into public.stores (organization_id, name)
        values (${orgId}::uuid, 'Utan avtal') returning id`,
  );
  storeIds.set("Utan avtal", noDeal.id);
  await db().execute(sql`
    update public.machine_placements set valid_to = '2026-10-26'
     where organization_id = ${orgId}::uuid and machine_id = ${machineIds.get("BL-003")!}::uuid
       and valid_to is null`);
  await db().execute(sql`
    insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
    values (${orgId}::uuid, ${machineIds.get("BL-003")!}::uuid, ${noDeal.id}::uuid,
            ${MOVE_DAY}::date)`);
  // Inköpspris för titlarna som saknar det: alla order ingår i vinsten.
  await db().execute(sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    select t.organization_id, t.id, 9500, '2026-10-01'
      from public.titles t
     where t.organization_id = ${orgId}::uuid
       and not exists (select 1 from public.purchase_prices p
                        where p.organization_id = t.organization_id and p.title_id = t.id)`);
  // En återbetalning på BL-001 i oktober.
  await db().execute(sql`
    insert into public.incidents (organization_id, machine_id, kind, started_at, description,
                                  refunded_ore, refunded_on)
    values (${orgId}::uuid, ${machineIds.get("BL-001")!}::uuid, 'customer',
            '2026-10-21T12:00:00Z', 'Fick inget pack', ${REFUND_ORE}, '2026-10-21'::date)`);

  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 180_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
  view.andel = false;
});

describe("butikernas andel: samma regel på alla sidor (seedad databas, fyra sorters avtal)", () => {
  it("avtalen är de fyra sorterna och alla order har inköpspris", async () => {
    const deals = await rows<{
      name: string;
      base: string;
      bp: number | null;
      rent: number | null;
    }>(
      db(),
      sql`select s.name, a.commission_base::text base, a.commission_bp bp,
                 a.monthly_rent_ore::int rent
            from public.store_agreements a join public.stores s on s.id = a.store_id
           where a.organization_id = ${orgId}::uuid order by s.name`,
    );
    expect(deals).toEqual([
      { name: "Gallerian Väst (exempel)", base: "net_excl_vat", bp: null, rent: 150_000 },
      { name: "Kiosken Stationen (exempel)", base: "net_excl_vat", bp: 800, rent: 75_000 },
      { name: "Spelbutiken Centrum (exempel)", base: "profit_after_costs", bp: 5000, rent: null },
    ]);
    await asOwner(async () => {
      const page = await lonsamhet(withToggle(SEED, false));
      expect(page.model.totals.unpricedOrders).toBe(0);
    });
  });

  for (const range of [SEED, OCTOBER, LATE]) {
    const label = `${range.from}–${range.to}`;

    it(`${label}, av (standard): alla sidor visar vinsten FÖRE butikernas andel`, async () => {
      await asOwner(async () => {
        const facit = await beforeShareFacit(range.from, range.to);
        const all = await everyPage(withToggle(range, false));
        for (const [where, value] of Object.entries(all.figures)) {
          expect(value, `${label} ${where}`).toBe(facit);
        }
        const m = all.page.model;
        expect(m.showStoreShare).toBe(false);
        expect(storeShareDeducted(all.page.input.settings)).toBe(false);
        expect(m.totals.compensationOre).toBeGreaterThan(0);
        expect(m.kpis.map((k) => k.label)).toEqual([
          "Vår vinst",
          "Vår marginal",
          "Intäkt",
          "Order",
        ]);
        expect(m.kpis[1]!.value).toBe(Math.round((facit * 10_000) / m.totals.revenueOre));
        // Avgifterna är bara avgifter (0 här): stegen går ihop utan butikernas andel.
        const b = m.bridge;
        expect(b.revenueOre - b.costOre - b.feesOre).toBe(b.profitOre);
        // Hem: inget "Vår del", ingen delning.
        expect(all.home.model.kpis.find((k) => k.id === "profit")?.label).toBe("Vår vinst");
        expect(all.home.model.showStoreShare).toBe(false);
        expect(all.butiker.showStoreShare).toBe(false);
        expect(all.automater.overview.totals.storeShareDeducted).toBe(false);
        expect(all.toolRule).toMatch(/FÖRE butikernas andel/);
        // Efter återbetalningarna: vinsten − det kunderna fått tillbaka.
        const refunds = range.from <= "2026-10-21" && range.to >= "2026-10-21" ? REFUND_ORE : 0;
        expect(all.page.result.profitAfterRefundsOre).toBe(facit - refunds);
      });
    });

    it(`${label}, på: alla sidor visar vår del = vinsten − varje butiks andel enligt avtalet`, async () => {
      await asOwner(async () => {
        const facit = await beforeShareFacit(range.from, range.to);
        const all = await everyPage(withToggle(range, true));
        const m = all.page.model;
        const share = m.totals.compensationOre;
        expect(m.showStoreShare).toBe(true);
        expect(share).toBeGreaterThan(0);
        // Andelen är summan av butikernas andelar enligt deras avtal (liggaren per butik).
        const ledger = buildLedger(all.page.input.current);
        const splits = ledger.profitSplits.reduce((n, s) => n + s.result.storeShareOre, 0);
        const commission = ledger.entries.reduce((n, e) => n + e.commissionOre, 0);
        const rent =
          ledger.entries.reduce((n, e) => n + e.rentOre, 0) +
          ledger.unallocatedRent.reduce((n, u) => n + u.rentOre, 0);
        expect(splits).toBeGreaterThan(0);
        expect(commission + rent).toBe(share);
        // Per butik: Butiker visar samma andel som Lönsamhet per butik.
        const perStore = new Map(m.views.store.map((r) => [r.key, r.compensationOre]));
        for (const row of all.butiker.rows) {
          expect(row.compensationOre, `${label} ${row.name}`).toBe(perStore.get(row.id) ?? 0);
        }
        // Butiken utan avtal har ingen andel.
        expect(perStore.get(storeIds.get("Utan avtal")!) ?? 0).toBe(0);
        for (const [where, value] of Object.entries(all.figures)) {
          expect(value, `${label} ${where}`).toBe(facit - share);
        }
        expect(m.kpis.find((k) => k.id === "profit")?.label).toBe("Vår del");
        expect(m.kpis.find((k) => k.id === "compensation")).toMatchObject({
          label: "Butikernas andel",
          value: share,
        });
        const b = m.bridge;
        expect(b.profitBeforeShareOre).toBe(facit);
        expect(b.revenueOre - b.costOre - b.feesOre - b.compensationOre).toBe(b.profitOre);
        expect(all.home.model.profitSplit).toEqual({
          totalOre: facit,
          ourOre: facit - share,
          storesOre: share,
        });
        expect(all.toolRule).toMatch(/vår del/);
        // Staplarna per dag och vecka summerar exakt till nyckeltalet: hyran utan order ligger
        // på avtalets dagar, ingen rest "ej fördelad" utanför staplarna.
        for (const k of ["day", "week"] as const) {
          expect(m.trend[k].unallocatedProfitOre, `${label} ${k}`).toBe(0);
          const bars = m.trend[k].buckets.reduce((n, b) => n + b.profitOre, 0);
          expect(bars, `${label} ${k}`).toBe(facit - share);
        }
      });
    });
  }

  it("oktober: butikernas andel på sidorna = det avräkningarna säger att butikerna ska ha", async () => {
    await asOwner(async () => {
      const page = await lonsamhet(withToggle(OCTOBER, true));
      const perStore = new Map(page.model.views.store.map((r) => [r.key, r.compensationOre]));
      const ids = [...storeIds.values()];
      const live = await withUserDbFor(owner.user, (tx) =>
        computeSettlementsTx(tx, {
          organizationId: orgId,
          month: "2026-10",
          storeIds: ids,
          now: NOW,
        }),
      );
      let total = 0;
      for (const [name, id] of storeIds) {
        const s = live.get(id);
        const amount = s && s.ok ? s.computed.amountOre : 0;
        // Avräkningen räknar med återbetalningarna på butikens försäljning (vinstdelningen);
        // utan återbetalning på butiken är beloppet exakt andelen på sidan.
        expect(perStore.get(id) ?? 0, name).toBe(amount);
        total += amount;
      }
      expect(page.model.totals.compensationOre).toBe(total);
      // Avräkningarna är desamma oavsett vyknappen (det butikerna ska ha ändras inte).
      view.andel = false;
      const off = await withUserDbFor(owner.user, (tx) =>
        computeSettlementsTx(tx, {
          organizationId: orgId,
          month: "2026-10",
          storeIds: ids,
          now: NOW,
        }),
      );
      for (const id of ids) {
        const a = live.get(id);
        const b = off.get(id);
        expect(b?.ok ? b.computed.amountOre : 0).toBe(a?.ok ? a.computed.amountOre : 0);
      }
    });
  });

  it("vald butik drar just den butikens andel, med butikens villkor i etiketten", async () => {
    await asOwner(async () => {
      const id = storeIds.get("Spelbutiken Centrum (exempel)")!;
      const all = await lonsamhet(withToggle(SEED, true));
      const row = all.model.views.store.find((r) => r.key === id)!;
      // Utan vyknappen, men med vald butik: andelen dras ändå.
      const page = await lonsamhet({ ...withToggle(SEED, false), butik: id });
      expect(page.model.showStoreShare).toBe(true);
      expect(page.model.totals.profitOre).toBe(row.profitOre);
      expect(page.model.totals.compensationOre).toBe(row.compensationOre);
      expect(page.model.bridge.storeShareLabel).toBe(
        "Spelbutiken Centrum (exempel) 50\u00a0% av vinsten",
      );
      expect(page.model.headline.aside).toMatch(
        /^Spelbutiken Centrum \(exempel\) 50\u00a0% av vinsten: /,
      );
      // Hem med samma butik: samma vår del.
      const home = await loadHome({ ...SEED, butik: id });
      expect(home.model.kpis.find((k) => k.id === "profit")).toMatchObject({
        label: "Vår del",
        value: row.profitOre,
      });
      // Ett automatfilter är ingen vald butik: vinsten är före andelen, även när skalet
      // lägger till automatens butik i adressen (?automat=…&butik=…).
      const machine = await lonsamhet({ ...SEED, automat: machineIds.get("BL-001")! });
      expect(machine.model.showStoreShare).toBe(false);
      const shell = await lonsamhet({ ...SEED, automat: machineIds.get("BL-001")!, butik: id });
      expect(shell.model.showStoreShare).toBe(false);
      expect(shell.model.totals.profitOre).toBe(machine.model.totals.profitOre);
    });
  });

  it("Inköpspriser och Värde: kvar före andelen är samma vinst; andelen bara med vyknappen", async () => {
    await asOwner(async () => {
      // Inköpspriser räknar med dagens inköpspris: efter seedens prisändring är det periodens.
      const late = await beforeShareFacit(LATE.from, LATE.to);
      for (const on of [false, true]) {
        const sp = withToggle(LATE, on);
        const p = await loadPeriod(sp);
        const input = await loadDomainInput({ period: p.period, ...p.scope });
        expect(storeShareDeducted(input.settings)).toBe(on);
        const titles = currentPriceEconomics({
          ...input.current,
          titleIds: input.titles.map((t) => t.id),
        });
        expect(titles.reduce((n, t) => n + (t.leftBeforeStoreTotalOre ?? 0), 0)).toBe(late);
      }
      // Värde: kvar efter inköp i oktober = vinsten före andelen; vår del per butik på.
      const october = await beforeShareFacit(OCTOBER.from, OCTOBER.to);
      for (const on of [false, true]) {
        const sp = withToggle(OCTOBER, on);
        const p = await loadPeriod(sp);
        const input = await loadDomainInput({ period: p.period });
        const value = marginAndTrend(input.current, ["2026-10"], OCTOBER.to);
        expect(value.current.keptOre).toBe(october);
        const page = await lonsamhet(sp);
        const ours = value.stores.reduce((n, s) => n + s.ourOre, 0);
        const shares = value.stores.reduce((n, s) => n + s.storeShareOre, 0);
        expect(shares).toBe(page.model.views.store.reduce((n, r) => n + r.compensationOre, 0));
        expect(ours).toBe(october - shares);
      }
    });
  });

  it("Hem mål: Vinst följer samma regel som nyckeltalet bredvid (av, på, vald butik)", async () => {
    await asOwner(async () => {
      // Gallerian: bara hyra, och en automat som säljer i november.
      const kiosk = storeIds.get("Gallerian Väst (exempel)")!;
      const month = "2026-11-01";
      await db().execute(sql`
        insert into public.goals (organization_id, scope, store_id, month, metric, target)
        values (${orgId}::uuid, 'organization', null, ${month}::date, 'profit', 100000000),
               (${orgId}::uuid, 'store', ${kiosk}::uuid, ${month}::date, 'profit', 100000000)`);
      // Perioden är målens: november t.o.m. i går (i dag, 3 nov., räknas inte i målen).
      const NOV = { from: "2026-11-01", to: "2026-11-02" };
      const goal = (h: Awaited<ReturnType<typeof loadHome>>, scope: "org" | "store") =>
        h.goals!.find((g) => g.metric === "profit" && (scope === "org") === (g.scopeName === null))!
          .actual;
      const kpi = (h: Awaited<ReturnType<typeof loadHome>>) =>
        h.model.kpis.find((k) => k.id === "profit")!.value;

      const off = await loadHome(withToggle(NOV, false));
      const on = await loadHome(withToggle(NOV, true));
      const store = await loadHome({ ...withToggle(NOV, false), butik: kiosk });
      const storeOn = await loadHome({ ...withToggle(NOV, true), butik: kiosk });

      // Av: före andelen, som nyckeltalet. På: efter varje butiks andel, som nyckeltalet.
      expect(goal(off, "org")).toBe(kpi(off));
      expect(goal(on, "org")).toBe(kpi(on));
      expect(goal(on, "org")).toBeLessThan(goal(off, "org"));
      // Vald butik: butikens mål är efter butikens andel, samma tal som nyckeltalet.
      expect(goal(store, "store")).toBe(kpi(store));
      expect(goal(storeOn, "store")).toBe(kpi(store));
      expect(goal(store, "store")).toBe(goal(on, "store"));
      expect(goal(store, "store")).toBeLessThan(goal(off, "store"));
      view.andel = false;
    });
  });
});
