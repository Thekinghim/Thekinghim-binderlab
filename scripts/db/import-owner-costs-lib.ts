/**
 * Läser titlar och priser för en organisation, planerar ägarens kostnader och skriver
 * dem (bara med apply). Allt i en transaktion: en konflikt eller ett fel skriver inget.
 * Planen och reglerna: src/app/(app)/inkopspriser/_lib/owner-costs.ts.
 * Används av import-owner-costs.ts och test/db/owner-costs.test.ts.
 */

import { sql } from "drizzle-orm";

import {
  planOwnerCosts,
  type KnownPrice,
  type KnownTitle,
  type OwnerCostFile,
  type OwnerCostPlan,
} from "../../src/app/(app)/inkopspriser/_lib/owner-costs";
import type { Db, Tx } from "../../src/db/client";
import type { IsoDate } from "../../src/domain";

export interface ImportOwnerCostsOptions {
  readonly organizationId: string;
  readonly apply: boolean;
  readonly confirmFlagged: boolean;
}

export interface ImportOwnerCostsResult {
  readonly plan: OwnerCostPlan;
  readonly applied: boolean;
  readonly written: number;
}

type Row = Record<string, unknown>;

async function loadTitles(tx: Tx, orgId: string): Promise<KnownTitle[]> {
  const result = await tx.execute(
    sql`select t.id, t.name,
               lower(btrim(regexp_replace(normalize(t.name, NFKC), '\\s+', ' ', 'g'))) as name_key,
               coalesce(array_agg(a.alias_normalized) filter (where a.id is not null), '{}') as keys
        from public.titles t
        left join public.title_aliases a
          on a.organization_id = t.organization_id and a.title_id = t.id
        where t.organization_id = ${orgId}::uuid and t.archived_at is null
        group by t.id, t.name
        order by t.name`,
  );
  return (Array.from(result) as Row[]).map((r) => ({
    titleId: String(r.id),
    titleName: String(r.name),
    keys: [String(r.name_key), ...((r.keys as string[] | null) ?? []).map(String)],
  }));
}

async function loadPrices(tx: Tx, orgId: string): Promise<KnownPrice[]> {
  const result = await tx.execute(
    sql`select pp.title_id, pp.valid_from::text as valid_from, pp.unit_cost_ore
        from public.purchase_prices pp
        where pp.organization_id = ${orgId}::uuid`,
  );
  return (Array.from(result) as Row[]).map((r) => ({
    titleId: String(r.title_id),
    validFrom: String(r.valid_from).slice(0, 10) as IsoDate,
    unitCostOre: Number(r.unit_cost_ore),
  }));
}

/** Organisationens id från slug eller id. Utan värde: den enda aktiva organisationen. */
export async function resolveOrganization(db: Db, wanted: string | undefined): Promise<string> {
  const result = await db.execute(
    sql`select id, slug from public.organizations where archived_at is null order by slug`,
  );
  const orgs = (Array.from(result) as Row[]).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
  }));
  if (wanted !== undefined) {
    const hit = orgs.find((o) => o.slug === wanted || o.id === wanted);
    if (!hit) throw new Error(`Organisationen ${wanted} finns inte.`);
    return hit.id;
  }
  if (orgs.length === 1 && orgs[0]) return orgs[0].id;
  throw new Error(
    `Ange --org <slug>. Finns: ${orgs.map((o) => o.slug).join(", ") || "inga organisationer"}.`,
  );
}

export async function importOwnerCosts(
  db: Db,
  file: OwnerCostFile,
  options: ImportOwnerCostsOptions,
): Promise<ImportOwnerCostsResult> {
  return db.transaction(async (tx) => {
    // Två körningar samtidigt får inte båda planera mot samma tomma läge.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('import-owner-costs:' || ${options.organizationId}))`,
    );
    const [titles, prices] = await Promise.all([
      loadTitles(tx, options.organizationId),
      loadPrices(tx, options.organizationId),
    ]);
    const plan = planOwnerCosts(file, titles, prices, { confirmFlagged: options.confirmFlagged });
    if (!options.apply || plan.blocked) return { plan, applied: false, written: 0 };

    let written = 0;
    for (const row of plan.rows) {
      if (row.kind !== "insert") continue;
      await tx.execute(
        sql`insert into public.purchase_prices
              (organization_id, title_id, unit_cost_ore, valid_from, note)
            values (${options.organizationId}::uuid, ${row.titleId}::uuid,
                    ${row.unitCostOre}, ${file.validFrom}::date, ${row.note})`,
      );
      written++;
    }
    return { plan, applied: true, written };
  });
}
