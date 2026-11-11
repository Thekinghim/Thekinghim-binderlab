/**
 * Runda 2, T1-1: Fyll på frågar "Packade du en omgång?" när mystery packs fylls på fast de
 * inte finns färdiga i lagret. Mot testdatabasen, som påfyllaren (RLS):
 *
 * - Fyll på-laddaren ger gällande innehåll (delarna och omgången) för mystery packs, så att
 *   frågan kan ställas och Packa kan köras från Fyll på,
 * - "Ja": Packa (pack_mystery) och sedan påfyllningen lämnar mystery-lagret på 0 (inte −14)
 *   och drar delarna enligt innehållet,
 * - utan frågan (det gamla sättet, påfyllning ur lagret fast det är tomt) nekas uttaget, och
 *   en påfyllning utan uttag lämnar delarna kvar i lagret: det är felet frågan stoppar.
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
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { loadFillDataFor } = await import("../../src/app/fyll-pa/_lib/data");
const { packAsks } = await import("../../src/app/fyll-pa/_lib/model");
const { packFor } = await import("../../src/app/(app)/vart-lager/mystery/_lib/service");
const { syncRefillsFor } = await import("../../src/server/data/field-refills");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let owner: TestUser;
let refiller: TestUser;
let orgId: string;
let machineId: string;
let locationId: string;
let centralId: string;
let mp: string;
let bare: string;
let partA: string;
let partB: string;

async function event(location: string, titleId: string, kind: string, quantity: number, ago = 0) {
  await asPostgres((tx) =>
    tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${location}::uuid, ${titleId}::uuid, ${kind}::public.stock_event_kind,
              ${quantity}, now() - make_interval(mins => ${ago}), 'test')`),
  );
}

async function level(location: string, titleId: string): Promise<number> {
  const row = await one<{ q: number | null }>(
    db(),
    sql`select coalesce((select quantity from public.stock_levels
          where organization_id = ${orgId}::uuid and location_id = ${location}::uuid
            and title_id = ${titleId}::uuid), 0)::int as q`,
  );
  return Number(row.q);
}

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  const [m] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values({
        organizationId: orgId,
        code: "BL-001",
        name: "Automat 1",
        activeFrom: "2026-10-01",
      })
      .returning(),
  );
  machineId = m!.id;
  locationId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
    )
  ).id;
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
        { organizationId: orgId, name: "Eget utan innehåll", ownProduct: true },
        { organizationId: orgId, name: "Phantasmal Flames" },
        { organizationId: orgId, name: "Delta Reign" },
      ])
      .returning();
    [mp, bare, partA, partB] = titles.map((t) => t.id) as [string, string, string, string];
    await tx.execute(
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14,
            ${JSON.stringify([
              { titleId: partA, quantity: 8, hit: false },
              { titleId: partB, quantity: 6, hit: true },
            ])}::jsonb)`,
    );
  });
  // Delar till två omgångar i lagret, inga färdiga mystery packs. Automatens fack är tomt.
  await event(centralId, partA, "count", 16, 60);
  await event(centralId, partB, "count", 12, 60);
  await event(centralId, mp, "count", 0, 60);
  await event(locationId, mp, "count", 0, 60);
  await db().execute(sql`
    update public.stock_locations
       set awish_synced_at = now(),
           awish_fill = ${JSON.stringify([
             { title_id: mp, units: 0, capacity: 20, channels: 1, empty: 1 },
           ])}::jsonb
     where id = ${locationId}::uuid`);
});

function refill(quantity: number, fromWarehouse: boolean) {
  return {
    clientId: randomUUID(),
    machineId,
    titleId: mp,
    quantity,
    fromWarehouse,
    ...(fromWarehouse ? { fromLocationId: centralId } : {}),
    occurredAt: new Date().toISOString(),
    note: "Fyll på",
  };
}

describe("Fyll på-laddaren: innehållet för frågan", () => {
  it("påfyllaren får gällande innehåll (bara antal) för mystery packs med innehåll", async () => {
    const data = await loadFillDataFor(await viewerFor(refiller, orgId));
    expect(Object.keys(data.recipes)).toEqual([mp]);
    expect(data.recipes[mp]).toMatchObject({
      batchSize: 14,
      items: [
        { titleId: partA, quantity: 8 },
        { titleId: partB, quantity: 6 },
      ],
    });
    expect(data.recipes[bare]).toBeUndefined();
    // Inga belopp följer med.
    expect(JSON.stringify(data.recipes)).not.toMatch(/ore|cost|price/i);
  });

  it("en ny version av innehållet: laddaren ger den senaste", async () => {
    await asUser(owner, (tx) =>
      tx.execute(
        sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14,
              ${JSON.stringify([
                { titleId: partA, quantity: 8, hit: false },
                { titleId: partB, quantity: 6, hit: true },
              ])}::jsonb, 'v2')`,
      ),
    );
    const data = await loadFillDataFor(await viewerFor(refiller, orgId));
    const latest = await one<{ id: string }>(
      db(),
      sql`select id::text from public.mystery_recipes where title_id = ${mp}::uuid
          order by version desc limit 1`,
    );
    expect(data.recipes[mp]?.recipeId).toBe(latest.id);
  });

  it("frågan ställs: tomt fack, 0 färdiga, delarna räcker", async () => {
    const data = await loadFillDataFor(await viewerFor(refiller, orgId));
    const row = data.machines[0]!.rows.find((r) => r.titleId === mp)!;
    expect(row).toMatchObject({ now: 0, home: 0, suggested: 0, batchSize: 14 });
    const asks = packAsks(
      [{ row, quantity: 14 }],
      data.recipes,
      data.sources.stock[centralId] ?? {},
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ titleId: mp, home: 0, batches: 1, packs: 14 });
  });
});

describe("svaret Ja: packa en omgång och fyll på", () => {
  it("mystery-lagret står på 0 (inte −14) och delarna är dragna enligt innehållet", async () => {
    const viewer = await viewerFor(refiller, orgId);
    const data = await loadFillDataFor(viewer);
    const packed = await packFor(viewer, {
      titleId: mp,
      placeId: centralId,
      batches: 1,
      recipeId: data.recipes[mp]!.recipeId,
      clientId: randomUUID(),
    });
    expect(packed.packs).toBe(14);
    expect(await level(centralId, mp)).toBe(14);

    const out = await syncRefillsFor(viewer, [refill(14, true)]);
    expect(out.results.map((r) => r.status)).toEqual(["saved"]);

    expect(await level(centralId, mp)).toBe(0);
    expect(await level(centralId, partA)).toBe(8);
    expect(await level(centralId, partB)).toBe(6);
    expect(await level(locationId, mp)).toBe(14);
  });
});

describe("utan frågan (det frågan stoppar)", () => {
  it("påfyllning utan uttag lämnar delarna kvar i lagret fast de sitter i automaten", async () => {
    await event(locationId, mp, "count", 0);
    const viewer = await viewerFor(refiller, orgId);
    const out = await syncRefillsFor(viewer, [refill(14, false)]);
    expect(out.results.map((r) => r.status)).toEqual(["saved"]);
    // Delarna ligger kvar (8 och 6): lagret visar pack som redan är i automaten.
    expect(await level(centralId, partA)).toBe(8);
    expect(await level(centralId, partB)).toBe(6);
    expect(await level(centralId, mp)).toBe(0);
  });
});
