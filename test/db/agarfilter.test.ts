/**
 * Butiksägaren som filter (?agare=): en ägares siffror är exakt summan av dess butikers,
 * för försäljning, sålda pack, vinst och butikernas andel, på sidorna och i laddarna.
 *
 * Seeden (src/seed) körs i en EGEN organisation. En påhittad ägare får tre butiker:
 *   Gallerian   bara hyra (seedens avtal)
 *   Kiosken     8 % av försäljningen + hyra (seedens avtal)
 *   Utan avtal  ny butik utan avtal: BL-003 flyttas dit från Kiosken 27 okt.
 * Spelbutiken (vinstdelning 50 %) har ingen ägare och ska inte räknas med. En automat som
 * flyttar mellan två av ägarens butiker räknas en gång. Ägaren drar butikernas andel som en
 * vald butik (även utan vyknappen), och en annan ägare med en butik ger samma tal som
 * butiken.
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
import { buildLonsamhetModel } from "@/app/(app)/lonsamhet/_lib/model";
import { profitability } from "@/domain";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor } from "@/server/access";
import { loadDomainInput, loadPeriod, loadSalesCounts, requireRoute } from "@/server/data/core";
import { runSeed } from "@/seed/run-seed";

import { db, one, rows, uniqueSuffix } from "./helpers";

const NOW = new Date("2026-11-03T10:00:00Z");
/** Hela seedperioden: korsar månadsskiftet och flytten av BL-003 (27 okt.). */
const SEED = { from: "2026-10-13", to: "2026-11-01" } as const;
const MOVE_DAY = "2026-10-27";

let orgId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };
const storeIds = new Map<string, string>();
let ownerId: string;
let singleOwnerId: string;
const OWNED = ["Gallerian Väst (exempel)", "Kiosken Stationen (exempel)", "Utan avtal"];

function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  session.current = owner;
  return fn();
}

/** Laddarnas tal för ett filter (?butik= eller ?agare=), som sidorna läser dem. */
async function figures(filter: Record<string, string>) {
  const sp = { ...SEED, ...filter };
  const p = await loadPeriod(sp);
  const input = await loadDomainInput({ period: p.period, compare: null, ...p.scope });
  const t = profitability(input.current, "title").totals;
  const packs = await loadSalesCounts({ period: p.period, ...p.scope });
  return {
    revenue: t.revenueOre,
    orders: t.orders,
    packs: packs.units,
    profit: t.profitOre,
    beforeShare: t.profitBeforeShareOre,
    storeShare: t.compensationOre,
    deducted: input.settings.deductStoreShare === true,
  };
}

