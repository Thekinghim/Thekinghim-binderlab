/**
 * Runda 2, T1-4: påfyllaren kan ångra sin egen packning efter att sidan laddats om.
 * Mot testdatabasen, som påfyllaren (RLS):
 *
 * - public.my_recent_mystery_packings ger den egna packningen från 5 minuter sedan, utan
 *   kostnad per pack; någon annans packning och en 40 minuter gammal ges inte,
 * - sidans laddare (loadMysteryDetailFor) visar raden med Ångra för påfyllaren, utan belopp,
 * - Ångra fungerar och delarna är tillbaka,
 * - läsaren (som inte packar) nekas av funktionen; ägaren ser som förut alla packningar med
 *   kostnad, och en gammal packning är märkt "för sent".
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
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

const { loadMysteryDetailFor } = await import("../../src/app/(app)/vart-lager/mystery/_lib/data");
const { packFor, undoPackFor } =
  await import("../../src/app/(app)/vart-lager/mystery/_lib/service");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let owner: TestUser;
let refiller: TestUser;
let other: TestUser; // en annan påfyllare
let reader: TestUser;
let orgId: string;
let centralId: string;
let mp: string;
let part: string;
let recipeId: string;
let mine: string; // påfyllarens packning (5 minuter sedan)
let old: string; // påfyllarens packning (40 minuter sedan)
let theirs: string; // den andra påfyllarens packning (nyss)

async function pack(u: TestUser): Promise<string> {
  const out = await packFor(await viewerFor(u, orgId), {
    titleId: mp,
    placeId: centralId,
    batches: 1,
    recipeId,
    clientId: randomUUID(),
  });
  return out.packingId;
}

/** Flyttar en packning bakåt i tiden (som postgres: kolumnen går inte att ändra annars). */
async function age(packingId: string, minutes: number) {
  await asPostgres(async (tx) => {
    await tx.execute(sql`alter table public.mystery_packings disable trigger user`);
    await tx.execute(
      sql`update public.mystery_packings set packed_at = now() - make_interval(mins => ${minutes})
          where id = ${packingId}::uuid`,
    );
    await tx.execute(sql`alter table public.mystery_packings enable trigger user`);
  });
}

