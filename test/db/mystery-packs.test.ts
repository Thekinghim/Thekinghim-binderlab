/**
 * Mystery packs (20261115000000_mystery_packs.sql) mot testdatabasen:
 *
 * - innehållet: bara ägare och admin sparar; summan måste bli omgången, minst en rad, ingen
 *   dubblett, aldrig titeln själv eller en annan egen produkt; samma innehåll ger ingen ny
 *   version, ett ändrat ger version 2 från i dag; versionerna går inte att ändra,
 * - packa: EN transaktion med negativa justeringar för delarna och en positiv för
 *   mystery-packet i samma lager, ett transfer_group_id och noteringen "Packat 2 omgångar …";
 *   saldon före och efter; kostnad per pack då; idempotent på klientens id; nekas när en del
 *   saknas (vilka och hur många) och ingenting ändras; nekas när innehållet ändrats,
 * - ångra: inom 30 minuter, en gång, bara sina egna (påfyllaren), inte när packen är borta,
 * - roller och RLS: påfyllaren packar och läser innehållet men inte packningarna (belopp);
 *   läsaren läser men packar inte; ingen skriver i tabellerna direkt; en annan organisation
 *   når ingenting; en lös justering med transfer_group_id nekas vid commit.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import { loadMysteryOverviewFor } from "../../src/app/(app)/vart-lager/mystery/_lib/data";
import {
  MysteryError,
  packFor,
  saveRecipeFor,
  setMysteryCostFor,
  undoPackFor,
} from "../../src/app/(app)/vart-lager/mystery/_lib/service";

import {
  asPostgres,
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

const rejects = async (p: Promise<unknown>, message: RegExp) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MysteryError);
  expect((error as Error).message).toMatch(message);
};

describe("Mystery packs: innehåll och packning", () => {
  let owner: TestUser;
  let admin: TestUser;
  let refiller: TestUser;
  let reader: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let hemma: string;
  let kontoret: string;
  let mp: string; // Mystery Pack Plus (egen produkt)
  let other: string; // en annan egen produkt
  const t: Record<string, string> = {};
  let recipeV1: string;

  const level = async (location: string, title: string) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${title}::uuid`,
      )
    )[0]?.q ?? 0;
  const levels = async (location: string) =>
    Object.fromEntries(
      await Promise.all(
        [mp, t.pf!, t.dr!, t.ah!].map(async (id) => [id, await level(location, id)] as const),
      ),
    );
  const ov = () => viewerFor(owner, orgId);
  const items = (pf = 4, dr = 3, ah = 2) => [
    { titleId: t.pf!, quantity: pf, hit: false },
    { titleId: t.dr!, quantity: dr, hit: false },
    { titleId: t.ah!, quantity: ah, hit: true },
  ];

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    admin = await createMember(orgId, "admin");
    refiller = await createMember(orgId, "refiller");
    reader = await createMember(orgId, "viewer");
    outsider = await createUser();
    await createOrg(outsider, "Annan organisation");

    await asUser(owner, async (tx) => {
      const titles = await tx
        .insert(s.titles)
        .values([
          { organizationId: orgId, name: "Mystery Pack Plus", ownProduct: true },
          { organizationId: orgId, name: "Mystery Pack Mini", ownProduct: true },
          { organizationId: orgId, name: "Phantasmal Flames" },
          { organizationId: orgId, name: "Delta Reign" },
          { organizationId: orgId, name: "Ascended Heroes" },
          { organizationId: orgId, name: "Utan pris" },
        ])
        .returning();
      [mp, other] = [titles[0]!.id, titles[1]!.id];
      t.pf = titles[2]!.id;
      t.dr = titles[3]!.id;
      t.ah = titles[4]!.id;
      t.np = titles[5]!.id;
      await tx.insert(s.purchasePrices).values([
        { organizationId: orgId, titleId: t.pf, unitCostOre: 6000, validFrom: "2026-01-01" },
        { organizationId: orgId, titleId: t.dr, unitCostOre: 5500, validFrom: "2026-01-01" },
        { organizationId: orgId, titleId: t.ah, unitCostOre: 12_000, validFrom: "2026-01-01" },
        { organizationId: orgId, titleId: mp, unitCostOre: 7000, validFrom: "2026-01-01" },
      ]);
      const [central] = await tx
        .select()
        .from(s.stockLocations)
        .where(
          sql`${s.stockLocations.organizationId} = ${orgId} and ${s.stockLocations.isCentral}`,
        );
      hemma = central!.id;
      kontoret = (
        await one<{ id: string }>(
          tx,
          sql`select public.create_warehouse(${orgId}::uuid, 'Kontoret')::text as id`,
        )
      ).id;
      await tx.insert(s.stockEvents).values([
        { organizationId: orgId, locationId: hemma, titleId: t.pf, kind: "receipt", quantity: 10 },
        { organizationId: orgId, locationId: hemma, titleId: t.dr, kind: "receipt", quantity: 7 },
        { organizationId: orgId, locationId: hemma, titleId: t.ah, kind: "receipt", quantity: 4 },
        {
          organizationId: orgId,
          locationId: kontoret,
          titleId: t.pf,
          kind: "receipt",
          quantity: 4,
        },
      ]);
    });
  });

  describe("innehållet", () => {
    it("påfyllaren och läsaren kan inte spara innehållet", async () => {
      for (const u of [refiller, reader]) {
        const outcome = await asUser(u, (tx) =>
          attempt(tx, (sp) =>
            sp.execute(
              sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 9,
                    ${JSON.stringify(items())}::jsonb)`,
            ),
          ),
        );
        expect(outcome.code).toBe("42501");
      }
      const svc = await saveRecipeFor(await viewerFor(reader, orgId), {
        titleId: mp,
        batchSize: 9,
        items: items(),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(svc).toBeInstanceOf(Error);
    });

    it("summan måste bli omgången, och reglerna för raderna gäller", async () => {
      const v = await ov();
      await rejects(
        saveRecipeFor(v, { titleId: mp, batchSize: 14, items: items() }),
        /Antalen blir 9 men en omgång är 14/,
      );
      await rejects(
        saveRecipeFor(v, {
          titleId: mp,
          batchSize: 8,
          items: [
            { titleId: t.pf!, quantity: 4, hit: false },
            { titleId: t.pf!, quantity: 4, hit: false },
          ],
        }),
        /står två gånger/,
      );
      await rejects(
        saveRecipeFor(v, {
          titleId: mp,
          batchSize: 1,
          items: [{ titleId: mp, quantity: 1, hit: false }],
        }),
        /sig självt eller en annan egen produkt/,
      );
      await rejects(
        saveRecipeFor(v, {
          titleId: mp,
          batchSize: 1,
          items: [{ titleId: other, quantity: 1, hit: false }],
        }),
        /annan egen produkt/,
      );
      await rejects(
        saveRecipeFor(v, { titleId: t.pf!, batchSize: 9, items: items() }),
        /Egen produkt/,
      );
      const empty = await asUser(owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14, '[]'::jsonb)`,
          ),
        ),
      );
      expect(empty).toMatchObject({ ok: false, code: "22023" });
    });

    it("databasen kontrollerar summan vid commit även utan RPC:n", async () => {
      const outcome = await settle(
        asPostgres(async (tx) => {
          const r = await one<{ id: string }>(
            tx,
            sql`insert into public.mystery_recipes (organization_id, title_id, version, valid_from, batch_size)
                values (${orgId}, ${mp}, 99, current_date, 14) returning id`,
          );
          await tx.execute(
            sql`insert into public.mystery_recipe_items (organization_id, recipe_id, component_title_id, quantity, position)
                values (${orgId}, ${r.id}, ${t.pf}, 13, 0)`,
          );
        }),
      );
      expect(outcome).toMatchObject({ ok: false, code: "22023" });
      expect(outcome.ok ? "" : outcome.message).toMatch(/Antalen blir 13 men en omgång är 14/);
      const none = await settle(
        asPostgres((tx) =>
          tx.execute(
            sql`insert into public.mystery_recipes (organization_id, title_id, version, valid_from, batch_size)
                values (${orgId}, ${mp}, 98, current_date, 14)`,
          ),
        ),
      );
      expect(none).toMatchObject({ ok: false, code: "22023" });
    });

    it("ingen klientroll skriver i tabellerna direkt", async () => {
      const outcome = await asUser(owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.mystery_recipes (organization_id, title_id, version, valid_from, batch_size)
                values (${orgId}, ${mp}, 1, current_date, 9)`,
          ),
        ),
      );
      expect(outcome.code).toBe("42501");
    });

    it("ägaren sparar version 1; samma innehåll igen ger samma id; admin sparar version 2", async () => {
      recipeV1 = (await saveRecipeFor(await ov(), { titleId: mp, batchSize: 9, items: items() }))
        .recipeId;
      const again = await saveRecipeFor(await ov(), { titleId: mp, batchSize: 9, items: items() });
      expect(again.recipeId).toBe(recipeV1);
      const heads = await rows<{ version: number; valid_from: string; batch_size: number }>(
        db(),
        sql`select version, valid_from::text, batch_size from public.mystery_recipes
            where organization_id = ${orgId}::uuid and title_id = ${mp}::uuid order by version`,
      );
      expect(heads).toHaveLength(1);
      expect(heads[0]).toMatchObject({ version: 1, batch_size: 9 });
      const today = (
        await one<{ d: string }>(
          db(),
          sql`select (now() at time zone o.timezone)::date::text as d from public.organizations o
              where o.id = ${orgId}::uuid`,
        )
      ).d;
      expect(heads[0]!.valid_from).toBe(today);
    });
  });

  describe("packa", () => {
    let firstPacking: string;
    const clientId = randomUUID();

    it("läsaren kan inte packa", async () => {
      const outcome = await asUser(reader, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select * from public.pack_mystery(${orgId}::uuid, gen_random_uuid(), ${mp}::uuid,
                  ${hemma}::uuid, 1, ${recipeV1}::uuid)`,
          ),
        ),
      );
      expect(outcome.code).toBe("42501");
    });

    it("två omgångar: en transaktion, rätt saldon före och efter, ett transfer_group_id", async () => {
      const before = await levels(hemma);
      expect(before).toEqual({ [mp]: 0, [t.pf!]: 10, [t.dr!]: 7, [t.ah!]: 4 });
      const res = await packFor(await ov(), {
        titleId: mp,
        placeId: hemma,
        batches: 2,
        recipeId: recipeV1,
        clientId,
      });
      firstPacking = res.packingId;
      expect(res).toMatchObject({ packs: 18, duplicate: false });
      expect(await levels(hemma)).toEqual({ [mp]: 18, [t.pf!]: 2, [t.dr!]: 1, [t.ah!]: 0 });
      expect(res.levels).toMatchObject({ [mp]: 18, [t.pf!]: 2, [t.dr!]: 1, [t.ah!]: 0 });
      // Kontoret rörs inte.
      expect(await level(kontoret, t.pf!)).toBe(4);

      const packing = await one<{
        transfer_group_id: string;
        batches: number;
        packs: number;
        cost: number;
        recipe_id: string;
        location_id: string;
        note: string;
      }>(
        db(),
        sql`select transfer_group_id::text, batches, packs, cost_per_pack_ore::int as cost,
                   recipe_id::text, location_id::text, note
            from public.mystery_packings where id = ${firstPacking}::uuid`,
      );
      // (4×60 + 3×55 + 2×120) / 9 = 645 / 9 = 71,67 kr.
      expect(packing).toMatchObject({
        batches: 2,
        packs: 18,
        cost: 7167,
        recipe_id: recipeV1,
        location_id: hemma,
        note: "Packat 2 omgångar Mystery Pack Plus",
      });
      const events = await rows<{ title_id: string; kind: string; quantity: number; note: string }>(
        db(),
        sql`select title_id::text, kind::text, quantity, note from public.stock_events
            where transfer_group_id = ${packing.transfer_group_id}::uuid order by seq`,
      );
      expect(events.map((e) => [e.title_id, e.kind, e.quantity])).toEqual([
        [t.pf, "adjustment", -8],
        [t.dr, "adjustment", -6],
        [t.ah, "adjustment", -4],
        [mp, "adjustment", 18],
      ]);
      expect(new Set(events.map((e) => e.note))).toEqual(
        new Set(["Packat 2 omgångar Mystery Pack Plus"]),
      );
    });

    it("samma klient-id igen ger samma packning och ändrar ingenting", async () => {
      const res = await packFor(await ov(), {
        titleId: mp,
        placeId: hemma,
        batches: 2,
        recipeId: recipeV1,
        clientId,
      });
      expect(res).toMatchObject({ packingId: firstPacking, duplicate: true, packs: 18 });
      expect(await level(hemma, mp)).toBe(18);
      await rejects(
        packFor(await ov(), {
          titleId: mp,
          placeId: hemma,
          batches: 1,
          recipeId: recipeV1,
          clientId,
        }),
        /redan sparad\. Ladda om sidan/,
      );
    });

    it("saknas en del nekas packningen, med vilka och hur många, och inget ändras", async () => {
      const before = await levels(hemma);
      await rejects(
        packFor(await ov(), {
          titleId: mp,
          placeId: hemma,
          batches: 1,
          recipeId: recipeV1,
          clientId: randomUUID(),
        }),
        /^Hemma saknar 2 Phantasmal Flames, 2 Delta Reign, 2 Ascended Heroes\.$/,
      );
      expect(await levels(hemma)).toEqual(before);
      const n = await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.mystery_packings where organization_id = ${orgId}::uuid`,
      );
      expect(n.n).toBe(1);
    });

    it("ett annat lager: bara det lagret räknas", async () => {
      await rejects(
        packFor(await ov(), {
          titleId: mp,
          placeId: kontoret,
          batches: 1,
          recipeId: recipeV1,
          clientId: randomUUID(),
        }),
        /^Kontoret saknar 3 Delta Reign, 2 Ascended Heroes\.$/,
      );
    });

    it("en lös justering med transfer_group_id nekas vid commit", async () => {
      const outcome = await settle(
        asUser(owner, (tx) =>
          tx.insert(s.stockEvents).values({
            organizationId: orgId,
            locationId: hemma,
            titleId: t.pf!,
            kind: "adjustment",
            quantity: 5,
            transferGroupId: randomUUID(),
          }),
        ),
      );
      expect(outcome.code).toBe("BL017");
    });
  });

  describe("ångra", () => {
    it("påfyllaren packar en omgång och ångrar sin egen; en gång", async () => {
      await asUser(owner, (tx) =>
        tx.insert(s.stockEvents).values([
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: t.pf!,
            kind: "receipt",
            quantity: 2,
          },
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: t.dr!,
            kind: "receipt",
            quantity: 2,
          },
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: t.ah!,
            kind: "receipt",
            quantity: 2,
          },
        ]),
      );
      const before = await levels(hemma);
      const rv = await viewerFor(refiller, orgId);
      const res = await packFor(rv, {
        titleId: mp,
        placeId: hemma,
        batches: 1,
        recipeId: recipeV1,
        clientId: randomUUID(),
      });
      expect(await level(hemma, mp)).toBe(before[mp]! + 9);
      await undoPackFor(rv, { packingId: res.packingId });
      expect(await levels(hemma)).toEqual(before);
      await rejects(undoPackFor(rv, { packingId: res.packingId }), /redan ångrad/);
      const row = await one<{ undone: boolean; undo_group: string | null }>(
        db(),
        sql`select undone_at is not null as undone, undo_group_id::text as undo_group
            from public.mystery_packings where id = ${res.packingId}::uuid`,
      );
      expect(row.undone).toBe(true);
      const undoEvents = await rows<{ quantity: number; note: string }>(
        db(),
        sql`select quantity, note from public.stock_events
            where transfer_group_id = ${row.undo_group}::uuid order by seq`,
      );
      expect(undoEvents.map((e) => e.quantity)).toEqual([4, 3, 2, -9]);
      expect(undoEvents[0]!.note).toBe("Ångrat: Packat 1 omgång Mystery Pack Plus");
    });

    it("påfyllaren kan inte ångra ägarens packning; ägaren kan", async () => {
      const first = await one<{ id: string }>(
        db(),
        sql`select id::text from public.mystery_packings
            where organization_id = ${orgId}::uuid and batches = 2`,
      );
      await rejects(
        undoPackFor(await viewerFor(refiller, orgId), { packingId: first.id }),
        /dina egna/,
      );
    });

    it("efter 30 minuter går det inte att ångra", async () => {
      const first = await one<{ id: string }>(
        db(),
        sql`select id::text from public.mystery_packings
            where organization_id = ${orgId}::uuid and batches = 2`,
      );
      await db().execute(
        sql`update public.mystery_packings set packed_at = now() - interval '31 minutes'
            where id = ${first.id}::uuid`,
      );
      await rejects(undoPackFor(await ov(), { packingId: first.id }), /För sent att ångra/);
    });

    it("är packen redan borta (flyttade) går det inte att ångra", async () => {
      await asUser(owner, (tx) =>
        tx.insert(s.stockEvents).values([
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: t.pf!,
            kind: "receipt",
            quantity: 4,
          },
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: t.dr!,
            kind: "receipt",
            quantity: 3,
          },
          {
            organizationId: orgId,
            locationId: hemma,
            titleId: t.ah!,
            kind: "receipt",
            quantity: 2,
          },
        ]),
      );
      const res = await packFor(await ov(), {
        titleId: mp,
        placeId: hemma,
        batches: 1,
        recipeId: recipeV1,
        clientId: randomUUID(),
      });
      const have = await level(hemma, mp);
      await asUser(owner, (tx) =>
        tx.execute(
          sql`select public.transfer_stock(${orgId}::uuid, ${hemma}::uuid, ${kontoret}::uuid,
                ${mp}::uuid, ${have}::integer, null)`,
        ),
      );
      await rejects(
        undoPackFor(await ov(), { packingId: res.packingId }),
        /har bara 0 Mystery Pack Plus kvar/,
      );
    });
  });

  describe("versioner", () => {
    it("ett nytt innehåll blir version 2; gamla packningar behåller version 1", async () => {
      const v2 = (
        await saveRecipeFor(await viewerFor(admin, orgId), {
          titleId: mp,
          batchSize: 8,
          items: items(4, 2, 2),
          note: "Ny mix",
        })
      ).recipeId;
      expect(v2).not.toBe(recipeV1);
      const heads = await rows<{ version: number }>(
        db(),
        sql`select version from public.mystery_recipes where title_id = ${mp}::uuid order by version`,
      );
      expect(heads.map((h) => h.version)).toEqual([1, 2]);
      const old = await rows<{ recipe_id: string }>(
        db(),
        sql`select distinct recipe_id::text from public.mystery_packings where title_id = ${mp}::uuid`,
      );
      expect(old.map((r) => r.recipe_id)).toEqual([recipeV1]);
      // Version 1 har kvar sina rader och kan inte ändras.
      const v1Items = await rows<{ quantity: number }>(
        db(),
        sql`select quantity from public.mystery_recipe_items where recipe_id = ${recipeV1}::uuid order by position`,
      );
      expect(v1Items.map((i) => i.quantity)).toEqual([4, 3, 2]);
      const mutate = await settle(
        db().execute(
          sql`update public.mystery_recipe_items set quantity = 5 where recipe_id = ${recipeV1}::uuid`,
        ),
      );
      expect(mutate.ok).toBe(false);
      // Packar man med den gamla versionen på skärmen nekas det.
      await rejects(
        packFor(await ov(), {
          titleId: mp,
          placeId: hemma,
          batches: 1,
          recipeId: recipeV1,
          clientId: randomUUID(),
        }),
        /Innehållet har ändrats/,
      );
    });

    it("saknar en del inköpspris sparas packningen utan kostnad", async () => {
      await saveRecipeFor(await ov(), {
        titleId: other,
        batchSize: 1,
        items: [{ titleId: t.np!, quantity: 1, hit: false }],
      });
      await asUser(owner, (tx) =>
        tx.insert(s.stockEvents).values({
          organizationId: orgId,
          locationId: hemma,
          titleId: t.np!,
          kind: "receipt",
          quantity: 1,
        }),
      );
      const overview = await loadMysteryOverviewFor(await ov());
      const mini = overview.titles.find((x) => x.id === other)!;
      const res = await packFor(await ov(), {
        titleId: other,
        placeId: hemma,
        batches: 1,
        recipeId: mini.recipe!.id,
        clientId: randomUUID(),
      });
      const row = await one<{ cost: number | null }>(
        db(),
        sql`select cost_per_pack_ore as cost from public.mystery_packings where id = ${res.packingId}::uuid`,
      );
      expect(row.cost).toBeNull();
    });
  });

  describe("roller, RLS och laddaren", () => {
    const count = (u: TestUser, table: string) =>
      asUser(u, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(table)}
              where organization_id = ${orgId}::uuid`,
        ),
      ).then((r) => r.n);

    it("påfyllaren ser innehållet men inte packningarna; läsaren ser allt; andra ingenting", async () => {
      expect(await count(refiller, "mystery_recipes")).toBeGreaterThan(0);
      expect(await count(refiller, "mystery_recipe_items")).toBeGreaterThan(0);
      expect(await count(refiller, "mystery_packings")).toBe(0);
      expect(await count(reader, "mystery_packings")).toBeGreaterThan(0);
      for (const table of ["mystery_recipes", "mystery_recipe_items", "mystery_packings"]) {
        expect(await count(outsider, table)).toBe(0);
      }
      const foreign = await asUser(outsider, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select * from public.pack_mystery(${orgId}::uuid, gen_random_uuid(), ${mp}::uuid,
                  ${hemma}::uuid, 1)`,
          ),
        ),
      );
      expect(foreign.code).toBe("42501");
    });

    it("laddaren: påfyllaren får innehåll och saldo utan belopp; ägaren med", async () => {
      const r = await loadMysteryOverviewFor(await viewerFor(refiller, orgId));
      expect(r.canPack).toBe(true);
      expect(r.canEdit).toBe(false);
      expect(r.seesMoney).toBe(false);
      expect(r.prices.size).toBe(0);
      const plus = r.titles.find((x) => x.id === mp)!;
      expect(plus.recipe?.version).toBe(2);
      expect(plus.recipe?.items.map((i) => i.name)).toEqual([
        "Phantasmal Flames",
        "Delta Reign",
        "Ascended Heroes",
      ]);
      expect(plus.currentCostOre).toBeNull();
      const o = await loadMysteryOverviewFor(await ov());
      expect(o.seesMoney).toBe(true);
      expect(o.titles.find((x) => x.id === mp)?.currentCostOre).toBe(7000);
      expect(o.places.map((p) => p.name)).toEqual(["Hemma", "Kontoret"]);
    });

    it("Sätt inköpspris: ett pris från i dag (ägare); påfyllaren nekas", async () => {
      const res = await setMysteryCostFor(await ov(), { titleId: mp, unitCostOre: 7167 });
      const price = await one<{ unit_cost_ore: number; valid_from: string }>(
        db(),
        sql`select unit_cost_ore::int, valid_from::text from public.purchase_prices
            where title_id = ${mp}::uuid order by valid_from desc limit 1`,
      );
      expect(price).toEqual({ unit_cost_ore: 7167, valid_from: res.validFrom });
      const denied = await setMysteryCostFor(await viewerFor(refiller, orgId), {
        titleId: mp,
        unitCostOre: 1,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(denied).toBeInstanceOf(Error);
    });
  });
});
