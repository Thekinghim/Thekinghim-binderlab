/**
 * Läser fakta för Startklar (./machine-ready.ts) under RLS, utan beroende på Next.
 * Testas mot testdatabasen i test/db/r2-t6-startklar.test.ts.
 *
 * Ägare, admin och läsare (stegen läser inköpspriser och automatens kostnad). Andra roller
 * får en tom lista, så att sidor kan anropa laddaren utan att först fråga efter rollen.
 * Avvecklade och arkiverade automater är inte med.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import { isIsoDate, type IsoDate } from "@/domain";
import {
  AuthorizationError,
  isUuid,
  requireRoleFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";
import { queryAgreements } from "@/server/data/core/queries";

import {
  machineReadiness,
  type MachineReadiness,
  type MachineReadyFacts,
  type ReadyTitle,
} from "./machine-ready";
import { ONBOARDING_ROLES } from "./status";

type Row = Record<string, unknown>;

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return Array.from(await tx.execute(query)) as Row[];
}

function dayOrNull(v: unknown): IsoDate | null {
  if (v === null || v === undefined) return null;
  const s = String(v).slice(0, 10);
  return isIsoDate(s) ? s : null;
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Fakta per automat i drift (eller planerad), äldsta först. */
export async function queryMachineReadyFacts(tx: Tx, orgId: string): Promise<MachineReadyFacts[]> {
  const org = sql`${orgId}::uuid`;
  const machines = await rows(
    tx,
    sql`with t as (
          select (now() at time zone o.timezone)::date as today
          from public.organizations o where o.id = ${org}
        )
        select m.id, m.code, t.today::text as today,
               pl.store_id, pl.store_name, pl.valid_from::text as placed_from,
               loc.awish_synced_at,
               -- Bara den direkta Awish-kopplingen läser facken (syncSourceStock). En automat
               -- som bara finns i importerade filer får aldrig facken lästa: där läggs lagret
               -- in för hand, och listan ska inte säga "inom några minuter" för alltid.
               (loc.awish_synced_at is not null or exists (
                  select 1 from public.source_machines sm
                  join public.data_sources ds
                    on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
                  where sm.organization_id = m.organization_id and sm.machine_id = m.id
                    and ds.provider = 'awish_grpc' and ds.archived_at is null)) as awish,
               (select coalesce(sum(i.amount_ore), 0) from public.machine_investments i
                 where i.organization_id = m.organization_id and i.machine_id = m.id) as investment_ore,
               (select min(o.business_date)::text from public.orders o
                 where o.organization_id = m.organization_id and o.machine_id = m.id) as first_order
        from public.machines m
        cross join t
        left join lateral (
          select mp.store_id, s.name as store_name, mp.valid_from
          from public.machine_placements mp
          join public.stores s on s.organization_id = mp.organization_id and s.id = mp.store_id
          where mp.organization_id = m.organization_id and mp.machine_id = m.id
            and s.archived_at is null
            and (mp.valid_to is null or mp.valid_to >= t.today)
          order by mp.valid_from
          limit 1
        ) pl on true
        left join public.stock_locations loc
          on loc.organization_id = m.organization_id and loc.machine_id = m.id
         and loc.kind = 'machine'
        where m.organization_id = ${org} and m.archived_at is null
          and (m.active_to is null or m.active_to >= t.today)
        order by m.created_at, m.code`,
  );
  if (machines.length === 0) return [];

  // Titlarna i automaten: saldo över 0, eller ett fack i Awish (kapacitet).
  const titleRows = await rows(
    tx,
    sql`with t as (
          select (now() at time zone o.timezone)::date as today
          from public.organizations o where o.id = ${org}
        ),
        inside as (
          select loc.machine_id, sl.title_id
          from public.stock_levels sl
          join public.stock_locations loc
            on loc.organization_id = sl.organization_id and loc.id = sl.location_id
          where sl.organization_id = ${org} and loc.kind = 'machine' and sl.quantity > 0
          union
          select c.machine_id, c.title_id
          from public.machine_slot_capacity c
          where c.organization_id = ${org}
        )
        select i.machine_id, i.title_id, ti.name,
               exists (select 1 from public.machine_slot_capacity c
                       where c.organization_id = ${org} and c.machine_id = i.machine_id
                         and c.title_id = i.title_id) as has_capacity,
               exists (select 1 from public.purchase_prices pp, t
                       where pp.organization_id = ${org} and pp.title_id = i.title_id
                         and pp.valid_from <= t.today) as has_price
        from inside i
        join public.titles ti on ti.organization_id = ${org} and ti.id = i.title_id
        order by ti.name`,
  );
  const titles = new Map<string, ReadyTitle[]>();
  for (const r of titleRows) {
    const list = titles.get(String(r.machine_id)) ?? [];
    list.push({
      id: String(r.title_id),
      name: String(r.name),
      hasCapacity: r.has_capacity === true,
      hasPrice: r.has_price === true,
    });
    titles.set(String(r.machine_id), list);
  }

  const agreements = await queryAgreements(tx, orgId);
  return machines.map((m): MachineReadyFacts => {
    const storeId = typeof m.store_id === "string" ? m.store_id : null;
    const from = dayOrNull(m.placed_from);
    const today = dayOrNull(m.today);
    if (!today) throw new Error("Dagens datum kunde inte läsas.");
    return {
      machineId: String(m.id),
      code: String(m.code),
      today,
      store: storeId && from ? { id: storeId, name: String(m.store_name ?? ""), from } : null,
      agreements: storeId ? agreements.filter((a) => a.storeId === storeId) : [],
      awish: m.awish === true,
      slotsReadAt: isoOrNull(m.awish_synced_at),
      titles: titles.get(String(m.id)) ?? [],
      investmentOre: Number(m.investment_ore ?? 0),
      firstOrderDate: dayOrNull(m.first_order),
    };
  });
}

/**
 * Startklar-listan per automat (även de som är klara: `complete`). Tom för roller som inte
 * ser den (påfyllaren) och för ett id som inte är en organisation användaren är med i.
 */
export async function loadMachineReadinessFor(
  user: SessionUser,
  organizationId: string,
): Promise<MachineReadiness[]> {
  if (!isUuid(organizationId)) return [];
  try {
    await requireRoleFor(user, organizationId, ONBOARDING_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) return [];
    throw error;
  }
  const facts = await withUserDbFor(user, (tx) => queryMachineReadyFacts(tx, organizationId));
  return facts.map(machineReadiness);
}

/**
 * Som loadMachineReadinessFor, men ett fel stoppar inte sidan: då visas ingen lista.
 * Det är den här som Att göra kopplar in (bredvid "Ny automat hittad").
 */
export function loadMachineReadinessSafe(
  user: SessionUser,
  organizationId: string,
): Promise<MachineReadiness[]> {
  return loadMachineReadinessFor(user, organizationId).catch((error: unknown) => {
    console.error("[startklar] Listan kunde inte läsas:", error);
    return [];
  });
}
