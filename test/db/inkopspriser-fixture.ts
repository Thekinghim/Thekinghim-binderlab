/**
 * En liten egen fixtur för Inköpspriser och Inställningar: bara det de testerna behöver
 * (titlar, priser, order, en stängd månad), så att de inte beror på den stora fixturen.
 *
 * Priser från 1 jan. 2025, order i mars 2025, december 2024 stängd. En tredje titel har
 * ett pris från 1 nov. 2024 som gäller in i den stängda månaden.
 */

import { sql } from "drizzle-orm";

import * as s from "../../src/db/schema";

import { asUser, createOrg, createUser, uniqueSuffix, type TestUser } from "./helpers";

export interface PriceFixture {
  orgId: string;
  owner: TestUser;
  titleId: string;
  secondTitleId: string;
  mergedTitleId: string;
  /** Titel vars enda pris (1 nov. 2024, 60 kr) gäller i den stängda december 2024. */
  closedTitleId: string;
}

export async function seedPriceFixture(): Promise<PriceFixture> {
  const owner = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Inköpspriser ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [title, secondTitle, duplicate, closedTitle] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster" },
        { ...org, name: "Surging Sparks Booster" },
        { ...org, name: "Pokemon 151 booster pack" },
        { ...org, name: "Paldean Fates Booster" },
      ])
      .returning();
    await tx.execute(sql`select public.merge_titles(${orgId}, ${duplicate!.id}, ${title!.id})`);
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: title!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
      { ...org, titleId: secondTitle!.id, unitCostOre: 5200, validFrom: "2025-01-01" },
      { ...org, titleId: closedTitle!.id, unitCostOre: 6000, validFrom: "2024-11-01" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    await tx.insert(s.orders).values(
      ["2025-03-10", "2025-03-10", "2025-03-11"].map((day, i) => ({
        ...org,
        dataSourceId: source!.id,
        externalId: `9${i}`,
        rawTitle: "Pokemon 151",
        titleId: title!.id,
        orderedAt: new Date(`${day}T10:00:00Z`),
        amountOre: 7900,
        sourceHash: `h${i}`,
      })),
    );
    await tx.execute(sql`select public.close_period(${orgId}, '2024-12-01'::date)`);
    return {
      orgId,
      owner,
      titleId: title!.id,
      secondTitleId: secondTitle!.id,
      mergedTitleId: duplicate!.id,
      closedTitleId: closedTitle!.id,
    };
  });
}
