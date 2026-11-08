/**
 * Kontroll 2–6, inläsningen. Bara select, alltid med organization_id. Körs som systemrollen
 * (getServiceDb) med organisationen ur det schemalagda jobbet eller en kontrollerad
 * session, aldrig ur indata. Rena bedömningar: @/analytics/self-check.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type {
  AwishMachineRead,
  HygieneInput,
  PushRow,
  RefillRow,
  SyncSourceState,
} from "@/analytics/self-check";
import { REFILL_WINDOW_HOURS } from "@/analytics/self-check";
import type { Db } from "@/db/client";
import { agreementGaps, type IsoDate, type Period } from "@/domain";
import { awishExpiryNotice } from "@/server/awish/expiry";
import { mysteryBatchSql } from "@/server/data/core/queries";
import { parseState } from "@/server/awish/sync";

type Row = Record<string, unknown>;

async function rows<T extends Row>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// 2. Awish = appen
// ---------------------------------------------------------------------------

/**
 * Senaste läsningen per kopplad automat och titlarna i den, med appens saldo nu och
 * appens ändringar efter läsningen. "Efter läsningen" = händelser som räknas i saldot
 * (efter senaste inventeringen, som stock_levels) och som hände eller sparades efter
 * läsningen; inventeringarna från Awish (själva läsningen) räknas inte.
 */
export async function queryAwishReads(db: Db, orgId: string): Promise<AwishMachineRead[]> {
  const list = await rows<{
    machine_id: string;
    label: string;
    read_at: unknown;
    title_id: string | null;
    title_name: string | null;
    units: number | null;
    app: number | null;
    changed: number | string | null;
    counted_since: boolean | null;
    mystery_batch: number | null;
  }>(
    db,
    sql`with loc as (
          select l.id, l.machine_id, l.awish_synced_at, l.awish_fill,
                 coalesce(nullif(m.code, ''), m.name) as label
          from public.stock_locations l
          join public.machines m on m.organization_id = l.organization_id and m.id = l.machine_id
          where l.organization_id = ${orgId}::uuid and l.machine_id is not null
            and l.archived_at is null and m.archived_at is null
            and exists (select 1 from public.source_machines sm
                        join public.data_sources ds
                          on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
                        where sm.organization_id = l.organization_id and sm.machine_id = l.machine_id
                          and ds.provider = 'awish_grpc' and ds.archived_at is null)
        ),
        fill as (
          select loc.*, (f ->> 'title_id')::uuid as title_id,
                 coalesce((f ->> 'units')::int, 0) as units,
                 coalesce((f ->> 'channels')::int, 0) as channels
          from loc
          left join lateral jsonb_array_elements(coalesce(loc.awish_fill, '[]'::jsonb)) f on true
        )
        select f.machine_id, f.label, f.awish_synced_at as read_at, f.title_id,
               t.name as title_name, f.units, sl.quantity as app,
               (select coalesce(sum(e.quantity), 0)
                  from public.stock_events e
                  where e.organization_id = ${orgId}::uuid and e.location_id = f.id
                    and e.title_id = f.title_id and e.kind <> 'count'
                    and (sl.last_counted_at is null or e.occurred_at > sl.last_counted_at)
                    and (e.occurred_at > f.awish_synced_at or e.created_at > f.awish_synced_at)
               ) as changed,
               (sl.last_counted_at > f.awish_synced_at) as counted_since,
               ${mysteryBatchSql("t")} as mystery_batch
        from fill f
        left join public.titles t on t.organization_id = ${orgId}::uuid and t.id = f.title_id
        left join public.stock_levels sl
          on sl.organization_id = ${orgId}::uuid and sl.location_id = f.id and sl.title_id = f.title_id
        where f.title_id is null or f.channels > 0
        order by f.label, t.name`,
  );
  const byMachine = new Map<
    string,
    AwishMachineRead & { titles: AwishMachineRead["titles"][number][] }
  >();
  for (const r of list) {
    let m = byMachine.get(r.machine_id);
    if (!m) {
      m = { machineId: r.machine_id, label: r.label, readAt: iso(r.read_at), titles: [] };
      byMachine.set(r.machine_id, m);
    }
    if (!r.title_id) continue;
    m.titles.push({
      titleId: r.title_id,
      titleName: r.title_name ?? "Okänd titel",
      awishUnits: Number(r.units ?? 0),
      appUnits: r.app === null ? null : Number(r.app),
      changedSince: Number(r.changed ?? 0),
      countedSince: r.counted_since === true,
      ...(r.mystery_batch === null ? {} : { mysteryBatchSize: Number(r.mystery_batch) }),
    });
  }
  return [...byMachine.values()];
}

