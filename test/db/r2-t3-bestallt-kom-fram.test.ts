/**
 * Runda 2, T3-4 ("Beställt" och "Kom fram" på inköpslistan), mot testdatabasen.
 *
 * - "Beställt" utan någon leverantör inlagd skapar en inköpsorder hos "Eget inköp", och
 *   inköpsplanens antal för titeln sjunker med det beställda.
 * - "Kom fram" med 30 av 56 lägger 30 i lagret, avslutar ordern och planen ber om resten.
 * - Fler än beställt, annat lager än standardlagret, och pris i samma steg.
 * - En läsare får inte beställa eller ta emot.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { purchaseQty } from "../../src/analytics/purchasing";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  loadPurchasePlanFor,
  onTheWay,
  OWN_SUPPLIER_NAME,
  quickOrderFor,
  receiveArrivalFor,
} from "../../src/server/purchasing";
import { createPlaceFor, withReceiptPrice } from "../../src/app/(app)/vart-lager/_lib/register";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
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

describe("Beställt och Kom fram på inköpslistan", () => {
  let owner: TestUser;
  let reader: TestUser;
  let orgId: string;
  let titleId: string;
  let hemma: string;
  let kontoret: string;

  const level = async (location: string) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${titleId}::uuid`,
      )
    )[0]?.q ?? 0;
  const orders = () =>
    rows<{ status: string; supplier: string; quantity: number; received: number; note: string }>(
      db(),
      sql`select po.status::text as status, sup.name as supplier, l.quantity::int as quantity,
                 l.received_quantity::int as received, coalesce(po.note, '') as note
          from public.purchase_orders po
          join public.suppliers sup on sup.id = po.supplier_id
          join public.purchase_order_lines l on l.purchase_order_id = po.id
          where po.organization_id = ${orgId}::uuid
          order by po.created_at, po.id`,
    );
  /** Inköpsplanens antal för titeln (samma tal som Inköp och Vårt lager visar). */
  const planQty = async (v: Viewer) => {
    const plan = await loadPurchasePlanFor(v);
    const line = plan.lines.find((l) => l.titleId === titleId);
    return line ? purchaseQty(line) : 0;
  };

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner, "Beställt och kom fram");
    reader = await createMember(orgId, "viewer");
    await asUser(owner, async (tx) => {
      const org = { organizationId: orgId };
      const [title] = await tx
        .insert(s.titles)
        .values({ ...org, name: "Pokémon 151" })
        .returning();
      titleId = title!.id;
      const [machine] = await tx
        .insert(s.machines)
        .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2026-01-01" })
        .returning();
      const [source] = await tx
        .insert(s.dataSources)
        .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
        .returning();
      // Fyra pack om dagen i 40 dagar t.o.m. i går: planen vill köpa in.
      const day = 24 * 60 * 60 * 1000;
      const values = [];
      for (let d = 1; d <= 40; d += 1) {
        for (let k = 0; k < 4; k += 1) {
          values.push({
            ...org,
            dataSourceId: source!.id,
            externalId: `bk-${d}-${k}`,
            rawTitle: "Pokémon 151",
            titleId,
            machineId: machine!.id,
            orderedAt: new Date(Date.now() - d * day + k * 60_000),
            amountOre: 14_900,
            sourceHash: `bk-${d}-${k}`,
          });
        }
      }
      await tx.insert(s.orders).values(values);
    });
    hemma = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations
            where organization_id = ${orgId}::uuid and is_central and archived_at is null`,
      )
    ).id;
    kontoret = (await createPlaceFor(await viewerFor(owner, orgId), { name: "Kontoret" })).id;
  });

  it("Beställt utan leverantör: order hos Eget inköp, och planens antal sjunker med det beställda", async () => {
    const v = await viewerFor(owner, orgId);
    const before = await planQty(v);
    expect(before).toBeGreaterThan(56);
    const res = await quickOrderFor(v, { titleId, quantity: 56 });
    expect(res.quantity).toBe(56);
    expect(await orders()).toMatchObject([
      { status: "ordered", supplier: OWN_SUPPLIER_NAME, quantity: 56, received: 0 },
    ]);
    expect(await planQty(v)).toBe(before - 56);
    // "På väg: 56 st" syns för alla som läser planen (ägaren ser delägarens rad).
    const way = onTheWay(await loadPurchasePlanFor(v)).find((w) => w.titleId === titleId);
    expect(way).toMatchObject({ quantity: 56, expectedOn: res.expectedOn, late: false });
    // Titeln har fortfarande ingen leverantörsartikel.
    const items = await rows(
      db(),
      sql`select 1 from public.supplier_items where organization_id = ${orgId}::uuid`,
    );
    expect(items).toHaveLength(0);
  });

  it("Kom fram med 30 av 56: 30 i lagret, ordern avslutas och planen ber om 26 till", async () => {
    const v = await viewerFor(owner, orgId);
    const ordered = await planQty(v);
    const res = await receiveArrivalFor(v, { titleId, quantity: 30 });
    expect(res).toMatchObject({
      previous: 0,
      onHand: 30,
      expected: 56,
      fromOrders: 30,
      missing: 26,
    });
    expect(await level(hemma)).toBe(30);
    const [po] = await orders();
    expect(po).toMatchObject({ status: "received", quantity: 56, received: 30 });
    expect(po!.note).toContain("26 pack kom aldrig");
    expect(
      onTheWay(await loadPurchasePlanFor(v)).find((w) => w.titleId === titleId),
    ).toBeUndefined();
    // 56 var räknade som på väg; nu ligger 30 hemma: planen ber om 26 till.
    expect(await planQty(v)).toBe(ordered + 26);
  });

  it("fler än beställt, till Kontoret: det beställda flyttas dit och resten läggs in direkt", async () => {
    const v = await viewerFor(owner, orgId);
    await quickOrderFor(v, { titleId, quantity: 10 });
    const res = await receiveArrivalFor(v, { titleId, quantity: 14, warehouseId: kontoret });
    expect(res).toMatchObject({ onHand: 14, expected: 10, fromOrders: 10, missing: 0 });
    expect(res.placeName).toBe("Kontoret");
    expect(await level(kontoret)).toBe(14);
    expect(await level(hemma)).toBe(30);
    expect((await orders()).at(-1)).toMatchObject({
      status: "received",
      quantity: 10,
      received: 10,
    });
  });

  it("Köpt, har dem här utan beställning, med nytt pris i samma steg", async () => {
    const v = await viewerFor(owner, orgId);
    const res = await withReceiptPrice(v, { titleId, unitCostOre: 11_800 }, new Date(), () =>
      receiveArrivalFor(v, { titleId, quantity: 6 }),
    );
    expect(res).toMatchObject({
      onHand: 36,
      expected: 0,
      fromOrders: 0,
      price: { status: "saved", unitCostOre: 11_800 },
    });
    const price = await rows<{ ore: number }>(
      db(),
      sql`select unit_cost_ore::int as ore from public.purchase_prices
          where organization_id = ${orgId}::uuid and title_id = ${titleId}::uuid`,
    );
    expect(price).toEqual([{ ore: 11_800 }]);
  });

  it("en läsare får varken beställa eller ta emot", async () => {
    const v = await viewerFor(reader, orgId);
    await expect(quickOrderFor(v, { titleId, quantity: 5 })).rejects.toThrow();
    await expect(receiveArrivalFor(v, { titleId, quantity: 5 })).rejects.toThrow();
    expect(await level(hemma)).toBe(36);
  });
});
