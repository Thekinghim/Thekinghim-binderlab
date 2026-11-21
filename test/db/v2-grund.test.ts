/**
 * V2-grunden mot testdatabasen (docs/design/v2/byggplan.md, avsnitt 3.2–3.4):
 *
 * - dagens gräns (route_max_stops/route_max_packs/route_weekdays): standard 6 stopp, 350 pack,
 *   mån–fre; alla roller läser via route_settings(), bara ägare och admin ändrar
 * - eget lagers adress och plats, partnerns lager (standard oförändrat: eget lager)
 * - route_day_changes: påfyllaren, admin och ägaren skriver, läsaren läser; en gällande
 *   ändring per automat och dag; en ändring kan bara ångras, en gång, och aldrig tas bort
 * - product_swaps: ingen användare skriver; alla medlemmar läser; andra organisationer ser inget
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  affected,
  asPostgres,
  asUser,
  attempt,
  createMember,
  createUser,
  one,
  rows,
  seedTenantFixture,
  uniqueSuffix,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;
let refiller: TestUser;
let viewer: TestUser;
let admin: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  F = await seedTenantFixture();
  refiller = await createMember(F.orgId, "refiller");
  viewer = await createMember(F.orgId, "viewer");
  admin = await createMember(F.orgId, "admin");
  stranger = await createUser(`stranger-${uniqueSuffix()}@test.binderlab.se`);
});

type Settings = { max_stops: number; max_packs: number; weekdays: number[] };

const settingsAs = (user: TestUser) =>
  asUser(user, (tx) =>
    attempt(tx, (sp) =>
      one<Settings>(sp, sql`select * from public.route_settings(${F.orgId}::uuid)`),
    ),
  );

describe("dagens gräns för rutten", () => {
  it("standard 6 stopp, 350 pack och mån–fre, läses av alla fyra roller", async () => {
    for (const person of [F.owner, admin, refiller, viewer]) {
      const r = await settingsAs(person);
      expect(r).toMatchObject({
        ok: true,
        value: { max_stops: 6, max_packs: 350, weekdays: [1, 2, 3, 4, 5] },
      });
    }
  });

  it("den som inte är med i organisationen får inget", async () => {
    expect(await settingsAs(stranger)).toMatchObject({ ok: false, code: "42501" });
  });

  it("ägare och admin ändrar gränsen, påfyllaren och läsaren kan inte", async () => {
    const set = (user: TestUser, stops: number) =>
      asUser(user, (tx) =>
        attempt(tx, (sp) =>
          affected(
            sp,
            sql`update public.organization_settings set route_max_stops = ${stops}
                where organization_id = ${F.orgId}::uuid`,
          ),
        ),
      );
    // Påfyllaren och läsaren: ingen rad (RLS) eller ingen rätt till kolumnen.
    for (const person of [refiller, viewer]) {
      const r = await set(person, 9);
      expect(r.ok === false || r.value === 0).toBe(true);
    }
    expect(await set(admin, 7)).toMatchObject({ ok: true, value: 1 });
    expect(await settingsAs(refiller)).toMatchObject({ ok: true, value: { max_stops: 7 } });
    // Utanför gränserna nekas av databasen.
    expect(await set(F.owner, 0)).toMatchObject({ ok: false, code: "23514" });
    expect(await set(F.owner, 31)).toMatchObject({ ok: false, code: "23514" });
    const days = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.organization_settings set route_weekdays = '{1,8}'
              where organization_id = ${F.orgId}::uuid`,
        ),
      ),
    );
    expect(days).toMatchObject({ ok: false, code: "23514" });
    expect(await set(F.owner, 6)).toMatchObject({ ok: true, value: 1 });
  });
});

describe("eget lagers plats och partnerns lager", () => {
  it("standardlagret är vårt eget och har ingen plats från början", async () => {
    const row = await asUser(refiller, (tx) =>
      one<{ held_by: string; partner_store_id: string | null; latitude: number | null }>(
        tx,
        sql`select held_by, partner_store_id, latitude from public.stock_locations
            where id = ${F.centralLocationId}::uuid`,
      ),
    );
    expect(row).toEqual({ held_by: "own", partner_store_id: null, latitude: null });
  });

  it("ägaren sätter adress och plats på lagret; båda koordinaterna eller ingen", async () => {
    const set = (latitude: number | null, longitude: number | null) =>
      asUser(F.owner, (tx) =>
        attempt(tx, (sp) =>
          affected(
            sp,
            sql`update public.stock_locations
                set address = 'Lagervägen 1', latitude = ${latitude}, longitude = ${longitude}
                where id = ${F.centralLocationId}::uuid`,
          ),
        ),
      );
    expect(await set(57.7, null)).toMatchObject({ ok: false, code: "23514" });
    expect(await set(57.7, 11.97)).toMatchObject({ ok: true, value: 1 });
  });

  it("en automats plats har ingen adress, och partnerns lager kräver en butik", async () => {
    const r1 = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set latitude = 1, longitude = 1
              where id = ${F.machineLocationId}::uuid`,
        ),
      ),
    );
    expect(r1).toMatchObject({ ok: false, code: "23514" });
    const r2 = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set held_by = 'partner'
              where id = ${F.centralLocationId}::uuid`,
        ),
      ),
    );
    expect(r2).toMatchObject({ ok: false, code: "23514" });
    const r3 = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stock_locations (organization_id, kind, name, held_by, partner_store_id)
              values (${F.orgId}::uuid, 'warehouse', 'Lager hos butiken', 'partner', ${F.storeId}::uuid)`,
        ),
      ),
    );
    expect(r3).toMatchObject({ ok: true });
  });

  it("påfyllaren kan inte ändra lagrets plats", async () => {
    const r = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        affected(
          sp,
          sql`update public.stock_locations set address = 'Annan väg 2'
              where id = ${F.centralLocationId}::uuid`,
        ),
      ),
    );
    expect(r.ok === false || r.value === 0).toBe(true);
  });
});

describe("ändringar i dagens rutt", () => {
  const add = (user: TestUser, day: string, change = "skip") =>
    asUser(user, (tx) =>
      attempt(tx, (sp) =>
        one<{ id: string; created_by: string }>(
          sp,
          sql`insert into public.route_day_changes (organization_id, day, machine_id, change)
              values (${F.orgId}::uuid, ${day}::date, ${F.machineId}::uuid, ${change})
              returning id::text as id, created_by::text as created_by`,
        ),
      ),
    );

  it("påfyllaren lägger till en ändring, i eget namn; läsaren kan inte", async () => {
    const r = await add(refiller, "2026-12-01", "later");
    expect(r).toMatchObject({ ok: true, value: { created_by: refiller.id } });
    expect(await add(viewer, "2026-12-02")).toMatchObject({ ok: false, code: "42501" });
    expect(await add(stranger, "2026-12-02")).toMatchObject({ ok: false, code: "42501" });
  });

  it("en gällande ändring per automat och dag; efter ångra går en ny", async () => {
    const first = await add(admin, "2026-12-03");
    expect(first.ok).toBe(true);
    expect(await add(F.owner, "2026-12-03", "add")).toMatchObject({ ok: false, code: "23505" });
    const id = first.ok ? first.value.id : "";
    const undo = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        one<{ undone_by: string }>(
          sp,
          sql`update public.route_day_changes set undone_at = now() where id = ${id}::uuid
              returning undone_by::text as undone_by`,
        ),
      ),
    );
    expect(undo).toMatchObject({ ok: true, value: { undone_by: refiller.id } });
    // En ångrad ändring kan inte ångras igen.
    const again = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.route_day_changes set undone_at = now() where id = ${id}::uuid`,
        ),
      ),
    );
    expect(again).toMatchObject({ ok: false, code: "22023" });
    expect(await add(F.owner, "2026-12-03", "add")).toMatchObject({ ok: true });
  });

  it("bara undone_at kan ändras, och ingen tar bort en ändring", async () => {
    const r = await add(F.owner, "2026-12-04");
    const id = r.ok ? r.value.id : "";
    for (const change of [
      sql`update public.route_day_changes set change = 'add' where id = ${id}::uuid`,
      sql`update public.route_day_changes set day = '2026-12-05' where id = ${id}::uuid`,
      sql`delete from public.route_day_changes where id = ${id}::uuid`,
    ]) {
      const out = await asUser(F.owner, (tx) => attempt(tx, (sp) => sp.execute(change)));
      expect(out.ok).toBe(false);
    }
  });

  it("alla fyra roller läser ändringarna, andra organisationer ser inga", async () => {
    const seen = async (person: TestUser) =>
      (
        await asUser(person, (tx) =>
          one<{ n: number }>(
            tx,
            sql`select count(*)::int as n from public.route_day_changes
                where organization_id = ${F.orgId}::uuid`,
          ),
        )
      ).n;
    const total = await seen(F.owner);
    expect(total).toBeGreaterThan(1);
    for (const person of [admin, refiller, viewer]) expect(await seen(person)).toBe(total);
    expect(await seen(stranger)).toBe(0);
  });
});

describe("produktbyten", () => {
  it("ingen användare skriver, ändrar eller tar bort ett byte", async () => {
    for (const person of [F.owner, admin, refiller, viewer]) {
      for (const change of [
        sql`insert into public.product_swaps
              (organization_id, machine_id, channel, from_title_id, to_title_id,
               returned_units, taken_units, occurred_at)
            values (${F.orgId}::uuid, ${F.machineId}::uuid, 'B1', ${F.titleId}::uuid,
                    ${F.secondTitleId}::uuid, 1, 1, now())`,
        sql`update public.product_swaps set taken_units = 0 where organization_id = ${F.orgId}::uuid`,
        sql`delete from public.product_swaps where organization_id = ${F.orgId}::uuid`,
      ]) {
        const out = await asUser(person, (tx) => attempt(tx, (sp) => sp.execute(change)));
        expect(out).toMatchObject({ ok: false, code: "42501" });
      }
    }
  });

  it("loggen är append-only även för databasägaren", async () => {
    const out = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.product_swaps set taken_units = 0 where organization_id = ${F.orgId}::uuid`,
        ),
      ),
    );
    expect(out.ok).toBe(false);
  });

  it("samma titel in och ut nekas, och samma fack och tid skrivs bara en gång", async () => {
    const insert = (to: string) =>
      asPostgres((tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.product_swaps
                  (organization_id, machine_id, channel, from_title_id, to_title_id,
                   returned_units, taken_units, occurred_at)
                values (${F.orgId}::uuid, ${F.machineId}::uuid, 'C1', ${F.titleId}::uuid,
                        ${to}::uuid, 1, 1, '2025-04-01T10:00:00Z')`,
          ),
        ),
      );
    expect(await insert(F.titleId)).toMatchObject({ ok: false, code: "23514" });
    expect(await insert(F.secondTitleId)).toMatchObject({ ok: true });
    expect(await insert(F.secondTitleId)).toMatchObject({ ok: false, code: "23505" });
  });

  it("alla fyra roller läser bytena, andra organisationer ser inga", async () => {
    const seen = async (person: TestUser) =>
      (
        await asUser(person, (tx) =>
          rows<{ id: string }>(
            tx,
            sql`select id::text as id from public.product_swaps
                where organization_id = ${F.orgId}::uuid`,
          ),
        )
      ).length;
    const total = await seen(F.owner);
    expect(total).toBeGreaterThan(0);
    for (const person of [admin, refiller, viewer]) expect(await seen(person)).toBe(total);
    expect(await seen(stranger)).toBe(0);
  });
});

describe("flottans läge (src/server/data/v2/fleet.ts)", () => {
  it("påfyllaren får automaterna med status men inga belopp; läsaren och ägaren får ekonomin", async () => {
    const { viewerFor } = await import("./assistent-fixture");
    const { loadFleetStateFor } = await import("@/server/data/v2/fleet");
    const now = new Date("2025-03-20T10:00:00Z");
    const economy = Promise.resolve({
      rows: new Map([
        [F.machineId, { profitPerDayOre: 1_000, vsMedianOre: null, verdict: "alone" }],
      ]),
      medianProfitPerDayOre: null,
    });
    const asRefiller = await loadFleetStateFor(await viewerFor(refiller, F.orgId), now, {
      economy,
    });
    expect(asRefiller.machines.map((m) => m.id)).toContain(F.machineId);
    expect(asRefiller.economy).toBe(false);
    expect(JSON.stringify(asRefiller)).not.toMatch(/Ore"/);
    const asOwner = await loadFleetStateFor(await viewerFor(F.owner, F.orgId), now, { economy });
    expect(asOwner.economy).toBe(true);
    expect(asOwner.machines.find((m) => m.id === F.machineId)?.economy?.profitPerDayOre).toBe(
      1_000,
    );
    // Någon utanför organisationen (med organisationens uppgifter i en förfalskad viewer) nekas.
    const forged = {
      user: { userId: stranger.id, email: stranger.email },
      organization: (await viewerFor(refiller, F.orgId)).organization,
    };
    await expect(loadFleetStateFor(forged, now)).rejects.toThrow();
  });
});