// ---------------------------------------------------------------------------
// 3. Påfyllningar nådde Awish
// ---------------------------------------------------------------------------

export interface RefillData {
  readonly pushConfigured: boolean;
  readonly refills: RefillRow[];
  readonly pushes: PushRow[];
}

/** Påfyllningarna i appen det senaste dygnet och de lyckade pusharna till Awish. */
export async function queryRefillPushes(db: Db, orgId: string, now: Date): Promise<RefillData> {
  const since = new Date(now.getTime() - REFILL_WINDOW_HOURS * 3_600_000).toISOString();
  const [source] = await rows<{ enabled: boolean }>(
    db,
    sql`select coalesce((ds.config -> 'awishWeb' ->> 'enabled')::boolean, false)
               and coalesce((ds.config -> 'awishWeb' ->> 'hasPassword')::boolean, false) as enabled
        from public.data_sources ds
        where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
          and ds.archived_at is null and ds.status <> 'paused'
        order by ds.created_at asc
        limit 1`,
  );
  const pushConfigured = source?.enabled === true;
  if (!pushConfigured) return { pushConfigured, refills: [], pushes: [] };
  const refillRows = await rows<{
    id: string;
    machine_id: string;
    label: string;
    title_name: string | null;
    quantity: number;
    at: unknown;
    linked: boolean;
    undone: boolean;
    no_slot: boolean;
    confirmed: boolean | null;
    mystery_batch: number | null;
    before: number | string | null;
  }>(
    db,
    sql`select e.id, l.machine_id, coalesce(nullif(m.code, ''), m.name) as label,
               t.name as title_name, e.quantity, e.created_at as at,
               exists (select 1 from public.source_machines sm
                       join public.data_sources ds
                         on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
                       where sm.organization_id = e.organization_id and sm.machine_id = l.machine_id
                         and ds.provider = 'awish_grpc' and ds.archived_at is null
                         and sm.external_id ~ '^[0-9]{1,30}$') as linked,
               exists (select 1 from public.field_submissions f
                       where f.organization_id = e.organization_id and f.stock_event_id = e.id
                         and f.undone_at is not null) as undone,
               (l.awish_fill is not null and not exists (
                  select 1 from jsonb_array_elements(l.awish_fill) x
                  where (x ->> 'title_id')::uuid = e.title_id)) as no_slot,
               -- Awish lästes efter påfyllningen och visade då appens saldo för titeln (som
               -- kontroll 2: Awish + appens ändringar efter läsningen = appens saldo nu). Då
               -- nådde påfyllningen Awish även om pushen inte hade något fack att ändra
               -- (den loggas bara när minst ett fack ändrades).
               (l.awish_synced_at >= e.created_at
                and not coalesce(sl.last_counted_at > l.awish_synced_at, false)
                and exists (
                  select 1 from jsonb_array_elements(coalesce(l.awish_fill, '[]'::jsonb)) x
                  where (x ->> 'title_id')::uuid = e.title_id
                    and coalesce((x ->> 'channels')::int, 0) > 0
                    and coalesce((x ->> 'units')::int, 0) + (
                          select coalesce(sum(e2.quantity), 0)
                            from public.stock_events e2
                           where e2.organization_id = e.organization_id
                             and e2.location_id = l.id and e2.title_id = e.title_id
                             and e2.kind <> 'count'
                             and (sl.last_counted_at is null or e2.occurred_at > sl.last_counted_at)
                             and (e2.occurred_at > l.awish_synced_at
                                  or e2.created_at > l.awish_synced_at))
                        = coalesce(sl.quantity, 0))) as confirmed,
               ${mysteryBatchSql("t")} as mystery_batch,
               -- Saldot just före påfyllningen (samma regel som stock_levels: senaste
               -- inventeringen före händelsen + händelserna mellan), bara för mystery packs.
               (case when ${mysteryBatchSql("t")} is not null then (
                  select coalesce(lc.quantity, 0) + coalesce((
                    select sum(a.quantity) from public.stock_events a
                     where a.organization_id = e.organization_id and a.location_id = e.location_id
                       and a.title_id = e.title_id and a.kind <> 'count'
                       and (a.occurred_at, a.seq) < (e.occurred_at, e.seq)
                       and (lc.seq is null or (a.occurred_at, a.seq) > (lc.occurred_at, lc.seq))), 0)
                  from (select 1) one
                  left join lateral (
                    select c.quantity, c.occurred_at, c.seq from public.stock_events c
                     where c.organization_id = e.organization_id and c.location_id = e.location_id
                       and c.title_id = e.title_id and c.kind = 'count'
                       and (c.occurred_at, c.seq) < (e.occurred_at, e.seq)
                     order by c.occurred_at desc, c.seq desc limit 1) lc on true
               ) end) as before
        from public.stock_events e
        join public.stock_locations l on l.organization_id = e.organization_id and l.id = e.location_id
        join public.machines m on m.organization_id = l.organization_id and m.id = l.machine_id
        left join public.titles t on t.organization_id = e.organization_id and t.id = e.title_id
        left join public.stock_levels sl
          on sl.organization_id = e.organization_id and sl.location_id = l.id
         and sl.title_id = e.title_id
        where e.organization_id = ${orgId}::uuid and e.kind = 'refill' and e.source is null
          and l.machine_id is not null and e.created_at >= ${since}::timestamptz
          -- Påfyllningar det senaste dygnet (inte äldre händelser som sparats nu, t.ex. en import).
          and e.occurred_at >= ${since}::timestamptz
        order by e.created_at`,
  );
  const pushRows = await rows<{ machine_id: string; at: unknown }>(
    db,
    sql`select a.machine_id, a.occurred_at as at from public.automation_log a
        where a.organization_id = ${orgId}::uuid and a.kind = 'awish_push'
          and a.machine_id is not null and a.occurred_at >= ${since}::timestamptz - interval '1 hour'`,
  );
  return {
    pushConfigured,
    refills: refillRows.map((r) => ({
      eventId: r.id,
      machineId: r.machine_id,
      machineLabel: r.label,
      titleName: r.title_name ?? "Okänd titel",
      quantity: Number(r.quantity),
      at: iso(r.at) ?? new Date(0).toISOString(),
      pushEnabled: r.linked === true,
      undone: r.undone === true,
      noSlot: r.no_slot === true,
      confirmedByRead: r.confirmed === true,
      ...(r.mystery_batch === null
        ? {}
        : {
            mysteryBatchSize: Number(r.mystery_batch),
            before: r.before === null ? null : Number(r.before),
          }),
    })),
    pushes: pushRows.map((p) => ({ machineId: p.machine_id, at: iso(p.at) ?? "" })),
  };
}