const level = async (titleId: string) =>
  Number(
    (
      await one<{ q: number }>(
        db(),
        sql`select coalesce((select quantity from public.stock_levels
              where organization_id = ${orgId}::uuid and location_id = ${centralId}::uuid
                and title_id = ${titleId}::uuid), 0)::int as q`,
      )
    ).q,
  );

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  other = await createMember(orgId, "refiller");
  reader = await createMember(orgId, "viewer");
  centralId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where organization_id = ${orgId}::uuid and is_central`,
    )
  ).id;
  await asUser(owner, async (tx) => {
    const titles = await tx
      .insert(s.titles)
      .values([
        { organizationId: orgId, name: "Mystery Pack", ownProduct: true },
        { organizationId: orgId, name: "Phantasmal Flames" },
      ])
      .returning();
    [mp, part] = titles.map((t) => t.id) as [string, string];
    const saved = await tx.execute(
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14,
            ${JSON.stringify([{ titleId: part, quantity: 14, hit: false }])}::jsonb)::text as id`,
    );
    recipeId = (Array.from(saved)[0] as { id: string }).id;
    // Inköpspris på delen, så att packningen får en kostnad per pack (som ägaren ser).
    await tx.insert(s.purchasePrices).values({
      organizationId: orgId,
      titleId: part,
      unitCostOre: 5000,
      validFrom: "2026-01-01",
    });
  });
  await asPostgres((tx) =>
    tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
      values (${orgId}::uuid, ${centralId}::uuid, ${part}::uuid, 'count', 100, 'test')`),
  );
  old = await pack(refiller);
  await age(old, 40);
  mine = await pack(refiller);
  await age(mine, 5);
  theirs = await pack(other);
});

describe("public.my_recent_mystery_packings", () => {
  it("påfyllaren får sin egen packning från 5 minuter sedan, utan kostnad", async () => {
    const list = await asUser(refiller, (tx) =>
      rows(tx, sql`select * from public.my_recent_mystery_packings(${orgId}::uuid, ${mp}::uuid)`),
    );
    expect(list.map((r) => r.id)).toEqual([mine]);
    expect(Object.keys(list[0]!).sort()).toEqual(
      [
        "batches",
        "id",
        "location_name",
        "packed_at",
        "packs",
        "recipe_version",
        "undone_at",
      ].sort(),
    );
    expect(JSON.stringify(list)).not.toMatch(/cost|ore/i);
    expect(list[0]).toMatchObject({ batches: 1, packs: 14, undone_at: null });
  });

  it("någon annans packning och den 40 minuter gamla ges inte", async () => {
    const list = await asUser(refiller, (tx) =>
      rows(tx, sql`select id from public.my_recent_mystery_packings(${orgId}::uuid, ${mp}::uuid)`),
    );
    const ids = list.map((r) => r.id);
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(old);
  });

  it("påfyllaren kan fortfarande inte läsa tabellen (kostnaden stannar hos ägaren)", async () => {
    const n = await asUser(refiller, (tx) =>
      one<{ n: number }>(tx, sql`select count(*)::int as n from public.mystery_packings`),
    );
    expect(Number(n.n)).toBe(0);
  });

  it("läsaren, en utomstående och en annan organisation nekas", async () => {
    const stranger = await createUser();
    for (const u of [reader, stranger]) {
      const out = await settle(
        asUser(u, (tx) =>
          tx.execute(
            sql`select * from public.my_recent_mystery_packings(${orgId}::uuid, ${mp}::uuid)`,
          ),
        ),
      );
      expect(out.ok).toBe(false);
    }
  });
});

describe("sidan för påfyllaren efter omladdning", () => {
  it("laddaren visar den egna packningen med Ångra, utan belopp", async () => {
    const detail = await loadMysteryDetailFor(await viewerFor(refiller, orgId), mp);
    expect(detail?.overview.seesMoney).toBe(false);
    expect(detail?.packings.map((p) => p.id)).toEqual([mine]);
    expect(detail?.packings[0]).toMatchObject({
      batches: 1,
      packs: 14,
      costPerPackOre: null,
      undone: false,
      undoable: true,
      tooLate: false,
    });
  });

  it("den andra påfyllaren ser bara sin egen", async () => {
    const detail = await loadMysteryDetailFor(await viewerFor(other, orgId), mp);
    expect(detail?.packings.map((p) => p.id)).toEqual([theirs]);
  });

  it("Ångra fungerar: delarna är tillbaka och raden är ångrad", async () => {
    const before = await level(part);
    const out = await undoPackFor(await viewerFor(refiller, orgId), { packingId: mine });
    expect(out.packingId).toBe(mine);
    expect(await level(part)).toBe(before + 14);
    const detail = await loadMysteryDetailFor(await viewerFor(refiller, orgId), mp);
    expect(detail?.packings[0]).toMatchObject({ id: mine, undone: true, undoable: false });
  });

  it("den 40 minuter gamla går inte att ångra", async () => {
    await expect(undoPackFor(await viewerFor(refiller, orgId), { packingId: old })).rejects.toThrow(
      "För sent att ångra",
    );
  });
});

describe("ägaren och läsaren som förut", () => {
  it("ägaren ser alla packningar med kostnad; den gamla är märkt för sent", async () => {
    const detail = await loadMysteryDetailFor(await viewerFor(owner, orgId), mp);
    const by = new Map(detail!.packings.map((p) => [p.id, p]));
    expect([...by.keys()].sort()).toEqual([mine, old, theirs].sort());
    expect(by.get(old)).toMatchObject({ tooLate: true, undoable: false, costPerPackOre: 5000 });
    expect(by.get(theirs)).toMatchObject({ tooLate: false, undoable: true });
    expect(by.get(mine)).toMatchObject({ undone: true, tooLate: false });
  });

  it("läsaren ser packningarna men kan inte ångra", async () => {
    const detail = await loadMysteryDetailFor(await viewerFor(reader, orgId), mp);
    expect(detail?.packings.length).toBe(3);
    expect(detail?.packings.every((p) => !p.undoable)).toBe(true);
  });
});
