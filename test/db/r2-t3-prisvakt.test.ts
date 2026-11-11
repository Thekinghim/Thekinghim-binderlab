/**
 * Runda 2, T3-2 (Prisvakt), mot testdatabasen: rimlighetskollen i addPurchasePriceFor och
 * correctPurchasePriceFor. Ett pris långt från det förra (1 125 kr i stället för 112,50 kr)
 * eller över vad packet säljs för sparas först efter ett extra tryck (confirmed: true).
 * "Nytt pris från i dag" ändrar inte äldre försäljnings pris.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import {
  addPurchasePriceFor,
  correctPurchasePriceFor,
} from "../../src/app/(app)/inkopspriser/_lib/data";
import { isPriceDoubt } from "../../src/app/(app)/inkopspriser/_lib/price-check";

import { asUser, createOrg, createUser, db, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

function todayInStockholm(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

describe("Prisvakt: rimlighetskoll av nytt inköpspris", () => {
  let owner: TestUser;
  let orgId: string;
  let titleId: string;
  let unpricedId: string;
  const today = todayInStockholm();

  const prices = (title = titleId) =>
    rows<{ ore: number; day: string }>(
      db(),
      sql`select unit_cost_ore::int as ore, valid_from::text as day from public.purchase_prices
          where organization_id = ${orgId}::uuid and title_id = ${title}::uuid
          order by valid_from`,
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner, "Prisvakt");
    await asUser(owner, async (tx) => {
      const org = { organizationId: orgId };
      const [title, unpriced] = await tx
        .insert(s.titles)
        .values([
          { ...org, name: "Pokémon 151" },
          { ...org, name: "Black Bolt" },
        ])
        .returning();
      titleId = title!.id;
      unpricedId = unpriced!.id;
      await tx
        .insert(s.purchasePrices)
        .values({ ...org, titleId, unitCostOre: 11_250, validFrom: "2026-01-01" });
      const [source] = await tx
        .insert(s.dataSources)
        .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
        .returning();
      // Tre köp för några dagar sedan, 149 kr styck, av båda titlarna.
      const at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await tx.insert(s.orders).values(
        [titleId, titleId, titleId, unpricedId].map((id, i) => ({
          ...org,
          dataSourceId: source!.id,
          externalId: `pv${i}`,
          rawTitle: "Pack",
          titleId: id,
          orderedAt: at,
          amountOre: 14_900,
          sourceHash: `pv${i}`,
        })),
      );
    });
  });

  it("1125 mot 112,50 behöver ett extra tryck; inget sparas före det", async () => {
    const first = await addPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId,
      unitCostOre: 112_500,
      validFrom: today,
      confirmed: false,
    });
    expect(first.ok).toBe(false);
    expect(isPriceDoubt(first)).toBe(true);
    if (isPriceDoubt(first)) {
      expect(first.doubt).toEqual({ kind: "higher", newOre: 112_500, refOre: 11_250 });
      expect(first.error).toContain("mycket mer än förra priset");
    }
    expect(await prices()).toEqual([{ ore: 11_250, day: "2026-01-01" }]);
  });

  it("118 kr mot 112,50 sparas direkt från i dag, och äldre försäljning behåller sitt pris", async () => {
    const res = await addPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId,
      unitCostOre: 11_800,
      validFrom: today,
      confirmed: false,
    });
    expect(res).toMatchObject({ ok: true, data: { mode: "inserted" } });
    expect(await prices()).toEqual([
      { ore: 11_250, day: "2026-01-01" },
      { ore: 11_800, day: today },
    ]);
  });

  it("efter det extra trycket sparas även ett konstigt pris", async () => {
    const res = await addPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId,
      unitCostOre: 112_500,
      validFrom: today,
      confirmed: true,
    });
    expect(res).toMatchObject({ ok: true, data: { mode: "replaced" } });
    expect((await prices()).at(-1)).toEqual({ ore: 112_500, day: today });
  });

  it("Rätta priset: över vad packet säljs för (149 kr) behöver ett extra tryck", async () => {
    const first = await correctPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId: unpricedId,
      unitCostOre: 16_000,
      today,
      confirmed: false,
    });
    expect(isPriceDoubt(first)).toBe(true);
    if (isPriceDoubt(first)) {
      expect(first.doubt).toEqual({ kind: "aboveSale", newOre: 16_000, refOre: 14_900 });
    }
    expect(await prices(unpricedId)).toEqual([]);
    const ok = await correctPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId: unpricedId,
      unitCostOre: 9_900,
      today,
      confirmed: false,
    });
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect((await prices(unpricedId)).map((p) => p.ore)).toEqual([9_900]);
  });

  it("utan confirmed (uträknade priser, t.ex. Mystery-kalkylen) körs ingen koll", async () => {
    const res = await addPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId: unpricedId,
      unitCostOre: 99_000,
      validFrom: today,
    });
    expect(res.ok).toBe(true);
  });
});