// ---------------------------------------------------------------------------
// 4. Synk färsk
// ---------------------------------------------------------------------------

export async function querySyncSources(
  db: Db,
  orgId: string,
  timeZone: string,
  now: Date,
): Promise<SyncSourceState[]> {
  const list = await rows<{
    name: string;
    status: string;
    cursor: string | null;
    expires_at: unknown;
    linked: number;
    stock_read_at: unknown;
  }>(
    db,
    sql`select ds.name, ds.status::text as status, ds.cursor, ds.awish_expires_at as expires_at,
               (select count(*)::int from public.source_machines sm
                 join public.machines m on m.organization_id = sm.organization_id and m.id = sm.machine_id
                 where sm.organization_id = ds.organization_id and sm.data_source_id = ds.id
                   and m.archived_at is null) as linked,
               (select min(l.awish_synced_at) from public.stock_locations l
                 join public.source_machines sm
                   on sm.organization_id = l.organization_id and sm.machine_id = l.machine_id
                 where sm.organization_id = ds.organization_id and sm.data_source_id = ds.id
                   and l.archived_at is null) as stock_read_at
        from public.data_sources ds
        where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
          and ds.archived_at is null
        order by ds.created_at`,
  );
  return list.map((s) => {
    const state = parseState(s.cursor);
    const expires = iso(s.expires_at);
    const notice = expires ? awishExpiryNotice(expires, now, timeZone) : null;
    return {
      name: s.name || "Awish",
      paused: s.status === "paused",
      linkedMachines: Number(s.linked),
      lastSuccessAt: state.lastSuccessAt,
      // Den äldsta automatens läsning (alla ska läsas varje gång), annars synkens egen tid.
      stockReadAt: iso(s.stock_read_at) ?? state.stockSyncedAt,
      expiry: notice ? { level: notice.level, text: notice.text } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// 5. Avräkningar
// ---------------------------------------------------------------------------

export interface UnpaidSettlement {
  readonly id: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly month: string;
  readonly amountOre: number;
}

/** Obetalda avräkningar för stängda månader (före `monthStart`). */
export async function queryUnpaidClosed(
  db: Db,
  orgId: string,
  currentMonthStart: string,
): Promise<UnpaidSettlement[]> {
  const list = await rows<{
    id: string;
    store_id: string;
    store_name: string;
    month: string;
    amount_ore: number | string;
  }>(
    db,
    sql`select s.id, s.store_id, st.name as store_name, to_char(s.month, 'YYYY-MM-DD') as month,
               s.amount_ore
        from public.store_settlements s
        join public.stores st on st.organization_id = s.organization_id and st.id = s.store_id
        where s.organization_id = ${orgId}::uuid and s.paid_on is null
          and s.month < ${currentMonthStart}::date
        order by s.month, st.name`,
  );
  return list.map((r) => ({
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    month: r.month,
    amountOre: Number(r.amount_ore),
  }));
}

// ---------------------------------------------------------------------------
// 6. Datahygien
// ---------------------------------------------------------------------------

export async function queryHygiene(
  db: Db,
  orgId: string,
  from: string,
): Promise<Omit<HygieneInput, "unpricedTitles">> {
  const [orders] = await rows<{ no_title: number; no_amount: number }>(
    db,
    sql`select count(*) filter (where o.title_id is null)::int as no_title,
               count(*) filter (where o.amount_ore <= 0)::int as no_amount
        from public.orders o
        where o.organization_id = ${orgId}::uuid and o.business_date >= ${from}::date
          and o.test_purchase_at is null`,
  );
  const negative = await rows<{
    place: string;
    kind: string;
    title_name: string | null;
    quantity: number;
  }>(
    db,
    sql`select coalesce(nullif(m.code, ''), l.name) as place, l.kind::text as kind,
               t.name as title_name, sl.quantity
        from public.stock_levels sl
        join public.stock_locations l on l.organization_id = sl.organization_id and l.id = sl.location_id
        left join public.machines m on m.organization_id = l.organization_id and m.id = l.machine_id
        left join public.titles t on t.organization_id = sl.organization_id and t.id = sl.title_id
        where sl.organization_id = ${orgId}::uuid and sl.quantity < 0 and l.archived_at is null
          and (m.id is null or m.archived_at is null)
        order by place, t.name
        limit 100`,
  );
  return {
    ordersWithoutTitle: Number(orders?.no_title ?? 0),
    ordersWithoutAmount: Number(orders?.no_amount ?? 0),
    negativeStock: negative.map((n) => ({
      place: n.place,
      kind: n.kind === "machine" ? "machine" : "warehouse",
      titleName: n.title_name ?? "Okänd titel",
      quantity: Number(n.quantity),
    })),
  };
}

/**
 * Butiker (inte arkiverade) med dagar i perioden då en automat stod där men inget avtal
 * gällde: samma placeringar och avtal som beräkningarna, samma regel (agreementGaps).
 */
export async function queryAgreementGaps(
  db: Db,
  orgId: string,
  period: Period,
): Promise<NonNullable<HygieneInput["agreementGaps"]>> {
  const [placements, agreements, stores] = await Promise.all([
    rows<{ machine_id: string; store_id: string; valid_from: string; valid_to: string | null }>(
      db,
      sql`select machine_id, store_id, valid_from::text as valid_from, valid_to::text as valid_to
          from public.machine_placements where organization_id = ${orgId}::uuid`,
    ),
    rows<{
      store_id: string;
      valid_from: string;
      valid_to: string | null;
      commission_bp: number | null;
      monthly_rent_ore: number | null;
    }>(
      db,
      sql`select store_id, valid_from::text as valid_from, valid_to::text as valid_to,
                 commission_bp, monthly_rent_ore::int as monthly_rent_ore
          from public.store_agreements where organization_id = ${orgId}::uuid`,
    ),
    rows<{ id: string; name: string }>(
      db,
      sql`select id, name from public.stores
          where organization_id = ${orgId}::uuid and archived_at is null`,
    ),
  ]);
  const names = new Map(stores.map((s) => [String(s.id), s.name]));
  return agreementGaps({
    placements: placements.map((p) => ({
      machineId: String(p.machine_id),
      storeId: String(p.store_id),
      from: p.valid_from as IsoDate,
      to: (p.valid_to as IsoDate | null) ?? null,
    })),
    agreements: agreements.map((a) => ({
      storeId: String(a.store_id),
      validFrom: a.valid_from as IsoDate,
      validTo: (a.valid_to as IsoDate | null) ?? null,
      commissionBp: a.commission_bp === null ? null : Number(a.commission_bp),
      monthlyRentOre: a.monthly_rent_ore === null ? null : Number(a.monthly_rent_ore),
    })),
    period,
    storeIds: [...names.keys()],
  }).map((g) => ({
    storeId: g.storeId,
    storeName: names.get(g.storeId) ?? "Okänd butik",
    days: g.days,
    whole: g.days >= g.placedDays,
  }));
}
