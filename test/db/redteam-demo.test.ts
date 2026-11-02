/**
 * Oberoende granskning av demon (fas 7): försök att få demoverktygen att röra
 * en organisation som INTE är demon.
 *
 * resetDemo (npm run db:seed-demo -- --aterstall/--radera) litar bara på slug
 * och namn. Slug sätts i appen ur namnet (slugFromName), så vilken kund som helst
 * som döper sin organisation till "Nordljus (demo)" får slug "nordljus-demo" och
 * raderas helt (gallringsläget) när demon återställs.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { slugFromName } from "../../src/server/onboarding/create-organization";
import { resetDemo } from "../../src/seed/demo/run-demo-seed";
import { asUser, createUser, db, rows } from "./helpers";

describe("rödteam: demoåterställningen rör bara demon", () => {
  it("en kundorganisation som råkar heta 'Nordljus (demo)' raderas inte", async () => {
    const name = "Nordljus (demo)";
    const slug = slugFromName(name);
    expect(slug).toBe("nordljus-demo");

    // Samma väg som onboardingen: en vanlig användare skapar organisationen.
    const customer = await createUser();
    const [created] = await asUser(customer, (tx) =>
      rows<{ id: string }>(tx, sql`select public.create_organization(${name}, ${slug}) as id`),
    );
    const orgId = created?.id;
    expect(orgId).toBeTruthy();
    await asUser(customer, (tx) =>
      tx.execute(
        sql`insert into public.stores (organization_id, name) values (${orgId}::uuid, 'Kundens butik')`,
      ),
    );

    // Återställningen ska vägra: kunden är inte demons ägare.
    await expect(resetDemo(db(), slug)).rejects.toThrow();

    const left = await rows(
      db(),
      sql`select 1 from public.organizations where id = ${orgId}::uuid`,
    );
    expect(left).toHaveLength(1);
  });
});
