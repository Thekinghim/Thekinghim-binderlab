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
import {
  AuthorizationError,
  isUuid,
  requireRoleFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";

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
  // "I dag" i organisationens tidszon: avtal och placeringar som gäller i dag eller
  // senare räknas, de som har löpt ut gör det inte.
  const today = sql`(now() at time zone o.timezone)::date`;
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
            join public.stores s on s.organization_id = sa.organization_id and s.id = sa.store_id
            where sa.organization_id = o.id and s.archived_at is null
              and (sa.valid_to is null or sa.valid_to >= ${today})) as agreements,
          (select min(sa.created_at) from public.store_agreements sa
            join public.stores s on s.organization_id = sa.organization_id and s.id = sa.store_id
            where sa.organization_id = o.id and s.archived_at is null
              and (sa.valid_to is null or sa.valid_to >= ${today})) as agreements_at,
          (select s.id from public.stores s
            where s.organization_id = o.id and s.archived_at is null
            order by (exists (select 1 from public.store_agreements sa
                              where sa.organization_id = s.organization_id
                                and sa.store_id = s.id
                                and (sa.valid_to is null or sa.valid_to >= ${today}))),
                     s.created_at, s.id
            limit 1) as agreement_target,
          (select count(*) from public.machines m
            where m.organization_id = o.id and m.archived_at is null) as machines,
          (select min(m.created_at) from public.machines m
            where m.organization_id = o.id and m.archived_at is null) as machines_at,
          (select count(distinct mp.machine_id) from public.machine_placements mp
            join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
            join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
            where mp.organization_id = o.id and m.archived_at is null and s.archived_at is null
              and mp.valid_from <= ${today}
              and (mp.valid_to is null or mp.valid_to >= ${today})
          ) as placed,
          (select count(distinct mp.machine_id) from public.machine_placements mp
            join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
            join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
            where mp.organization_id = o.id and m.archived_at is null and s.archived_at is null
              and (mp.valid_to is null or mp.valid_to >= ${today})
          ) as placed_or_planned,
          (select min(mp.created_at) from public.machine_placements mp
            join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
            join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
            where mp.organization_id = o.id and m.archived_at is null and s.archived_at is null
              and (mp.valid_to is null or mp.valid_to >= ${today})
          ) as placed_at,
          (select m.code from public.machines m
            where m.organization_id = o.id and m.archived_at is null
              and not exists (
                select 1 from public.machine_placements mp
                join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
                where mp.organization_id = m.organization_id and mp.machine_id = m.id
                  and s.archived_at is null
                  and (mp.valid_to is null or mp.valid_to >= ${today}))
            order by m.created_at, m.code
            limit 1) as unplaced_code,
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
        join public.data_sources ds
          on ds.organization_id = i.organization_id and ds.id = i.data_source_id
        where i.organization_id = ${org}
          and ds.archived_at is null
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
      placedOrPlanned: int(summary.placed_or_planned),
      placedAt: iso(summary.placed_at),
      unplacedCode: typeof summary.unplaced_code === "string" ? summary.unplaced_code : null,
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
  // Ett id som inte är en uuid är ingen organisation användaren är med i.
  if (!isUuid(organizationId)) throw new AuthorizationError("forbidden");
  await requireRoleFor(user, organizationId, ONBOARDING_ROLES);
  const facts = await withUserDbFor(user, (tx) => queryOnboardingFacts(tx, organizationId));
  return buildOnboardingStatus(organizationId, facts, now);
}
