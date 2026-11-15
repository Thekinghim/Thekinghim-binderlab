/**
 * Pris mot kund ändrar ingen siffra (20261216000000_kundpris.sql): vinst, marginal,
 * butikernas andel, rapporter, bokföring och lagervärde är identiska med och utan pris mot
 * kund. Ägarens beslut: visa båda priserna, räkna som i dag (på vårt pris).
 *
 * Seeden körs i en egen organisation (som consistency.test.ts) och sidorna läses med
 * appens egna laddare: beräkningsindata och lönsamheten per titel, automat och butik, Hem,
 * Lönsamhet, Automater, Butiker, Prognos (lagervärdet), Bokföring och ögonblicksbilderna
 * för butiks-, delägar- och bokföringsrapporten. Allt läses tre gånger:
 *
 *   1. utan pris mot kund på någon rad (seedens två rader töms först),
 *   2. med pris mot kund på varje prisrad (olika belopp, även lägre än inköpspriset och 0),
 *   3. efter att ägaren ändrat ett pris mot kund med sidans server action.
 *
 * Svaren ska vara lika, tecken för tecken. Som kontroll ändras till sist ett inköpspris:
 * då ändras svaren, så jämförelsen är inte blind.
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
// Sessionen och Next: den inloggade är `session.current` (som consistency.test.ts).
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
import { addPurchasePrice, setCustomerPrice } from "@/app/(app)/inkopspriser/actions";
import { loadPricePageFor } from "@/app/(app)/inkopspriser/_lib/data";
import { loadHome } from "@/app/(app)/_hem/load";
import { buildLonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import { loadOverview } from "@/app/(app)/automater/_lib/data";
import { loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { carriedQuery } from "@/components/shell/period-state";
import { profitability, titleEconomics } from "@/domain";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor } from "@/server/access";
import { loadBokforingFor } from "@/server/bokforing/service";
import { loadDomainInput, loadPeriod, requireRoute } from "@/server/data/core";
import { loadPrognosFor } from "@/server/purchasing";
import { createReportFor, getReportFor } from "@/server/reports/service";
import { runSeed } from "@/seed/run-seed";

import { db, rows, uniqueSuffix } from "./helpers";

const NOW = new Date("2026-11-02T10:00:00Z");
const TODAY = "2026-11-02";
/** Eget intervall: hela seedperioden. */
const SEED_RANGE = { from: "2026-10-13", to: "2026-11-01" } as const;
const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };

type Who = { user: SessionUser; organization: OrganizationMembership };

let orgId: string;
let owner: Who;
let storeIds: string[] = [];

/** JSON med sorterade nycklar, så att två svar kan jämföras tecken för tecken. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Map) return Object.fromEntries([...v.entries()].sort());
    if (v instanceof Set) return [...v.values()].sort();
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

/** Rapportens ögonblicksbild för oktober (utkastet skapas om varje gång). */
async function reportSnapshot(req: Parameters<typeof createReportFor>[1]): Promise<unknown> {
  const id = await createReportFor(owner, req, NOW);
  return (await getReportFor(owner, id)).snapshot;
}

/**
 * Allt som räknas: varje del är ett svar från appens egen laddare. Nycklarna säger vilken
 * del som skiljer sig om något ändras.
 */
async function everything(): Promise<Record<string, string>> {
  session.current = owner;
  const ctx = await requireRoute("lonsamhet");
  const p = await loadPeriod(SEED_RANGE);
  const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
  const lonsamhet = buildLonsamhetModel(
    {
      current: input.current,
      previous: input.previous,
      titles: input.titles,
      machines: input.machines,
      stores: input.stores,
      scope: input.scope,
    },
    { today: ctx.today, carry: carriedQuery(SEED_RANGE).replace(/^\?/, ""), lastOrderDate: null },
  );
  const out: Record<string, unknown> = {
    // Beräkningsindata: order, priser, avtal, inställningar. Här skulle en ny kolumn synas.
    indata: input,
    "lönsamhet per titel": profitability(input.current, "title"),
    "lönsamhet per automat": profitability(input.current, "machine"),
    "lönsamhet per butik (butikernas andel)": profitability(input.current, "store"),
    "kvar per order per titel": titleEconomics({
      ...input.current,
      titleIds: input.titles.map((t) => t.id),
    }),
    hem: (await loadHome(SEED_RANGE)).model,
    lönsamhet: lonsamhet,
    automater: (await loadOverview(SEED_RANGE)).overview,
    butiker: await loadStoreList(SEED_RANGE),
    "prognos och lagervärde": await loadPrognosFor(owner, { period: OCTOBER }, NOW),
    bokföring: await loadBokforingFor(owner, TODAY),
    "delägarrapport oktober": await reportSnapshot({ type: "delagare", month: "2026-10" }),
    "bokföringsrapport oktober": await reportSnapshot({ type: "bokforing", month: "2026-10" }),
  };
  for (const storeId of storeIds) {
    out[`butiksrapport oktober ${storeId}`] = await reportSnapshot({
      type: "butik",
      month: "2026-10",
      storeId,
    });
  }
  // Databasens egen summering (samma fråga som close_period gör): inköp per order.
  out["databasens inköp per order"] = await rows(
    db(),
    sql`select count(*)::int as orders, coalesce(sum(c.unit_cost_ore), 0)::bigint as cost_ore,
               count(*) filter (where c.unit_cost_ore is null)::int as unpriced
        from public.orders o
        left join lateral (
          select pp.unit_cost_ore from public.purchase_price_periods pp
          where pp.organization_id = o.organization_id and pp.title_id = o.title_id
            and pp.valid_from <= o.business_date
            and (pp.valid_to is null or pp.valid_to >= o.business_date)
        ) c on true
        where o.organization_id = ${orgId}::uuid`,
  );
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, stable(v)]));
}

