/**
 * Hem i V2 (G1) mot testdatabasen:
 *
 * - "Lägg i rutten" (Rutts tjänst, rutt/_lib/service.ts): påfyllaren lägger en automat i dagens
 *   rutt; läsaren och den utanför organisationen nekas; Ångra sätter undone_at och då går det
 *   att lägga till igen
 * - Kräver åtgärd för påfyllaren: flottans läge utan ekonomi ger raderna utan ett enda belopp
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { hemActions } from "@/analytics/home-v2";

import { viewerFor } from "./assistent-fixture";
import {
  asPostgres,
  createMember,
  createUser,
  rows,
  seedTenantFixture,
  uniqueSuffix,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;
let refiller: TestUser;
let viewer: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  F = await seedTenantFixture();
  refiller = await createMember(F.orgId, "refiller");
  viewer = await createMember(F.orgId, "viewer");
  stranger = await createUser(`stranger-${uniqueSuffix()}@test.binderlab.se`);
});

describe("Lägg i rutten från Hem (Rutts tjänst)", () => {
  const now = new Date("2025-03-20T10:00:00Z");
  const service = () => import("@/app/(app)/rutt/_lib/service");

  it("påfyllaren lägger till och ångrar; samma automat igen ersätter ändringen", async () => {
    const { changeRouteFor, undoRouteChangeFor } = await service();
    const v = await viewerFor(refiller, F.orgId);
    const first = await changeRouteFor(v, F.machineId, "add", now);
    expect(first.ok).toBe(true);
    const id = first.ok ? first.data!.id : "";
    const saved = await asPostgres((tx) =>
      rows<{ day: string; change: string; created_by: string }>(
        tx,
        sql`select day::text as day, change, created_by::text as created_by
            from public.route_day_changes where id = ${id}::uuid`,
      ),
    );
    expect(saved).toEqual([{ day: "2025-03-20", change: "add", created_by: refiller.id }]);
    expect(await undoRouteChangeFor(v, id)).toEqual({ ok: true });
    // Redan ångrad: går inte igen.
    expect((await undoRouteChangeFor(v, id)).ok).toBe(false);
    expect((await changeRouteFor(v, F.machineId, "add", now)).ok).toBe(true);
  });

  it("läsaren och den utanför organisationen nekas; okänt id ger fel", async () => {
    const { changeRouteFor, ROUTE_MESSAGES } = await service();
    const asViewer = await viewerFor(viewer, F.orgId);
    expect(await changeRouteFor(asViewer, F.machineId, "add", now)).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.forbidden,
    });
    const forged = {
      user: { userId: stranger.id, email: stranger.email },
      organization: asViewer.organization,
    };
    expect((await changeRouteFor(forged as never, F.machineId, "add", now)).ok).toBe(false);
    const owner = await viewerFor(F.owner, F.orgId);
    expect(await changeRouteFor(owner, "inte-ett-id", "add", now)).toEqual({
      ok: false,
      error: ROUTE_MESSAGES.invalid,
    });
    expect(await changeRouteFor(owner, "00000000-0000-4000-8000-000000000000", "add", now)).toEqual(
      {
        ok: false,
        error: ROUTE_MESSAGES.invalid,
      },
    );
  });
});

describe("Kräver åtgärd för påfyllaren", () => {
  it("raderna byggs ur flottans läge utan ekonomi och innehåller inga belopp", async () => {
    const { loadFleetStateFor } = await import("@/server/data/v2/fleet");
    const now = new Date("2025-03-20T10:00:00Z");
    const fleet = await loadFleetStateFor(await viewerFor(refiller, F.orgId), now, {
      economy: Promise.resolve({ rows: new Map(), medianProfitPerDayOre: 50_000 }),
    });
    const r = hemActions({ machines: fleet.machines, prices: [], economy: false });
    expect(fleet.machines.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/Ore"/);
    expect(r.counts.badPricing).toBe(0);
  });
});
