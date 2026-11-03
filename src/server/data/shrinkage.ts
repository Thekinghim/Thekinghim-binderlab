/**
 * Svinnkontroll (@/analytics/shrinkage): summorna per automat och titel för en period,
 * räknade i databasen ur lagerhändelserna (stock_events) på automaternas platser.
 *
 * Per automat och titel läses händelserna från senaste räkningen före perioden (eller från
 * början) till periodens slut. Varje räkning ('count') startar ett nytt avsnitt; saldot i
 * slutet av ett avsnitt är räkningens antal + övriga händelser i avsnittet (samma regel som
 * vyn stock_levels). Avvikelsen för en räkning i perioden är dess antal − saldot i slutet av
 * avsnittet före. Ett avsnitt utan räkning (före första räkningen) har okänt saldo och
 * jämförs inte. Perioden gäller affärsdatum (business_date, organisationens tidszon).
 *
 * Läses som användaren under RLS. Bara roller som ser ekonomi (inköpspriset är ekonomi).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { ShrinkageAggregate } from "@/analytics/shrinkage";
import type { Tx } from "@/db/client";
import type { Period } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";

import type { Viewer } from "./core/loaders";
import { ECONOMY_ROLES } from "./core/types";

type Row = Record<string, unknown>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** Summorna per automat och titel (rader med rörelse eller räkning i perioden). */
export async function queryShrinkage(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<ShrinkageAggregate[]> {
  const rows = Array.from(
    await tx.execute(sql`
      with loc as (
        select l.id as location_id, l.machine_id
        from public.stock_locations l
        where l.organization_id = ${orgId}::uuid and l.kind = 'machine'
      ),
      pairs as (
        select distinct e.location_id, e.title_id
        from public.stock_events e
        join loc on loc.location_id = e.location_id
        where e.organization_id = ${orgId}::uuid
          and e.business_date between ${period.start}::date and ${period.end}::date
      ),
      base as (
        select p.location_id, p.title_id, lc.occurred_at as base_at, lc.seq as base_seq
        from pairs p
        left join lateral (
          select c.occurred_at, c.seq
          from public.stock_events c
          where c.organization_id = ${orgId}::uuid and c.location_id = p.location_id
            and c.title_id = p.title_id and c.kind = 'count'
            and c.business_date < ${period.start}::date
          order by c.occurred_at desc, c.seq desc
          limit 1
        ) lc on true
      ),
      ev as (
        select e.location_id, e.title_id, e.kind, e.quantity,
               e.business_date >= ${period.start}::date as in_period,
               count(*) filter (where e.kind = 'count') over (
                 partition by e.location_id, e.title_id
                 order by e.occurred_at, e.seq
                 rows between unbounded preceding and current row
               ) as seg
        from base b
        join public.stock_events e
          on e.organization_id = ${orgId}::uuid
         and e.location_id = b.location_id and e.title_id = b.title_id
         and (b.base_at is null or (e.occurred_at, e.seq) >= (b.base_at, b.base_seq))
         and e.business_date <= ${period.end}::date
      ),
      segs as (
        select location_id, title_id, seg,
               max(quantity) filter (where kind = 'count') as start_qty,
               bool_or(kind = 'count' and in_period) as count_in_period,
               coalesce(sum(quantity) filter (where kind <> 'count'), 0) as flow,
               coalesce(sum(quantity) filter (where kind <> 'count' and not in_period), 0)
                 as flow_before
        from ev
        group by location_id, title_id, seg
      ),
      dev as (
        select s.location_id, s.title_id,
               sum(s.start_qty - (p.start_qty + p.flow))::int as deviation,
               count(*)::int as compared
        from segs s
        join segs p
          on p.location_id = s.location_id and p.title_id = s.title_id and p.seg = s.seg - 1
        where s.count_in_period and p.start_qty is not null
        group by s.location_id, s.title_id
      ),
      flows as (
        select location_id, title_id,
               coalesce(sum(quantity) filter (where kind in ('refill', 'transfer_in')), 0)::int
                 as refilled,
               coalesce(-sum(quantity) filter (where kind = 'sale'), 0)::int as sold,
               coalesce(-sum(quantity) filter (where kind in ('waste', 'transfer_out')), 0)::int
                 as removed,
               coalesce(sum(quantity) filter (where kind = 'adjustment'), 0)::int as adjusted
        from ev
        where in_period
        group by location_id, title_id
      ),
      opening as (
        select location_id, title_id, (start_qty + flow_before)::int as opening
        from segs
        where seg = 1 and not count_in_period and start_qty is not null
      ),
      closing as (
        select distinct on (location_id, title_id) location_id, title_id,
               case when start_qty is null then null else (start_qty + flow)::int end as closing
        from segs
        order by location_id, title_id, seg desc
      )
      select loc.machine_id, f.title_id, f.refilled, f.sold, f.removed, f.adjusted,
             d.deviation, coalesce(d.compared, 0) as compared, o.opening, c.closing,
             pp.unit_cost_ore
      from flows f
      join loc on loc.location_id = f.location_id
      left join dev d on d.location_id = f.location_id and d.title_id = f.title_id
      left join opening o on o.location_id = f.location_id and o.title_id = f.title_id
      left join closing c on c.location_id = f.location_id and c.title_id = f.title_id
      left join lateral (
        select p.unit_cost_ore
        from public.purchase_price_periods p
        where p.organization_id = ${orgId}::uuid and p.title_id = f.title_id
          and p.valid_from <= ${period.end}::date
          and (p.valid_to is null or p.valid_to >= ${period.end}::date)
        order by p.valid_from desc
        limit 1
      ) pp on true
    `),
  ) as Row[];
  return rows.map((r) => ({
    machineId: String(r.machine_id),
    titleId: String(r.title_id),
    refilled: num(r.refilled),
    sold: num(r.sold),
    removed: num(r.removed),
    adjusted: num(r.adjusted),
    deviation: numOrNull(r.deviation),
    compared: num(r.compared),
    opening: numOrNull(r.opening),
    closing: numOrNull(r.closing),
    unitCostOre: numOrNull(r.unit_cost_ore),
  }));
}

/** Svinnkontrollens summor som användaren (ägare, admin, läsare). */
export async function loadShrinkageFor(
  viewer: Viewer,
  period: Period,
): Promise<ShrinkageAggregate[]> {
  await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, (tx) => queryShrinkage(tx, viewer.organization.id, period));
}
