/**
 * Runda 2, T3-3 (Leverans med pris), mot testdatabasen: registerReceiptWithPriceFor.
 *
 * - Nytt pris: lagerhändelsen ('receipt') skrivs och ett inköpspris från i dag; äldre
 *   försäljning behåller sitt pris (den gamla prisraden är orörd).
 * - Samma pris: bara lagerhändelsen, ingen prisrad.
 * - Konstigt pris utan bekräftelse: ingenting sparas (varken pack eller pris).
 * - Priset går inte att spara: packen ligger kvar och svaret säger att priset inte sparades.
 * - En läsare får varken lägga in pack eller pris.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import { registerReceiptWithPriceFor } from "../../src/app/(app)/vart-lager/_lib/register";

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

function todayInStockholm(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

describe("Leverans med pris (+ Inköp)", () => {
  let owner: TestUser;
  let reader: TestUser;
  let orgId: string;
  let titleId: string;
  let otherId: string;
  let hemma: string;
  const today = todayInStockholm();

  const level = async (title = titleId) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${hemma}::uuid and title_id = ${title}::uuid`,
      )
    )[0]?.q ?? 0;
  const prices = (title = titleId) =>
    rows<{ ore: number; day: string }>(
      db(),
      sql`select unit_cost_ore::int as ore, valid_from::text as day from public.purchase_prices
          where organization_id = ${orgId}::uuid and title_id = ${title}::uuid
          order by valid_from`,
    );
  const receipts = (title = titleId) =>
    rows<{ quantity: number }>(
      db(),
      sql`select quantity from public.stock_events
          where organization_id = ${orgId}::uuid and title_id = ${title}::uuid
            and kind = 'receipt' order by seq`,
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner, "Leverans med pris");
    reader = await createMember(orgId, "viewer");
    await asUser(owner, async (tx) => {
      const org = { organizationId: orgId };
      const [title, other] = await tx
        .insert(s.titles)
        .values([
          { ...org, name: "Pokémon 151" },
          { ...org, name: "Black Bolt" },
        ])
        .returning();
      titleId = title!.id;
      otherId = other!.id;
      await tx
        .insert(s.purchasePrices)
        .values({ ...org, titleId, unitCostOre: 11_200, validFrom: "2026-01-01" });
    });
    hemma = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations
            where organization_id = ${orgId}::uuid and is_central and archived_at is null`,
      )
    ).id;
  });

  it("samma pris: packen läggs in, ingen prisrad skrivs", async () => {
    const res = await registerReceiptWithPriceFor(await viewerFor(owner, orgId), {
      titleId,
      quantity: 24,
      unitCostOre: 11_200,
    });
    expect(res).toMatchObject({ onHand: 24, price: { status: "same" } });
    expect(await level()).toBe(24);
    expect(await prices()).toEqual([{ ore: 11_200, day: "2026-01-01" }]);
  });

  it("nytt pris: lagerhändelsen och ett pris från i dag; det gamla priset är orört", async () => {
    const res = await registerReceiptWithPriceFor(await viewerFor(owner, orgId), {
      titleId,
      quantity: 36,
      unitCostOre: 11_800,
    });
    expect(res).toMatchObject({
      previous: 24,
      onHand: 60,
      price: { status: "saved", unitCostOre: 11_800, previousOre: 11_200 },
    });
    expect((await receipts()).map((r) => r.quantity)).toEqual([24, 36]);
    // Äldre försäljning räknas fortfarande med 112 kr (raden från 1 jan. är kvar som den var).
    expect(await prices()).toEqual([
      { ore: 11_200, day: "2026-01-01" },
      { ore: 11_800, day: today },
    ]);
  });

  it("utan pris: bara packen", async () => {
    const res = await registerReceiptWithPriceFor(await viewerFor(owner, orgId), {
      titleId: otherId,
      quantity: 5,
    });
    expect(res).toMatchObject({ onHand: 5, price: { status: "none" } });
    expect(await prices(otherId)).toEqual([]);
  });

  it("första priset för en titel sparas från i dag", async () => {
    const res = await registerReceiptWithPriceFor(await viewerFor(owner, orgId), {
      titleId: otherId,
      quantity: 5,
      unitCostOre: 9_900,
    });
    expect(res).toMatchObject({ onHand: 10, price: { status: "saved", previousOre: null } });
    expect(await prices(otherId)).toEqual([{ ore: 9_900, day: today }]);
  });

  it("konstigt pris (1 180 kr mot 118 kr): inget sparas förrän det är bekräftat", async () => {
    const v = await viewerFor(owner, orgId);
    const first = await registerReceiptWithPriceFor(v, {
      titleId,
      quantity: 12,
      unitCostOre: 118_000,
    });
    expect(first).toMatchObject({ ok: false, doubt: { kind: "higher", refOre: 11_800 } });
    expect(await level()).toBe(60);
    expect((await prices()).at(-1)).toEqual({ ore: 11_800, day: today });
    const second = await registerReceiptWithPriceFor(v, {
      titleId,
      quantity: 12,
      unitCostOre: 118_000,
      confirmed: true,
    });
    expect(second).toMatchObject({ onHand: 72, price: { status: "saved" } });
    expect((await prices()).at(-1)).toEqual({ ore: 118_000, day: today });
  });

  it("priset går inte att spara: packen ligger kvar och svaret säger att priset inte sparades", async () => {
    // Databasen vägrar prisraden (här med en tillfällig spärr), efter att packen sparats.
    await db().execute(sql`
      create function public.r2t3_block_price() returns trigger language plpgsql as $$
      begin raise exception 'spärr i testet'; end $$`);
    await db().execute(sql`
      create trigger r2t3_block_price before insert or update on public.purchase_prices
      for each row execute function public.r2t3_block_price()`);
    try {
      const res = await registerReceiptWithPriceFor(await viewerFor(owner, orgId), {
        titleId: otherId,
        quantity: 3,
        unitCostOre: 10_500,
      });
      expect(res).toMatchObject({ onHand: 13, price: { status: "failed", unitCostOre: 10_500 } });
      if ("price" in res) expect(res.price.error).toBeTruthy();
    } finally {
      await db().execute(sql`drop trigger r2t3_block_price on public.purchase_prices`);
      await db().execute(sql`drop function public.r2t3_block_price()`);
    }
    expect(await level(otherId)).toBe(13);
    expect(await prices(otherId)).toEqual([{ ore: 9_900, day: today }]);
  });

  it("en läsare får varken lägga in pack eller pris", async () => {
    const v = await viewerFor(reader, orgId);
    await expect(
      registerReceiptWithPriceFor(v, { titleId, quantity: 1, unitCostOre: 100 }),
    ).rejects.toThrow();
    expect(await level()).toBe(72);
  });
});
