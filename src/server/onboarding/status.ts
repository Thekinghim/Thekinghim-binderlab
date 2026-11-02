/**
 * Läser fakta för Kom igång under RLS, utan beroende på Next (användaren skickas in).
 * Testas mot testdatabasen i test/db/onboarding-*.test.ts; ./index.ts kopplar ihop
 * funktionen med sessionen.
 *
 * Rollen kontrolleras mot databasen (requireRoleFor) innan något läses: ägare, admin och
 * läsare. Påfyllaren ser inga belopp och får AuthorizationError("forbidden"); steget med
 * inköpspriser kräver intäkten.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";
import { requireRoleFor, withUserDbFor, type SessionUser } from "@/server/access";

import {
  buildOnboardingStatus,
  type OnboardingFacts,
  type OnboardingStatus,
  type RevenueGroup,
  type TimedPrice,
} from "./model";

/** Roller som ser checklistan (den räknar på intäkten). */
export const ONBOARDING_ROLES = [
  "owner",
  "admin",
  "viewer",
] as const satisfies readonly MemberRole[];

type Row = Record<string, unknown>;

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return Array.from(await tx.execute(query)) as Row[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Datumkolumnerna läses som text ('ÅÅÅÅ-MM-DD'), aldrig som Date. */
function day(value: unknown): string {
  return String(value).slice(0, 10);
}

function int(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Fakta för organisationen, läst som användaren (RLS). */
export async function queryOnboardingFacts(tx: Tx, orgId: string): Promise<OnboardingFacts> {
  const org = sql`${orgId}::uuid`;
  const [summary] = await rows(
    tx,
    sql`select
          o.name,
          o.created_at,
          (select count(*) from public.stores s
            where s.organization_id = o.id and s.archived_at is null) as stores,
          (select min(s.created_at) from public.stores s
            where s.organization_id = o.id and s.archived_at is null) as stores_at,
          (select count(*) from public.store_agreements sa
            where sa.organization_id = o.id) as agreements,
          (select min(sa.created_at) from public.store_agreements sa
            where sa.organization_id = o.id) as agreements_at,
          (select s.id from public.stores s
            where s.organization_id = o.id and s.archived_at is null
            order by (exists (select 1 from public.store_agreements sa
                              where sa.organization_id = s.organization_id
                                and sa.store_id = s.id)),
                     s.created_at, s.id
            limit 1) as agreement_target,
          (select count(*) from public.machines m
            where m.organization_id = o.id and m.archived_at is null) as machines,
          (select min(m.created_at) from public.machines m
            where m.organization_id = o.id and m.archived_at is null) as machines_at,
          (select count(distinct mp.machine_id) from public.machine_placements mp
            join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
            where mp.organization_id = o.id and m.archived_at is null
              and mp.valid_from <= (now() at time zone o.timezone)::date
              and (mp.valid_to is null or mp.valid_to >= (now() at time zone o.timezone)::date)
          ) as placed,
          (select count(*) from public.data_sources ds
            where ds.organization_id = o.id and ds.archived_at is null) as sources,
          (select min(ds.created_at) from public.data_sources ds
            where ds.organization_id = o.id and ds.archived_at is null) as sources_at,
          (select count(*) from public.orders x where x.organization_id = o.id) as orders,
          coalesce(st.vat_rate_bp, 0) as vat_rate_bp
        from public.organizations o
        left join public.organization_settings st on st.organization_id = o.id
        where o.id = ${org}`,
  );
  if (!summary) throw new Error("Organisationen finns inte.");

  const [imports] = await rows(
    tx,
    sql`select count(*) as n, min(coalesce(i.finished_at, i.created_at)) as first_at
        from public.imports i
        where i.organization_id = ${org}
          and exists (select 1 from public.orders x
                      where x.organization_id = i.organization_id and x.import_id = i.id)`,
  );

  // Intäkten grupperad per titel, dag och belopp: få rader även med många order.
  const revenue = await rows(
    tx,
    sql`select x.title_id, x.business_date::text as business_date, x.amount_ore, count(*) as n
        from public.orders x
        where x.organization_id = ${org}
        group by x.title_id, x.business_date, x.amount_ore`,
  );

  const prices = await rows(
    tx,
    sql`select pp.title_id, pp.unit_cost_ore, pp.valid_from::text as valid_from, pp.created_at
        from public.purchase_prices pp
        where pp.organization_id = ${org}`,
  );

  return {
    organization: { name: String(summary.name), createdAt: iso(summary.created_at)! },
    stores: { count: int(summary.stores), firstAt: iso(summary.stores_at) },
    agreements: {
      count: int(summary.agreements),
      firstAt: iso(summary.agreements_at),
      targetStoreId: typeof summary.agreement_target === "string" ? summary.agreement_target : null,
    },
    machines: {
      count: int(summary.machines),
      firstAt: iso(summary.machines_at),
      placed: int(summary.placed),
    },
    dataSources: { count: int(summary.sources), firstAt: iso(summary.sources_at) },
    imports: {
      withOrders: int(imports?.n),
      firstAt: iso(imports?.first_at),
      orders: int(summary.orders),
    },
    revenue: revenue.map((r): RevenueGroup => ({
      titleId: typeof r.title_id === "string" ? r.title_id : null,
      businessDate: day(r.business_date),
      amountOre: int(r.amount_ore),
      orders: int(r.n),
    })),
    prices: prices.map((r): TimedPrice => ({
      titleId: String(r.title_id),
      unitCostOre: int(r.unit_cost_ore),
      validFrom: day(r.valid_from),
      createdAt: iso(r.created_at)!,
    })),
    vatRateBp: int(summary.vat_rate_bp),
  };
}

/**
 * Checklistan för organisationen. Kräver rollen ägare, admin eller läsare (läst ur
 * databasen); kastar annars AuthorizationError("forbidden").
 */
export async function loadOnboardingStatusFor(
  user: SessionUser,
  organizationId: string,
  now: Date = new Date(),
): Promise<OnboardingStatus> {
  await requireRoleFor(user, organizationId, ONBOARDING_ROLES);
  const facts = await withUserDbFor(user, (tx) => queryOnboardingFacts(tx, organizationId));
  return buildOnboardingStatus(organizationId, facts, now);
}
