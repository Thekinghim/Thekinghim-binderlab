/**
 * En regel för placeringar, överallt (testdatabasen, egen fixtur, oktober 2026).
 *
 * Automaten BL-001 läggs upp och placeras i butiken den 12 oktober, men Awish-historiken
 * har försäljning från den 3 oktober. Regeln (docs/berakningar.md avsnitt 2): automatens
 * första placering gäller också dagarna före den, tillbaka till automatens första
 * försäljning. Butiken har 50 % av vinsten från 1 oktober.
 *
 *   3 okt.  100 kr (före placeringen)     20 okt.  100 kr
 *   inköp 40 kr per pack → vinst 120 kr → butikens andel 60 kr
 *
 * Förut räknade panelen (Butiker, Lönsamhet) 60 kr, men butiksrapporten, avräkningen och
 * bokföringen bara ordern efter den 12:e: 30 kr. Butiken fick för lite utan att någon såg det.
 */

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

import { loadStoreDetail, loadStoreList } from "@/app/(app)/butiker/_lib/data";
import { buildLedger, storeShareDeducted } from "@/domain";
import { listOrganizationsFor, withUserDbFor } from "@/server/access";
import { loadBokforingFor } from "@/server/bokforing/service";
import { loadDomainInput, loadPeriod } from "@/server/data/core";
import { queryEffectivePlacements, queryPlacements } from "@/server/data/core/queries";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput } from "@/server/reports/sources";
import { computeSettlementsTx } from "@/server/settlements/live";
import { loadSettlementPageFor } from "@/server/settlements/service";

import { asPostgres, createOrg, createUser, one } from "./helpers";

const NOW = new Date("2026-11-03T10:00:00Z");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" } as const;
/** Butikens andel för oktober: 50 % × (200 kr − 80 kr). */
const SHARE = 6_000;

let orgId: string;
let storeId: string;
let machineId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };

beforeAll(async () => {
  const u = await createUser();
  orgId = await createOrg(u, "En placeringsregel");
  await asPostgres(async (tx) => {
    const id = async (q: ReturnType<typeof sql>) => (await one<{ id: string }>(tx, q)).id;
    storeId = await id(
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'Nya butiken') returning id`,
    );
    await tx.execute(sql`insert into public.store_agreements
      (organization_id, store_id, valid_from, commission_base, commission_bp)
      values (${orgId}, ${storeId}, '2026-10-01', 'profit_after_costs', 5000)`);
    machineId = await id(
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-001', 'BL-001', '2026-10-12') returning id`,
    );
    // Placeringen läggs in dagen automaten kopplas: den 12:e.
    await tx.execute(sql`insert into public.machine_placements
      (organization_id, machine_id, store_id, valid_from)
      values (${orgId}, ${machineId}, ${storeId}, '2026-10-12')`);
    const title = await id(
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Pack') returning id`,
    );
    await tx.execute(sql`insert into public.purchase_prices
      (organization_id, title_id, unit_cost_ore, valid_from) values (${orgId}, ${title}, 4000, '2026-01-01')`);
    const src = await id(
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${orgId}, 'awish_csv', 'CSV') returning id`,
    );
    for (const [n, day] of [
      [1, "2026-10-03"],
      [2, "2026-10-20"],
    ] as const) {
      await tx.execute(sql`insert into public.orders (organization_id, data_source_id, external_id,
          raw_title, title_id, ordered_at, amount_ore, machine_id, source_hash)
        values (${orgId}, ${src}, ${`r-${n}`}, 'Pack', ${title}, ${`${day}T10:00:00Z`}, 10000,
                ${machineId}, ${`rh-${n}-${orgId.slice(0, 8)}`})`);
    }
  });
  const user = { userId: u.id, email: u.email };
  const org = (await listOrganizationsFor(user)).find((o) => o.id === orgId)!;
  owner = { user, organization: org };
  session.current = owner;
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  session.current = null;
  view.andel = false;
});

describe("försäljning före automatens första placering räknas till butiken, överallt lika", () => {
  it("regeln: första placeringen gäller från automatens första försäljning", async () => {
    const [raw, effective] = await withUserDbFor(owner.user, (tx) =>
      Promise.all([queryPlacements(tx, orgId), queryEffectivePlacements(tx, orgId)]),
    );
    expect(raw.map((p) => p.from)).toEqual(["2026-10-12"]);
    expect(effective.map((p) => p.from)).toEqual(["2026-10-03"]);
  });

  it("panelen: Butiker (listan och butikens sida) och Lönsamhet", async () => {
    view.andel = true;
    const sp = { ...OCTOBER, andel: "1" };
    const list = await loadStoreList(sp);
    expect(list.rows.find((r) => r.id === storeId)!.toStoreOre).toBe(SHARE);
    const detail = (await loadStoreDetail(storeId, sp))!;
    expect(detail.kpis.find((k) => k.id === "compensation")!.value).toBe(SHARE);
    const p = await loadPeriod(sp);
    const input = await loadDomainInput({ period: p.period, ...p.scope });
    const ledger = buildLedger(input.current);
    expect(storeShareDeducted(ledger)).toBe(SHARE);
    view.andel = false;
  });

  it("avräkningen", async () => {
    const live = await withUserDbFor(owner.user, (tx) =>
      computeSettlementsTx(tx, {
        organizationId: orgId,
        month: "2026-10",
        storeIds: [storeId],
        now: NOW,
      }),
    );
    const s = live.get(storeId)!;
    expect(s.ok && s.computed.amountOre).toBe(SHARE);
    // Och butiken ska ha en avräkning för månaden.
    const page = await loadSettlementPageFor(owner, NOW);
    expect(page.missing.map((m) => m.storeId)).toEqual([storeId]);
  });

  it("butiksrapporten", async () => {
    const snapshot = await withUserDbFor(owner.user, async (tx) =>
      buildSnapshot(
        await loadSnapshotInput(tx, {
          organizationId: orgId,
          type: "butik",
          month: "2026-10",
          storeId,
          now: NOW.toISOString(),
        }),
      ),
    );
    if (snapshot.type !== "butik") throw new Error("fel rapporttyp");
    expect(snapshot.report.compensation.totalOre).toBe(SHARE);
    expect(snapshot.report.sales.orders).toBe(2);
  });

  it("bokföringen", async () => {
    const view2 = await loadBokforingFor(owner, "2026-11-03");
    const october = view2.months.find((m) => m.month === "2026-10")!;
    expect(october.book.storeShareOre).toBe(SHARE);
  });
});
