/**
 * Rutt (V2, byggplanen 3.2) mot testdatabasen: tjänsten bakom sidans actions
 * (src/app/(app)/rutt/_lib/service.ts) och dagens gräns i besöksplanen
 * (src/server/data/route-settings.ts).
 *
 * - Hoppa över / Till i morgon / Lägg till: ägare, admin och påfyllare; läsaren nekas. En ny
 *   ändring ersätter automatens gällande ändring i dag; Ångra med `restore` lägger tillbaka den.
 * - Dagens gräns: ägare och admin sparar, påfyllaren och läsaren nekas; ogiltiga värden nekas
 *   före databasen. Besöksplanen läser gränsen för alla roller (route_settings) och ruttens
 *   start (standardlagrets plats).
 * - Andra organisationers automater går inte att lägga i rutten.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asPostgres,
  asUser,
  createMember,
  rows,
  seedTenantFixture,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;
let other: TenantFixture;
let refiller: TestUser;
let viewer: TestUser;
let admin: TestUser;

beforeAll(async () => {
  F = await seedTenantFixture();
  other = await seedTenantFixture();
  refiller = await createMember(F.orgId, "refiller");
  viewer = await createMember(F.orgId, "viewer");
  admin = await createMember(F.orgId, "admin");
});

afterAll(async () => {
  // Gränsen tillbaka till standard (fixturen delas inte, men var snäll mot andra tester).
  await asPostgres((tx) =>
    tx.execute(
      sql`update public.organization_settings
          set route_max_stops = 6, route_max_packs = 350, route_weekdays = '{1,2,3,4,5}'
          where organization_id = ${F.orgId}::uuid`,
    ),
  );
});

const service = () => import("@/app/(app)/rutt/_lib/service");
const viewerOf = async (u: TestUser, org = F.orgId) =>
  (await import("./assistent-fixture")).viewerFor(u, org);

async function activeChanges(): Promise<{ change: string; created_by: string | null }[]> {
  return asPostgres((tx) =>
    rows(
      tx,
      sql`select change, created_by::text as created_by from public.route_day_changes
          where organization_id = ${F.orgId}::uuid and machine_id = ${F.machineId}::uuid
            and day = '2026-11-21' and undone_at is null`,
    ),
  );
}

describe("ändringar i dagens rutt (tjänsten)", () => {
  it("påfyllaren hoppar över; en ny ändring ersätter den; Ångra lägger tillbaka den förra", async () => {
    const { changeRouteFor, undoRouteChangeFor } = await service();
    const me = await viewerOf(refiller);
    const now = new Date("2026-11-21T09:00:00Z");

    const skip = await changeRouteFor(me, F.machineId, "skip", now);
    expect(skip).toMatchObject({ ok: true, data: { replaced: null } });
    expect(await activeChanges()).toEqual([{ change: "skip", created_by: refiller.id }]);

    const later = await changeRouteFor(me, F.machineId, "later", now);
    expect(later).toMatchObject({ ok: true, data: { replaced: "skip" } });
    expect((await activeChanges()).map((c) => c.change)).toEqual(["later"]);

    if (!later.ok || !later.data) throw new Error("ingen ändring");
    expect(await undoRouteChangeFor(me, later.data.id, later.data.replaced)).toEqual({ ok: true });
    expect((await activeChanges()).map((c) => c.change)).toEqual(["skip"]);

    // Ångra två gånger går inte.
    expect(await undoRouteChangeFor(me, later.data.id)).toMatchObject({ ok: false });

    // Städa: ångra hoppet.
    const [active] = await asPostgres((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id::text as id from public.route_day_changes
            where organization_id = ${F.orgId}::uuid and day = '2026-11-21'
              and undone_at is null`,
      ),
    );
    expect(await undoRouteChangeFor(me, active!.id)).toEqual({ ok: true });
    expect(await activeChanges()).toEqual([]);
  });

  it("läsaren kan inte ändra rutten, och en annan organisations automat finns inte", async () => {
    const { changeRouteFor, ROUTE_MESSAGES } = await service();
    expect(await changeRouteFor(await viewerOf(viewer), F.machineId, "skip")).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.forbidden,
    });
    expect(await changeRouteFor(await viewerOf(admin), other.machineId, "add")).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.invalid,
    });
    expect(await changeRouteFor(await viewerOf(admin), "inte-ett-id", "add")).toMatchObject({
      ok: false,
    });
    expect(await activeChanges()).toEqual([]);
  });
});

describe("dagens gräns (tjänsten och besöksplanen)", () => {
  it("ägaren sparar; påfyllaren och läsaren nekas; ogiltiga värden nekas", async () => {
    const { saveRouteLimitsFor, ROUTE_MESSAGES } = await service();
    const limits = { maxStops: 4, maxPacks: 200, weekdays: [6, 1, 2, 2] };
    expect(await saveRouteLimitsFor(await viewerOf(refiller), limits)).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.limitsForbidden,
    });
    expect(await saveRouteLimitsFor(await viewerOf(viewer), limits)).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.limitsForbidden,
    });
    expect(await saveRouteLimitsFor(await viewerOf(F.owner), { ...limits, maxStops: 0 })).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.stops,
    });
    expect(await saveRouteLimitsFor(await viewerOf(F.owner), { ...limits, weekdays: [] })).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.weekdays,
    });
    expect(await saveRouteLimitsFor(await viewerOf(F.owner), limits)).toEqual({ ok: true });

    // Besöksplanen läser gränsen som påfyllaren (route_settings), sorterade dagar.
    const { queryRoutePlanSettings } = await import("@/server/data/route-settings");
    const read = await asUser(refiller, (tx) => queryRoutePlanSettings(tx, F.orgId));
    expect(read.limits).toEqual({ maxStops: 4, maxPacks: 200, weekdays: [1, 2, 6] });
    expect(read.depot).toMatchObject({ id: F.centralLocationId, location: null });
  });

  it("ruttens start är standardlagrets plats när den finns", async () => {
    await asUser(F.owner, (tx) =>
      tx.execute(
        sql`update public.stock_locations set latitude = 57.7, longitude = 12.9
            where organization_id = ${F.orgId}::uuid and id = ${F.centralLocationId}::uuid`,
      ),
    );
    const { queryRoutePlanSettings } = await import("@/server/data/route-settings");
    const read = await asUser(viewer, (tx) => queryRoutePlanSettings(tx, F.orgId));
    expect(read.depot?.location).toEqual({ lat: 57.7, lng: 12.9 });
  });

  it("den som inte är med i organisationen får standarden, inte organisationens gräns", async () => {
    const { queryRoutePlanSettings, ROUTE_LIMIT_DEFAULTS } =
      await import("@/server/data/route-settings");
    const read = await asUser(other.owner, (tx) => queryRoutePlanSettings(tx, F.orgId));
    expect(read.limits).toEqual(ROUTE_LIMIT_DEFAULTS);
    expect(read.depot).toBeNull();
  });
});