/** Delarna som skiljer sig mellan två läsningar (tom = identiska). */
function differing(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}

async function customerPrices(): Promise<Array<number | null>> {
  const r = await rows<{ customer: number | null }>(
    db(),
    sql`select customer_price_ore::int as customer from public.purchase_prices
        where organization_id = ${orgId}::uuid order by title_id, valid_from`,
  );
  return r.map((x) => x.customer);
}

let without: Record<string, string>;

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const email = `kundpris-agare-${suffix}@test.binderlab.se`;
  const seeded = await runSeed(db(), {
    password: "binderlab-kundpris",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-kundpris-"))),
    organization: { name: `Kundpris ${suffix}`, slug: `kundpris-${suffix}` },
    users: {
      owner: { email, fullName: "Ägare", role: "owner" },
      partner: {
        email: `kundpris-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  const user = { userId: seeded.users.owner, email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  owner = { user, organization };
  storeIds = (
    await rows<{ id: string }>(
      db(),
      sql`select id from public.stores where organization_id = ${orgId}::uuid order by name`,
    )
  ).map((s) => s.id);

  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 180_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
});

describe("pris mot kund ändrar ingen siffra", () => {
  it("1. utan pris mot kund: utgångsläget läses (och har order, inköp och butiker)", async () => {
    // Seeden har pris mot kund på 30th Celebration: det töms, så att läget är som före bygget.
    expect((await customerPrices()).filter((c) => c !== null)).toEqual([14_500, 14_500]);
    await db().execute(
      sql`update public.purchase_prices set customer_price_ore = null
          where organization_id = ${orgId}::uuid`,
    );
    expect((await customerPrices()).every((c) => c === null)).toBe(true);

    // Första läsningen skapar rapportutkasten (de syns sedan på Hem som något att göra);
    // utgångsläget läses därför efter den.
    await everything();
    without = await everything();
    expect(storeIds.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(without).length).toBe(14 + storeIds.length);
    const db0 = JSON.parse(without["databasens inköp per order"]!) as Array<{
      orders: number;
      cost_ore: string;
    }>;
    expect(db0[0]!.orders).toBe(460);
    expect(Number(db0[0]!.cost_ore)).toBeGreaterThan(0);
    // Läsningen är stabil: två läsningar i rad är lika (annars vore jämförelsen meningslös).
    expect(differing(without, await everything())).toEqual([]);
  }, 240_000);

  it("2. med pris mot kund på varje prisrad: alla svar är identiska", async () => {
    // Olika belopp per rad: högre än inköpspriset, lägre än det, och 0 kr.
    await db().execute(
      sql`with numbered as (
            select id, unit_cost_ore, row_number() over (order by title_id, valid_from) as n
            from public.purchase_prices where organization_id = ${orgId}::uuid
          )
          update public.purchase_prices pp
          set customer_price_ore = case numbered.n % 4
                when 0 then numbered.unit_cost_ore + 3500
                when 1 then numbered.unit_cost_ore * 3
                when 2 then numbered.unit_cost_ore / 2
                else 0
              end
          from numbered where pp.id = numbered.id`,
    );
    const set = await customerPrices();
    expect(set.length).toBeGreaterThan(10);
    expect(set.every((c) => c !== null)).toBe(true);
    expect(new Set(set).size).toBeGreaterThan(5);

    expect(differing(without, await everything())).toEqual([]);
  }, 240_000);

  it("3. ägaren ändrar ett pris mot kund på sidan: fortfarande identiskt, men priset syns på Inköpspriser", async () => {
    session.current = owner;
    const title = (
      await rows<{ id: string }>(
        db(),
        sql`select id from public.titles
            where organization_id = ${orgId}::uuid and name = '30th Celebration'`,
      )
    )[0]!;
    const saved = await setCustomerPrice({ titleId: title.id, customerPriceOre: 14_500 });
    expect(saved).toEqual({ ok: true, data: { customerPriceOre: 14_500 } });

    expect(differing(without, await everything())).toEqual([]);

    const page = await loadPricePageFor(owner.user, orgId);
    const current = page.prices.filter((p) => p.titleId === title.id).at(-1)!;
    expect(current).toMatchObject({ unitCostOre: 11_200, customerPriceOre: 14_500 });
  }, 240_000);

  it("kontroll: ett ändrat INKÖPSPRIS ändrar svaren (jämförelsen är inte blind)", async () => {
    session.current = owner;
    const title = (
      await rows<{ id: string }>(
        db(),
        sql`select id from public.titles
            where organization_id = ${orgId}::uuid and name = '30th Celebration'`,
      )
    )[0]!;
    const r = await addPurchasePrice({
      titleId: title.id,
      unitCostOre: 12_000,
      validFrom: "2026-10-20",
    });
    expect(r.ok).toBe(true);
    const changed = differing(without, await everything());
    for (const part of [
      "indata",
      "lönsamhet per titel",
      "lönsamhet per automat",
      "lönsamhet per butik (butikernas andel)",
      "kvar per order per titel",
      "hem",
      "lönsamhet",
      "automater",
      "butiker",
      "delägarrapport oktober",
      "databasens inköp per order",
    ]) {
      expect(changed, part).toContain(part);
    }
    // Det nya inköpspriset tog över periodens pris mot kund (det gällande 20 okt.).
    const page = await loadPricePageFor(owner.user, orgId);
    const added = page.prices.find((p) => p.titleId === title.id && p.validFrom === "2026-10-20");
    expect(added?.customerPriceOre).not.toBeNull();
  }, 240_000);
});
