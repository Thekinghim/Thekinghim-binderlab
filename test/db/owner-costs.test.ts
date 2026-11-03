/**
 * Ägarens inköpskostnader: import-skriptets kärna (scripts/db/import-owner-costs-lib.ts)
 * mot testdatabasen med den riktiga datafilen.
 */

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { importOwnerCosts, resolveOrganization } from "../../scripts/db/import-owner-costs-lib";
import { parseOwnerCostFile } from "../../src/app/(app)/inkopspriser/_lib/owner-costs";
import * as s from "../../src/db/schema";
import { asUser, createOrg, createUser, db, rows, settle, uniqueSuffix } from "./helpers";

const file = parseOwnerCostFile(
  JSON.parse(
    readFileSync(
      new URL("../../scripts/db/data/owner-costs-2026-10-15.json", import.meta.url),
      "utf8",
    ),
  ) as unknown,
);

interface Org {
  orgId: string;
  slug: string;
  ids: Record<string, string>;
}

async function seedOrg(): Promise<Org> {
  const owner = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Kostnader ${uniqueSuffix()}`);
  const ids = await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const names = [
      "White Flair",
      "Black bolt",
      "Destin Rivals",
      "Mystery pack premium",
      "30th Celebration",
      "Surging Sparks",
      "PF Booster",
      "Paldea Evolved",
    ];
    const inserted = await tx
      .insert(s.titles)
      .values(names.map((name) => ({ ...org, name })))
      .returning();
    const byName = Object.fromEntries(inserted.map((t) => [t.name, t.id]));
    await tx.insert(s.titleAliases).values({
      ...org,
      titleId: byName["PF Booster"]!,
      alias: "phantasmal   FLAMES",
    });
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: byName["30th Celebration"]!, unitCostOre: 10500, validFrom: "2026-10-13" },
      { ...org, titleId: byName["30th Celebration"]!, unitCostOre: 11200, validFrom: "2026-10-27" },
      { ...org, titleId: byName["Surging Sparks"]!, unitCostOre: 9000, validFrom: "2026-10-15" },
    ]);
    return byName as Record<string, string>;
  });
  const [org] = await rows<{ slug: string }>(
    db(),
    sql`select slug from public.organizations where id = ${orgId}::uuid`,
  );
  return { orgId, slug: org!.slug, ids };
}

async function snapshot(orgId: string) {
  return rows<{ title: string; valid_from: string; unit_cost_ore: string }>(
    db(),
    sql`select t.name as title, pp.valid_from::text as valid_from, pp.unit_cost_ore::text
        from public.purchase_prices pp join public.titles t on t.id = pp.title_id
        where pp.organization_id = ${orgId}::uuid
        order by t.name, pp.valid_from`,
  );
}

async function auditCount(orgId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    db(),
    sql`select count(*)::int as n from public.audit_log
        where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'`,
  );
  return r!.n;
}

let org: Org;

beforeAll(async () => {
  org = await seedOrg();
});

describe("importOwnerCosts", () => {
  it("torrkörningen ändrar ingenting", async () => {
    const before = await snapshot(org.orgId);
    const audits = await auditCount(org.orgId);
    const result = await importOwnerCosts(db(), file, {
      organizationId: org.orgId,
      apply: false,
      confirmFlagged: false,
    });
    expect(result.applied).toBe(false);
    expect(result.plan.rows.filter((r) => r.kind === "insert").length).toBeGreaterThan(0);
    expect(await snapshot(org.orgId)).toEqual(before);
    expect(await auditCount(org.orgId)).toBe(audits);
  });

  it("--apply skriver matchade kostnader, och en andra körning ger samma resultat", async () => {
    const first = await importOwnerCosts(db(), file, {
      organizationId: org.orgId,
      apply: true,
      confirmFlagged: false,
    });
    expect(first.applied).toBe(true);
    // White Flair, Destined Rivals (alias), Phantasmal Flames (alias), 30th Celebration.
    expect(first.written).toBe(4);
    const kinds = Object.fromEntries(first.plan.rows.map((r) => [r.entry, r.kind]));
    expect(kinds["Black Bolt"]).toBe("flagged");
    expect(kinds["Surging Sparks"]).toBe("unchanged");
    expect(kinds["Mystery Pack Premium"]).toBe("missing");
    expect(kinds["Scarlet & Violet 151"]).toBe("unmatched");
    expect(first.plan.uncoveredTitles).toEqual(["Paldea Evolved"]);

    const after = await snapshot(org.orgId);
    expect(after).toContainEqual({
      title: "Destin Rivals",
      valid_from: "2026-10-15",
      unit_cost_ore: "8000",
    });
    expect(after).toContainEqual({
      title: "PF Booster",
      valid_from: "2026-10-15",
      unit_cost_ore: "12000",
    });
    // Det senare priset för 30th Celebration står kvar.
    expect(after.filter((p) => p.title === "30th Celebration").map((p) => p.unit_cost_ore)).toEqual(
      ["10500", "13300", "11200"],
    );
    const [note] = await rows<{ note: string }>(
      db(),
      sql`select note from public.purchase_prices
          where title_id = ${org.ids["30th Celebration"]!}::uuid and valid_from = '2026-10-15'`,
    );
    expect(note!.note).toContain("Äldre uppgift, bekräfta");

    const audits = await auditCount(org.orgId);
    const second = await importOwnerCosts(db(), file, {
      organizationId: org.orgId,
      apply: true,
      confirmFlagged: false,
    });
    expect(second.written).toBe(0);
    expect(await snapshot(org.orgId)).toEqual(after);
    expect(await auditCount(org.orgId)).toBe(audits);
  });

  it("flaggade rader skrivs bara med --confirm-flagged", async () => {
    const result = await importOwnerCosts(db(), file, {
      organizationId: org.orgId,
      apply: true,
      confirmFlagged: true,
    });
    expect(result.written).toBe(1);
    expect(await snapshot(org.orgId)).toContainEqual({
      title: "Black bolt",
      valid_from: "2026-10-15",
      unit_cost_ore: "16000",
    });
  });

  it("ett annat pris samma datum stoppar hela körningen", async () => {
    const other = await seedOrg();
    await db().insert(s.purchasePrices).values({
      organizationId: other.orgId,
      titleId: other.ids["White Flair"]!,
      unitCostOre: 14000,
      validFrom: "2026-10-15",
    });
    const before = await snapshot(other.orgId);
    const result = await importOwnerCosts(db(), file, {
      organizationId: other.orgId,
      apply: true,
      confirmFlagged: true,
    });
    expect(result.plan.blocked).toBe(true);
    expect(result.applied).toBe(false);
    expect(await snapshot(other.orgId)).toEqual(before);
  });

  it("databasen stoppar två priser samma datum för en titel", async () => {
    const outcome = await settle(
      db().insert(s.purchasePrices).values({
        organizationId: org.orgId,
        titleId: org.ids["White Flair"]!,
        unitCostOre: 1,
        validFrom: "2026-10-15",
      }),
    );
    expect(outcome.code).toBe("23505");
  });

  it("organisationen väljs med slug, och krävs när det finns flera", async () => {
    expect(await resolveOrganization(db(), org.slug)).toBe(org.orgId);
    await expect(resolveOrganization(db(), "finns-inte")).rejects.toThrow(/finns inte/);
    await expect(resolveOrganization(db(), undefined)).rejects.toThrow(/--org/);
  });
});
