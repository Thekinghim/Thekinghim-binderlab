/**
 * Mystery packs, granskning (20261115000000_mystery_packs.sql): det som en oberoende
 * granskning kontrollerar utöver mystery-packs.test.ts:
 *
 * - samtidighet: två telefoner som packar samtidigt (olika id) kan inte ta ut mer än som
 *   finns; samma id samtidigt två gånger ger en packning,
 * - saldot med inventeringar: packning efter en inventering räknas på den; ångra nekas om
 *   lagret har räknats efter packningen (annars räknas delarna två gånger),
 * - automatens saldo rörs aldrig (en automat är inget lager för packning),
 * - organisationer: en annan organisation når varken packning, titel, lager eller ångra,
 * - en packnings grupp kan bara ha händelser i packningens lager.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  MysteryError,
  packFor,
  saveRecipeFor,
  undoPackFor,
} from "../../src/app/(app)/vart-lager/mystery/_lib/service";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  settle,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  );

describe("Mystery packs: granskning", () => {
  let owner: TestUser;
  let refiller: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let otherOrg: string;
  let hemma: string;
  let otherHemma: string;
  let machineLoc: string;
  let mp: string;
  let pf: string;
  let dr: string;
  let otherTitle: string;
  let recipe: string;

  const level = async (location: string, title: string) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${title}::uuid`,
      )
    )[0]?.q ?? 0;
  const levels = async (location: string) => ({
    mp: await level(location, mp),
    pf: await level(location, pf),
    dr: await level(location, dr),
  });
  const receive = (location: string, title: string, quantity: number) =>
    asUser(owner, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: orgId,
        locationId: location,
        titleId: title,
        kind: "receipt",
        quantity,
      }),
    );
  const count = (location: string, title: string, quantity: number) =>
    asUser(owner, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: orgId,
        locationId: location,
        titleId: title,
        kind: "count",
        quantity,
      }),
    );
  const pack = async (u: TestUser, batches = 1, clientId = randomUUID()) =>
    packFor(await viewerFor(u, orgId), {
      titleId: mp,
      placeId: hemma,
      batches,
      recipeId: recipe,
      clientId,
    });

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    refiller = await createMember(orgId, "refiller");
    outsider = await createUser();
    otherOrg = await createOrg(outsider, "Annan organisation");

    await asUser(owner, async (tx) => {
      const titles = await tx
        .insert(s.titles)
        .values([
          { organizationId: orgId, name: "Mystery Pack Plus", ownProduct: true },
          { organizationId: orgId, name: "Phantasmal Flames" },
          { organizationId: orgId, name: "Delta Reign" },
        ])
        .returning();
      [mp, pf, dr] = [titles[0]!.id, titles[1]!.id, titles[2]!.id];
      const [central] = await tx
        .select()
        .from(s.stockLocations)
        .where(
          sql`${s.stockLocations.organizationId} = ${orgId} and ${s.stockLocations.isCentral}`,
        );
      hemma = central!.id;
      const [m] = await tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-001",
          name: "Automat 1",
          activeFrom: "2026-10-01",
        })
        .returning();
      machineLoc = (
        await one<{ id: string }>(
          tx,
          sql`select id::text from public.stock_locations
              where organization_id = ${orgId}::uuid and machine_id = ${m!.id}::uuid`,
        )
      ).id;
    });
    await asUser(outsider, async (tx) => {
      const [title] = await tx
        .insert(s.titles)
        .values({ organizationId: otherOrg, name: "Annans pack", ownProduct: true })
        .returning();
      otherTitle = title!.id;
      const [central] = await tx
        .select()
        .from(s.stockLocations)
        .where(
          sql`${s.stockLocations.organizationId} = ${otherOrg} and ${s.stockLocations.isCentral}`,
        );
      otherHemma = central!.id;
    });
    // En omgång = 2 Phantasmal Flames + 1 Delta Reign.
    recipe = (
      await saveRecipeFor(await viewerFor(owner, orgId), {
        titleId: mp,
        batchSize: 3,
        items: [
          { titleId: pf, quantity: 2, hit: false },
          { titleId: dr, quantity: 1, hit: true },
        ],
      })
    ).recipeId;
    await receive(machineLoc, pf, 5);
  });

  it("två telefoner packar samtidigt: bara en får delarna, saldot går aldrig under noll", async () => {
    await receive(hemma, pf, 2);
    await receive(hemma, dr, 1);
    // En tredje anslutning håller samma lås som packningen, så att båda väntar och sedan
    // tävlar om samma delar.
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const blocker = db().transaction(async (tx) => {
      await tx.execute(sql`select private.lock_own_stock(${orgId}::uuid, ${pf}::uuid)`);
      locked();
      await gate;
    });
    await isLocked;
    const a = errorOf(pack(owner));
    const b = errorOf(pack(refiller));
    await new Promise((r) => setTimeout(r, 400));
    release();
    await blocker;
    const results = await Promise.all([a, b]);
    const failed = results.filter((e) => e !== null);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(MysteryError);
    expect(failed[0]!.message).toMatch(/^Hemma saknar 2 Phantasmal Flames, 1 Delta Reign\.$/);
    expect(await levels(hemma)).toEqual({ mp: 3, pf: 0, dr: 0 });
    // Automatens saldo rörs inte.
    expect(await level(machineLoc, pf)).toBe(5);
  });

  it("samma id samtidigt två gånger: en packning, delarna tas ut en gång", async () => {
    await receive(hemma, pf, 4);
    await receive(hemma, dr, 2);
    const before = await levels(hemma);
    const id = randomUUID();
    const [a, b] = await Promise.all([pack(owner, 1, id), pack(owner, 1, id)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.packingId).toBe(b.packingId);
    expect(await levels(hemma)).toEqual({
      mp: before.mp + 3,
      pf: before.pf - 2,
      dr: before.dr - 1,
    });
  });

  it("packning efter en inventering räknas på inventeringen; ingen dubbelräkning", async () => {
    await count(hemma, pf, 10);
    await count(hemma, dr, 5);
    await count(hemma, mp, 7);
    await pack(owner, 2);
    expect(await levels(hemma)).toEqual({ mp: 13, pf: 6, dr: 3 });
  });

  it("ångra nekas när lagret har räknats efter packningen", async () => {
    const res = await pack(owner, 1);
    expect(await levels(hemma)).toEqual({ mp: 16, pf: 4, dr: 2 });
    // Ägaren räknar Hemma (det som faktiskt finns): en ångring skulle nu lägga tillbaka
    // delarna ovanpå det räknade antalet.
    await count(hemma, pf, 4);
    const error = await errorOf(
      undoPackFor(await viewerFor(owner, orgId), { packingId: res.packingId }),
    );
    expect(error).toBeInstanceOf(MysteryError);
    expect(error!.message).toMatch(/räknats efter packningen/);
    expect(await levels(hemma)).toEqual({ mp: 16, pf: 4, dr: 2 });
  });

  it("en inventering i ett annat lager hindrar inte ångra", async () => {
    const res = await pack(owner, 1);
    await count(machineLoc, pf, 5);
    await undoPackFor(await viewerFor(owner, orgId), { packingId: res.packingId });
    expect(await levels(hemma)).toEqual({ mp: 16, pf: 4, dr: 2 });
  });

  it("en automat är inget lager att packa i", async () => {
    const error = await errorOf(
      packFor(await viewerFor(owner, orgId), {
        titleId: mp,
        placeId: machineLoc,
        batches: 1,
        recipeId: recipe,
        clientId: randomUUID(),
      }),
    );
    expect(error!.message).toBe("Lagret finns inte.");
    expect(await level(machineLoc, pf)).toBe(5);
  });

  it("en annan organisation når ingenting", async () => {
    // Utomstående med den här organisationens id.
    const asOutsider = (q: ReturnType<typeof sql>) =>
      asUser(outsider, (tx) => attempt(tx, (sp) => sp.execute(q)));
    expect(
      (
        await asOutsider(
          sql`select * from public.pack_mystery(${orgId}::uuid, gen_random_uuid(), ${mp}::uuid,
                ${hemma}::uuid, 1, null)`,
        )
      ).code,
    ).toBe("42501");
    // Sin egen organisation, men den här organisationens titel eller lager.
    const own = await asOutsider(
      sql`select * from public.pack_mystery(${otherOrg}::uuid, gen_random_uuid(), ${mp}::uuid,
            ${otherHemma}::uuid, 1, null)`,
    );
    expect(own.message).toBe("Titeln finns inte i organisationen.");
    const recipeOther = await asOutsider(
      sql`select public.save_mystery_recipe(${otherOrg}::uuid, ${otherTitle}::uuid, 2,
            ${JSON.stringify([{ titleId: pf, quantity: 2 }])}::jsonb)`,
    );
    expect(recipeOther.message).toBe("En av titlarna finns inte längre.");
    const packing = await one<{ id: string }>(
      db(),
      sql`select id::text from public.mystery_packings where organization_id = ${orgId}::uuid
          and undone_at is null order by packed_at desc limit 1`,
    );
    const undo = await asOutsider(
      sql`select public.undo_mystery_packing(${otherOrg}::uuid, ${packing.id}::uuid)`,
    );
    expect(undo.message).toBe("Packningen finns inte.");
    // Ägaren kan inte packa i en annan organisations lager.
    const foreignPlace = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select * from public.pack_mystery(${orgId}::uuid, gen_random_uuid(), ${mp}::uuid,
                ${otherHemma}::uuid, 1, null)`,
        ),
      ),
    );
    expect(foreignPlace.message).toBe("Lagret finns inte.");
    // Inga rader syns för den utomstående.
    const seen = await asUser(outsider, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select (select count(*) from public.mystery_packings)
                 + (select count(*) from public.mystery_recipes)
                 + (select count(*) from public.mystery_recipe_items) as n`,
      ),
    );
    expect(Number(seen[0]!.n)).toBe(0);
  });

  it("en packnings grupp kan inte få händelser i ett annat lager (t.ex. en automat)", async () => {
    const res = await pack(owner, 1);
    const group = (
      await one<{ g: string }>(
        db(),
        sql`select transfer_group_id::text as g from public.mystery_packings where id = ${res.packingId}::uuid`,
      )
    ).g;
    const outcome = await settle(
      asUser(owner, (tx) =>
        tx.insert(s.stockEvents).values([
          {
            organizationId: orgId,
            locationId: machineLoc,
            titleId: pf,
            kind: "adjustment",
            quantity: 3,
            transferGroupId: group,
          },
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: pf,
            kind: "adjustment",
            quantity: -3,
            transferGroupId: group,
          },
        ]),
      ),
    );
    expect(outcome.code).toBe("BL017");
    expect(await level(machineLoc, pf)).toBe(5);
  });
});
