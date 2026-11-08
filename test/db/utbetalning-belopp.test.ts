/**
 * "Till butiken" på Butiker-listan = butikens sida = avräkningen för en hel
 * månad, i de svåra fallen (testdatabasen, egen fixtur, oktober 2026):
 *
 *   Bytet     50 % av vinsten 1–14 okt., sedan 10 % av försäljningen + hyra 500 kr/mån,
 *             med en återbetalning
 *   Hyran     bara hyra 1 000 kr/mån; automaten flyttas dit 11 okt. (hyra för 21 dagar)
 *   Provision 20 % av försäljningen; automaten stod där 1–10 okt., en order utan inköpspris
 *   Utan pris 30 % av vinsten och en order utan inköpspris: avräkningen spärras (notis i listan)
 *   Luckan    10 % av försäljningen utom 10–19 okt. (inget avtal): 0 % de dagarna
 *   Tom       ingen automat och inget avtal: ingen varning
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
import { listOrganizationsFor, withUserDbFor } from "@/server/access";
import { computeSettlementsTx } from "@/server/settlements/live";
import { loadSettlementPageFor } from "@/server/settlements/service";

import { asPostgres, createOrg, createUser, one } from "./helpers";

const NOW = new Date("2026-11-03T10:00:00Z");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" } as const;

let orgId: string;
let owner: { user: SessionUser; organization: OrganizationMembership };
const ids = new Map<string, string>();
let unpricedTitle: string;

beforeAll(async () => {
  const u = await createUser();
  orgId = await createOrg(u, "Granskning belopp");
  await asPostgres(async (tx) => {
    const id = async (q: ReturnType<typeof sql>) => (await one<{ id: string }>(tx, q)).id;
    for (const name of ["Bytet", "Hyran", "Provision", "Utan pris", "Luckan", "Tom"]) {
      ids.set(
        name,
        await id(
          sql`insert into public.stores (organization_id, name) values (${orgId}, ${name}) returning id`,
        ),
      );
    }
    const st = (n: string) => ids.get(n)!;
    const agr = (
      store: string,
      from: string,
      to: string | null,
      base: string,
      bp: number | null,
      rent: number | null,
    ) =>
      tx.execute(sql`insert into public.store_agreements (organization_id, store_id, valid_from, valid_to, commission_base, commission_bp, monthly_rent_ore)
        values (${orgId}, ${st(store)}, ${from}, ${to}, ${base}, ${bp}, ${rent})`);
    await agr("Bytet", "2026-01-01", "2026-10-14", "profit_after_costs", 5000, null);
    await agr("Bytet", "2026-10-15", null, "net_excl_vat", 1000, 50000);
    await agr("Hyran", "2026-01-01", null, "net_excl_vat", null, 100000);
    await agr("Provision", "2026-01-01", null, "net_excl_vat", 2000, null);
    await agr("Utan pris", "2026-01-01", null, "profit_after_costs", 3000, null);
    await agr("Luckan", "2026-01-01", "2026-10-09", "net_excl_vat", 1000, null);
    await agr("Luckan", "2026-10-20", null, "net_excl_vat", 1000, null);
    const m = new Map<string, string>();
    for (const code of ["BL-001", "BL-002", "BL-003", "BL-004"]) {
      m.set(
        code,
        await id(
          sql`insert into public.machines (organization_id, code, name, active_from) values (${orgId}, ${code}, ${code}, '2026-01-01') returning id`,
        ),
      );
    }
    const place = (code: string, store: string, from: string, to: string | null) =>
      tx.execute(sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from, valid_to)
        values (${orgId}, ${m.get(code)!}, ${st(store)}, ${from}, ${to})`);
    await place("BL-001", "Bytet", "2026-01-01", null);
    await place("BL-002", "Provision", "2026-01-01", "2026-10-10");
    await place("BL-002", "Hyran", "2026-10-11", null);
    await place("BL-003", "Utan pris", "2026-01-01", null);
    await place("BL-004", "Luckan", "2026-01-01", null);
    const priced = await id(
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Med pris') returning id`,
    );
    const unpriced = await id(
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Utan pris') returning id`,
    );
    unpricedTitle = unpriced;
    await tx.execute(
      sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from) values (${orgId}, ${priced}, 4000, '2026-01-01')`,
    );
    const src = await id(
      sql`insert into public.data_sources (organization_id, provider, name) values (${orgId}, 'awish_csv', 'CSV') returning id`,
    );
    let n = 0;
    const order = async (code: string, title: string, day: string, ore: number) => {
      n += 1;
      await tx.execute(sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id, ordered_at, amount_ore, machine_id, source_hash)
        values (${orgId}, ${src}, ${`g-${n}`}, 'x', ${title}, ${`${day}T10:00:00Z`}, ${ore}, ${m.get(code)!}, ${`gh-${n}`})`);
    };
    await order("BL-001", priced, "2026-10-05", 10000);
    await order("BL-001", priced, "2026-10-20", 12000);
    await order("BL-002", priced, "2026-10-03", 9000);
    await order("BL-002", unpriced, "2026-10-04", 5000);
    await order("BL-002", priced, "2026-10-25", 8000);
    await order("BL-003", priced, "2026-10-08", 11000);
    await order("BL-003", unpriced, "2026-10-09", 6000);
    await order("BL-004", priced, "2026-10-05", 7000);
    await order("BL-004", priced, "2026-10-15", 7000);
    await order("BL-004", priced, "2026-10-25", 7000);
    await tx.execute(sql`insert into public.incidents (organization_id, machine_id, kind, started_at, description, refunded_ore, refunded_on)
      values (${orgId}, ${m.get("BL-001")!}, 'customer', '2026-10-06T12:00:00Z', 'Återbetalt', 2000, '2026-10-06')`);
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

describe("Till butiken = butikens sida = avräkningen (oktober)", () => {
  it("varje butik, vyknappen av och på", async () => {
    const all = [...ids.values()];
    const live = await withUserDbFor(owner.user, (tx) =>
      computeSettlementsTx(tx, {
        organizationId: orgId,
        month: "2026-10",
        storeIds: all,
        now: NOW,
      }),
    );
    const amount = (name: string) => {
      const s = live.get(ids.get(name)!);
      return s && s.ok ? s.computed.amountOre : null;
    };
    // Facit för hand: Bytet 50 % × (6 000 − 2 000 återbetalt) + 10 % × 12 000 + 500 kr × 17/31.
    expect(amount("Bytet")).toBe(2_000 + 1_200 + Math.round((50_000 * 17) / 31));
    // Hyran räknas på avtalets dagar (hela månaden), inte automatens.
    expect(amount("Hyran")).toBe(100_000);
    // Provision 20 % av 9 000 + 5 000 (också ordern utan inköpspris).
    expect(amount("Provision")).toBe(2_800);
    // Luckan: 10 % av 7 000 den 5:e och 25:e, 0 % den 15:e (inget avtal).
    expect(amount("Luckan")).toBe(1_400);
    expect(amount("Tom")).toBe(0);
    // Vinstdelning med en order utan inköpspris: avräkningen spärras.
    expect(live.get(ids.get("Utan pris")!)?.ok).toBe(false);

    for (const on of [false, true]) {
      view.andel = on;
      const sp = on ? { ...OCTOBER, andel: "1" } : OCTOBER;
      const list = await loadStoreList(sp);
      for (const [name, id] of ids) {
        const row = list.rows.find((r) => r.id === id)!;
        const detail = (await loadStoreDetail(id, sp))!;
        const kpi = detail.kpis.find((k) => k.id === "compensation")!.value;
        const facit = amount(name);
        if (facit !== null) expect(row.toStoreOre, `${name} lista`).toBe(facit);
        // Butikens sida visar det vi betalar, samma som listan: också provisionen på
        // ordern utan inköpspris (Provision 2 800 öre, inte 1 800).
        expect(kpi, `${name} sida`).toBe(row.toStoreOre);
        // Sålda utan inköpspris: Till butiken + Vår del går inte ihop, så en notis.
        const unpriced = name === "Provision" || name === "Utan pris";
        expect(detail.unpricedNote, `${name} notis`).toBe(
          unpriced ? "1\u00a0såld saknar inköpspris – vinsten är inte helt rätt." : null,
        );
        // Vinstdelning med order utan pris: avräkningen spärras, notisen under beloppet
        // länkar dit inköpspriset läggs in (samma som Att göra).
        expect(row.blocked, `${name} spärrad`).toEqual(
          name === "Utan pris"
            ? {
                text: "Kan inte räknas klart – lägg in inköpspris",
                href: `/inkopspriser?titel=${unpricedTitle}`,
              }
            : null,
        );
        // Varningen: bara Luckan (10 dagar); butiker utan automat larmar aldrig.
        expect(row.agreementGap?.days ?? 0, `${name} lucka`).toBe(name === "Luckan" ? 10 : 0);
        expect(detail.agreementGap?.days ?? 0).toBe(name === "Luckan" ? 10 : 0);
      }
    }
    view.andel = false;
    const page = await loadSettlementPageFor(owner, NOW);
    expect(page.noAgreement.map((g) => [g.storeName, g.days, g.whole])).toEqual([
      ["Luckan", 10, false],
    ]);
    expect(page.failed.map((f) => f.storeName)).toEqual(["Utan pris"]);
  });
});
