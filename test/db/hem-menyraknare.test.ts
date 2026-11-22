/**
 * Menyns räknare vid Hem och Rutt (layouten, src/app/(app)/_hem/v2/menu-counts.ts) mot
 * testdatabasen: den lätta vägen ger SAMMA tal som hela Hem (loadHemCount: Kräver åtgärd +
 * Att göra) och hela Rutt (loadDayRoute: stopp som inte är klara), på demon för ägaren och
 * påfyllaren.
 *
 * Den lätta vägen hoppar över flottans ekonomi, Att göras ordning och prisrådens försäljning
 * (det ändrar bara ordningen och beloppen); testet fångar om något av det ändå skulle ändra
 * antalet. Klockan står på demons "nu" (2 nov. 2026 kl. 12 svensk tid), så att det finns
 * automater att fylla, prisråd och punkter i Att göra.
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

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
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

// Importeras efter mockarna (vi.mock hissas, så ordningen här är bara för läsbarheten).
import { loadHemMenuCount, loadRouteMenuCount } from "@/app/(app)/_hem/v2/menu-counts";
import { loadHemCount, loadHemToday } from "@/app/(app)/_hem/v2/today-data";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor } from "@/server/access";
import { loadDayRoute } from "@/server/data/v2/route";
import { DEMO_USERS } from "@/seed/demo/catalog";
import { resetDemo, runDemoSeed } from "@/seed/demo/run-demo-seed";

import { db, one, rows } from "./helpers";

const NOW = new Date("2026-11-02T11:00:00Z");
let orgId: string;

async function login(email: string): Promise<void> {
  const { id } = await one<{ id: string }>(
    db(),
    sql`select id::text as id from auth.users where email = ${email}`,
  );
  const user = { userId: id, email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error(`${email} är inte med i demon`);
  session.current = { user, organization };
}

beforeAll(async () => {
  const fileStore = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-menyraknare-")));
  const seeded = await runDemoSeed(db(), {
    password: "binderlab-menyraknare",
    manageUsers: true,
    fileStore,
  });
  orgId = seeded.organizationId;
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}, 300_000);

// Demon raderas efteråt, så att slug nordljus-demo är ledig för de andra demotesterna.
afterAll(async () => {
  vi.useRealTimers();
  session.current = null;
  await resetDemo(db(), "nordljus-demo");
}, 120_000);

describe("menyns räknare = hela Hem och Rutt (demon)", () => {
  it.each([
    ["ägaren", DEMO_USERS.owner.email],
    ["påfyllaren", DEMO_USERS.refiller.email],
  ])("%s: samma tal vid Hem och Rutt", async (_who, email) => {
    await login(email);
    const [hem, route, fullHem, fullRoute, today] = await Promise.all([
      loadHemMenuCount(),
      loadRouteMenuCount(),
      loadHemCount(),
      loadDayRoute(),
      loadHemToday(),
    ]);
    expect(hem).toBe(fullHem);
    expect(route).toBe(fullRoute.stops.filter((s) => !s.done).length);
    // Talen ska betyda något: demon har rader i Kräver åtgärd och stopp i dagens rutt.
    expect(today.actions.total).toBeGreaterThan(0);
    expect(hem).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(0);
  });

  it("ägarens räknare tar med prisråden med förlust, påfyllarens aldrig", async () => {
    await login(DEMO_USERS.owner.email);
    const owner = await loadHemToday();
    await login(DEMO_USERS.refiller.email);
    const refiller = await loadHemToday();
    expect(refiller.actions.counts.badPricing).toBe(0);
    expect(refiller.economy).toBe(false);
    expect(owner.economy).toBe(true);
  });

  it("senast fylld per automat (indexfrågan i flottans läge) = svepet över alla händelser", async () => {
    await login(DEMO_USERS.owner.email);
    const { loadFleetStatus } = await import("@/server/data/v2/fleet");
    const fleet = await loadFleetStatus();
    const sweep = await rows<{ machine_id: string; at: Date }>(
      db(),
      sql`select l.machine_id::text as machine_id, max(e.occurred_at) as at
          from public.stock_events e
          join public.stock_locations l
            on l.organization_id = e.organization_id and l.id = e.location_id
          where e.organization_id = ${orgId}::uuid and l.kind = 'machine'
            and e.kind in ('refill', 'transfer_in')
          group by l.machine_id`,
    );
    const expected = new Map(sweep.map((r) => [r.machine_id, new Date(r.at).toISOString()]));
    expect(expected.size).toBeGreaterThan(0);
    for (const m of fleet.machines) expect(m.lastRefillAt, m.code).toBe(expected.get(m.id) ?? null);
  });
});