/** Sidornas vinst och försäljning för ett filter. */
async function pages(filter: Record<string, string>) {
  const sp = { ...SEED, ...filter };
  const ctx = await requireRoute("lonsamhet");
  const p = await loadPeriod(sp);
  const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
  const model = buildLonsamhetModel(
    {
      current: input.current,
      previous: input.previous,
      titles: input.titles,
      machines: input.machines,
      stores: input.stores,
      scope: input.scope,
      owners: input.owners,
    },
    { today: ctx.today, carry: "", lastOrderDate: null },
  );
  const home = await loadHome(sp);
  const automater = await loadOverview(sp);
  const butiker = await loadStoreList(sp);
  const sum = (xs: readonly { profitOre: number }[]) => xs.reduce((n, x) => n + x.profitOre, 0);
  return {
    "Lönsamhet vinst": model.kpis.find((k) => k.id === "profit")!.value,
    "Lönsamhet vattenfall": model.bridge.profitOre,
    "Hem vinst": home.model.kpis.find((k) => k.id === "profit")!.value,
    "Hem försäljning": home.model.kpis.find((k) => k.id === "revenue")!.value,
    "Automater vinst": automater.overview.totals.profitOre,
    "Butiker rader": sum(butiker.rows),
  } as Record<string, number>;
}

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-agarfilter",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-agarfilter-"))),
    organization: { name: `Ägarfilter ${suffix}`, slug: `agarfilter-${suffix}` },
    users: {
      owner: {
        email: `agarfilter-${suffix}@test.binderlab.se`,
        fullName: "Ägare",
        role: "owner",
      },
      partner: {
        email: `agarfilter-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  const ownerUser = { userId: seeded.users.owner, email: `agarfilter-${suffix}@test.binderlab.se` };
  const org = (await listOrganizationsFor(ownerUser)).find((o) => o.id === orgId);
  if (!org) throw new Error("Saknar medlemskap");
  owner = { user: ownerUser, organization: org };

  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.stores where organization_id = ${orgId}::uuid`,
  ))
    storeIds.set(r.name, r.id);
  const bl003 = await one<{ id: string }>(
    db(),
    sql`select id from public.machines where organization_id = ${orgId}::uuid and code = 'BL-003'`,
  );
  // En butik utan avtal: BL-003 flyttas dit från Kiosken 27 okt.
  const noDeal = await one<{ id: string }>(
    db(),
    sql`insert into public.stores (organization_id, name)
        values (${orgId}::uuid, 'Utan avtal') returning id`,
  );
  storeIds.set("Utan avtal", noDeal.id);
  await db().execute(sql`
    update public.machine_placements set valid_to = '2026-10-26'
     where organization_id = ${orgId}::uuid and machine_id = ${bl003.id}::uuid and valid_to is null`);
  await db().execute(sql`
    insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
    values (${orgId}::uuid, ${bl003.id}::uuid, ${noDeal.id}::uuid, ${MOVE_DAY}::date)`);
  // Spelbutiken: vinstdelning 50 % (ingen ägare: ska inte räknas med).
  await db().execute(sql`
    update public.store_agreements a
       set commission_base = 'profit_after_costs', commission_bp = 5000, monthly_rent_ore = null
      from public.stores s
     where a.organization_id = ${orgId}::uuid and s.id = a.store_id
       and s.name = 'Spelbutiken Centrum (exempel)'`);
  // Inköpspris för alla titlar: alla order ingår i vinsten.
  await db().execute(sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    select t.organization_id, t.id, 9500, '2026-10-01'
      from public.titles t
     where t.organization_id = ${orgId}::uuid
       and not exists (select 1 from public.purchase_prices p
                        where p.organization_id = t.organization_id and p.title_id = t.id)`);
  // Påhittade ägare: en med tre butiker, en med bara Spelbutiken.
  const o = await one<{ id: string }>(
    db(),
    sql`insert into public.store_owners (organization_id, legal_name, org_number)
        values (${orgId}::uuid, 'Godisbolaget Väst AB', '559900-1236') returning id`,
  );
  ownerId = o.id;
  for (const name of OWNED) {
    await db().execute(
      sql`update public.stores set owner_id = ${ownerId}::uuid where id = ${storeIds.get(name)!}::uuid`,
    );
  }
  const single = await one<{ id: string }>(
    db(),
    sql`insert into public.store_owners (organization_id, legal_name, org_number)
        values (${orgId}::uuid, 'Eget Bolag AB', '802400-0013') returning id`,
  );
  singleOwnerId = single.id;
  await db().execute(
    sql`update public.stores set owner_id = ${singleOwnerId}::uuid
        where id = ${storeIds.get("Spelbutiken Centrum (exempel)")!}::uuid`,
  );

  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 180_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
  view.andel = false;
});

describe("ägarfiltret är summan av ägarens butiker", () => {
  it("försäljning, order, pack, vinst och butikernas andel", async () => {
    await asOwner(async () => {
      for (const andel of [false, true]) {
        view.andel = andel;
        const all = await figures({ agare: ownerId });
        const parts = await Promise.all(
          OWNED.map((name) => figures({ butik: storeIds.get(name)! })),
        );
        const sum = (k: keyof (typeof parts)[number]) =>
          parts.reduce((n, x) => n + Number(x[k]), 0);
        expect(all.revenue).toBeGreaterThan(0);
        expect(all.packs).toBeGreaterThan(0);
        expect(all.storeShare).toBeGreaterThan(0);
        for (const k of [
          "revenue",
          "orders",
          "packs",
          "profit",
          "beforeShare",
          "storeShare",
        ] as const) {
          expect([k, all[k]]).toEqual([k, sum(k)]);
        }
        // Ägaren drar butikernas andel som en vald butik, med och utan vyknappen.
        expect(all.deducted).toBe(true);
        expect(all.profit).toBe(all.beforeShare - all.storeShare);
        expect(parts.every((x) => x.deducted)).toBe(true);
      }
    });
  });

  it("Spelbutiken räknas inte med; hela organisationen är ägaren plus Spelbutiken", async () => {
    await asOwner(async () => {
      view.andel = true;
      const all = await figures({ agare: ownerId });
      const rest = await figures({ butik: storeIds.get("Spelbutiken Centrum (exempel)")! });
      const org = await figures({});
      expect(all.revenue + rest.revenue).toBe(org.revenue);
      expect(all.packs + rest.packs).toBe(org.packs);
      expect(all.storeShare + rest.storeShare).toBe(org.storeShare);
      expect(all.revenue).toBeLessThan(org.revenue);
    });
  });

  it("en ägare med en butik ger exakt butikens tal", async () => {
    await asOwner(async () => {
      view.andel = false;
      expect(await figures({ agare: singleOwnerId })).toEqual(
        await figures({ butik: storeIds.get("Spelbutiken Centrum (exempel)")! }),
      );
    });
  });

  it("sidorna (Lönsamhet, Hem, Automater, Butiker) visar summan av butikerna", async () => {
    await asOwner(async () => {
      view.andel = false;
      const all = await pages({ agare: ownerId });
      const parts = await Promise.all(OWNED.map((name) => pages({ butik: storeIds.get(name)! })));
      for (const key of Object.keys(all)) {
        const sum = parts.reduce((n, x) => n + x[key]!, 0);
        expect([key, all[key]]).toEqual([key, sum]);
      }
    });
  });

  it("Hem visar ägarens namn och andelen till ägaren; en vald butik vinner över ägaren", async () => {
    await asOwner(async () => {
      const home = await loadHome({ ...SEED, agare: ownerId });
      expect(home.scope).toMatchObject({ kind: "owner", name: "Godisbolaget Väst AB" });
      const butik = storeIds.get("Gallerian Väst (exempel)")!;
      const both = await figures({ agare: ownerId, butik });
      expect(both).toEqual(await figures({ butik }));
      // Ett okänt ägar-id: inga butiker, inga order (som en okänd butik).
      const unknown = await figures({ agare: "00000000-0000-4000-8000-000000000000" });
      expect(unknown.revenue).toBe(0);
    });
  });
});
