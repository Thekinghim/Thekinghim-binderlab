/**
 * Frågorna bakom orderlistan. Varje funktion tar en transaktion som redan kör som
 * användaren (withUserDbFor, alltså med RLS) och organisationens id. Rollen kontrolleras
 * i ./service innan frågorna körs; RLS är det andra lagret (en påfyllare får inga order).
 *
 * Ingen ekonomilogik: frågorna filtrerar, sorterar, räknar och summerar betalt belopp.
 * Testköp står med i raderna (med etiketten "Testköp") men räknas inte i antal, summa,
 * snittorder eller urvalets första och senaste order.
 * Sökning på namn (titel, automat, butik) och sortering på namn görs med id-listor som
 * servern räknat fram med samma svenska ordning som tabellen i webbläsaren, så att en
 * sida som laddas från servern alltid står i samma ordning som tabellen sorterar.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { Tx } from "@/db/client";
import type { IsoDate, Period } from "@/domain";
import { countedOrder } from "@/server/data/core/queries";

import { likePattern, type OrderSort } from "./params";

/** Ett sökord och de id vars namn matchar det. */
export interface TermMatch {
  readonly text: string;
  readonly titleIds: readonly string[];
  readonly machineIds: readonly string[];
  readonly storeIds: readonly string[];
}

/** En placering: automaten stod i butiken from–to (inklusivt, to null = tills vidare). */
export interface PlacementWindow {
  readonly machineId: string;
  readonly storeId: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
}

export interface OrderQueryFilter {
  readonly period: Period;
  /** Organisationens placeringar (få), för butiksfilter, sökning på butik och sortering. */
  readonly placements: readonly PlacementWindow[];
  readonly storeId: string | null;
  readonly machineId: string | null;
  readonly titleId: string | null;
  /** Varje sökord måste träffa ordernummer, originaltitel, titel, automat eller butik. */
  readonly terms: readonly TermMatch[];
}

/** Rangordningen för sortering på namn: id i svensk ordning. */
export interface SortRanks {
  readonly titles: readonly string[];
  readonly machines: readonly string[];
  readonly stores: readonly string[];
}

export interface RawOrderRow {
  readonly id: string;
  readonly externalId: string;
  readonly orderedAt: string;
  readonly businessDate: IsoDate;
  readonly titleId: string | null;
  readonly rawTitle: string | null;
  readonly machineId: string | null;
  readonly amountOre: number;
  /** Markerad som testköp (räknas inte). */
  readonly testPurchase: boolean;
}

/** uuid[]-literal. Id:na är redan validerade (kommer från databasen eller isUuid). */
function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/** Orderns automat stod i placeringen på orderns dag. */
function inWindow(p: PlacementWindow): SQL {
  const to = p.to === null ? sql`` : sql` and o.business_date <= ${p.to}::date`;
  return sql`(o.machine_id = ${p.machineId}::uuid and o.business_date >= ${p.from}::date${to})`;
}

/**
 * Placeringen som gällde orderns automat på orderns dag ligger i någon av butikerna.
 * Placeringarna är få, så villkoret skrivs ut som en OR-lista i stället för en
 * delfråga per order (som blir långsam på 100 000 order).
 */
function placedIn(placements: readonly PlacementWindow[], storeIds: readonly string[]): SQL {
  const windows = placements.filter((p) => storeIds.includes(p.storeId));
  if (windows.length === 0) return sql`false`;
  return sql`(${sql.join(windows.map(inWindow), sql` or `)})`;
}

/** Butikens plats i sorteringen för orderns automat och dag, eller null. */
function storeRank(placements: readonly PlacementWindow[], stores: readonly string[]): SQL {
  const rank = new Map(stores.map((id, i) => [id, i]));
  const cases = placements
    .filter((p) => rank.has(p.storeId))
    .map((p) => sql`when ${inWindow(p)} then ${rank.get(p.storeId)}::int`);
  if (cases.length === 0) return sql`null::int`;
  return sql`(case ${sql.join(cases, sql` `)} end)`;
}

function termCondition(t: TermMatch, placements: readonly PlacementWindow[]): SQL {
  const pattern = likePattern(t.text);
  const parts: SQL[] = [sql`o.external_id ilike ${pattern}`, sql`o.raw_title ilike ${pattern}`];
  if (t.titleIds.length) parts.push(sql`o.title_id = any(${uuidArray(t.titleIds)})`);
  if (t.machineIds.length) parts.push(sql`o.machine_id = any(${uuidArray(t.machineIds)})`);
  if (t.storeIds.length) parts.push(placedIn(placements, t.storeIds));
  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * Filtrets villkor. `period` null = utan periodgräns (urvalets första och senaste order).
 * `counted` = bara order som räknas (inte testköp), för antal och summor.
 */
function where(
  orgId: string,
  f: OrderQueryFilter,
  period: Period | null = f.period,
  counted = true,
): SQL {
  const parts: SQL[] = [sql`o.organization_id = ${orgId}::uuid`];
  if (counted) parts.push(countedOrder());
  if (period) {
    parts.push(sql`o.business_date >= ${period.start}::date`);
    parts.push(sql`o.business_date <= ${period.end}::date`);
  }
  if (f.machineId) parts.push(sql`o.machine_id = ${f.machineId}::uuid`);
  if (f.storeId) parts.push(placedIn(f.placements, [f.storeId]));
  if (f.titleId) parts.push(sql`o.title_id = ${f.titleId}::uuid`);
  for (const t of f.terms) parts.push(termCondition(t, f.placements));
  return sql.join(parts, sql` and `);
}

function orderBy(sort: OrderSort, ranks: SortRanks, placements: readonly PlacementWindow[]): SQL {
  const dir = sort.dir === "asc" ? sql`asc` : sql`desc`;
  // Lika värden: nyaste först, sedan id, så att ordningen alltid är entydig.
  const tie = sql`o.ordered_at desc, o.id desc`;
  switch (sort.key) {
    case "tid":
      return sql`o.ordered_at ${dir}, o.id ${dir}`;
    case "nr":
      // Ordernummer är siffror: kortare nummer är mindre (som tabellens numeriska ordning).
      return sql`length(o.external_id) ${dir}, o.external_id ${dir}, ${tie}`;
    case "belopp":
      return sql`o.amount_ore ${dir}, ${tie}`;
    case "titel":
      return sql`array_position(${uuidArray(ranks.titles)}, o.title_id) ${dir} nulls last, ${tie}`;
    case "automat":
      return sql`array_position(${uuidArray(ranks.machines)}, o.machine_id) ${dir} nulls last, ${tie}`;
    case "butik":
      return sql`${storeRank(placements, ranks.stores)} ${dir} nulls last, ${tie}`;
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function list(result: unknown): Record<string, unknown>[] {
  return Array.from(result as Iterable<Record<string, unknown>>);
}

/**
 * Antal och summa betalt belopp för filtret i perioden, utan testköp. `withTestPurchases`
 * räknar alla rader (exportens storlek).
 */
export async function queryOrderTotals(
  tx: Tx,
  orgId: string,
  filter: OrderQueryFilter,
  period: Period = filter.period,
  withTestPurchases = false,
): Promise<{ count: number; amountOre: number }> {
  const rows = list(
    await tx.execute(sql`
      select count(*)::bigint as n, coalesce(sum(o.amount_ore), 0)::bigint as total
      from public.orders o
      where ${where(orgId, filter, period, !withTestPurchases)}`),
  );
  const r = rows[0] ?? {};
  return { count: toNumber(r.n), amountOre: toNumber(r.total) };
}

/** Beloppen i perioden med antal order per belopp (få olika belopp), för snittordern. */
export async function queryOrderAmounts(
  tx: Tx,
  orgId: string,
  filter: OrderQueryFilter,
): Promise<{ amountOre: number; count: number }[]> {
  const rows = list(
    await tx.execute(sql`
      select o.amount_ore as amount, count(*)::bigint as n
      from public.orders o
      where ${where(orgId, filter)}
      group by o.amount_ore`),
  );
  return rows.map((r) => ({ amountOre: toNumber(r.amount), count: toNumber(r.n) }));
}

/**
 * Första affärsdagen och senaste ordern som matchar filtret (butik, automat, titel,
 * sökning) utan periodgräns. Båda null när inget matchar.
 */
export async function queryOrderSpan(
  tx: Tx,
  orgId: string,
  filter: OrderQueryFilter,
): Promise<{ firstDate: IsoDate | null; latestAt: string | null }> {
  const rows = list(
    await tx.execute(sql`
      select min(o.business_date)::text as first, max(o.ordered_at) as latest
      from public.orders o
      where ${where(orgId, filter, null)}`),
  );
  const r = rows[0] ?? {};
  return {
    firstDate: r.first ? String(r.first) : null,
    latestAt: r.latest ? toIso(r.latest) : null,
  };
}

/** Finns det någon order alls i organisationen? */
export async function queryHasOrders(tx: Tx, orgId: string): Promise<boolean> {
  const rows = list(
    await tx.execute(sql`
      select exists(select 1 from public.orders o where o.organization_id = ${orgId}::uuid) as e`),
  );
  return Boolean(rows[0]?.e);
}

/** Orderns exakta tid som text (för markören i tidsordning), eller null. */
export async function queryOrderedAtText(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<string | null> {
  const rows = list(
    await tx.execute(sql`
      select o.ordered_at::text as at from public.orders o
      where o.organization_id = ${orgId}::uuid and o.id = ${orderId}::uuid`),
  );
  const at = rows[0]?.at;
  return at ? String(at) : null;
}

/** Markör i tidsordning: raderna efter denna order (tid, id). */
export interface TimeCursor {
  readonly orderedAt: string;
  readonly id: string;
}

function rowsSql(
  orgId: string,
  filter: OrderQueryFilter,
  sort: OrderSort,
  ranks: SortRanks,
  withRawTitle: boolean,
  after: TimeCursor | null,
): SQL {
  const cursor =
    after === null || sort.key !== "tid"
      ? sql``
      : sort.dir === "asc"
        ? sql` and (o.ordered_at, o.id) > (${after.orderedAt}::timestamptz, ${after.id}::uuid)`
        : sql` and (o.ordered_at, o.id) < (${after.orderedAt}::timestamptz, ${after.id}::uuid)`;
  const raw = withRawTitle
    ? sql`o.raw_title`
    : sql`case when o.title_id is null then o.raw_title end`;
  return sql`
      select o.id, o.external_id, o.ordered_at, o.business_date::text as business_date,
             o.title_id, ${raw} as raw_title,
             o.machine_id, o.amount_ore, (o.test_purchase_at is not null) as test_purchase
      from public.orders o
      where ${where(orgId, filter, filter.period, false)}${cursor}
      order by ${orderBy(sort, ranks, filter.placements)}`;
}

function toRow(r: Record<string, unknown>): RawOrderRow {
  return {
    id: String(r.id),
    externalId: String(r.external_id),
    orderedAt: toIso(r.ordered_at),
    businessDate: String(r.business_date),
    titleId: r.title_id ? String(r.title_id) : null,
    rawTitle: r.raw_title === null || r.raw_title === undefined ? null : String(r.raw_title),
    machineId: r.machine_id ? String(r.machine_id) : null,
    amountOre: toNumber(r.amount_ore),
    testPurchase: Boolean(r.test_purchase),
  };
}

/**
 * Raderna i vald sortering, från `offset`. `limit` null = alla. Hämtar en rad extra för
 * att veta om det finns fler. Originaltiteln kommer bara med när ordern saknar titel,
 * utom med `withRawTitle` (exporten). Med markör `after` (bara sortering på tid) börjar
 * sidan efter markören i stället för vid offset, så att order som kommer in under tiden
 * inte förskjuter raderna.
 */
export async function queryOrderRows(
  tx: Tx,
  orgId: string,
  filter: OrderQueryFilter,
  sort: OrderSort,
  ranks: SortRanks,
  offset: number,
  limit: number | null,
  withRawTitle = false,
  after: TimeCursor | null = null,
): Promise<{ rows: RawOrderRow[]; more: boolean }> {
  const skip = after !== null && sort.key === "tid" ? 0 : offset;
  const page = limit === null ? sql`` : sql`limit ${limit + 1} offset ${skip}`;
  const result = list(
    await tx.execute(
      sql`${rowsSql(orgId, filter, sort, ranks, withRawTitle, after)}
      ${page}`,
    ),
  );
  const more = limit !== null && result.length > limit;
  return { rows: (more ? result.slice(0, limit) : result).map(toRow), more };
}

/**
 * Alla rader i vald sortering (med originaltitel) i satser om `batch`, ur en databas-
 * markör i transaktionen: en enda fråga, så att satserna hör till samma ögonblicksbild.
 * `onBatch` får varje sats och kan vänta (mottrycket när svaret strömmas ut).
 */
export async function forEachOrderRowBatch(
  tx: Tx,
  orgId: string,
  filter: OrderQueryFilter,
  sort: OrderSort,
  ranks: SortRanks,
  batch: number,
  onBatch: (rows: RawOrderRow[]) => Promise<void>,
): Promise<void> {
  const size = sql.raw(String(Math.max(1, Math.trunc(batch))));
  await tx.execute(
    sql`declare order_export no scroll cursor for ${rowsSql(orgId, filter, sort, ranks, true, null)}`,
  );
  for (;;) {
    const result = list(await tx.execute(sql`fetch forward ${size} from order_export`));
    if (result.length === 0) break;
    await onBatch(result.map(toRow));
    if (result.length < batch) break;
  }
  await tx.execute(sql`close order_export`);
}

export interface RawOrderDetail {
  readonly id: string;
  readonly externalId: string;
  readonly rawTitle: string;
  readonly titleId: string | null;
  readonly titleName: string | null;
  readonly titleSeries: string | null;
  readonly orderedAt: string;
  readonly businessDate: IsoDate;
  readonly amountOre: number;
  readonly paymentMethod: string | null;
  readonly machineId: string | null;
  readonly machineCode: string | null;
  readonly machineName: string | null;
  readonly sourceMachineExternalId: string | null;
  readonly sourceMachineName: string | null;
  readonly sourceMachineDeviceNo: string | null;
  readonly dataSourceId: string;
  readonly dataSourceName: string;
  readonly dataSourceProvider: string;
  readonly importId: string | null;
  readonly importFileName: string | null;
  readonly importTrigger: string | null;
  readonly importAt: string | null;
  readonly importRowNumber: number | null;
  readonly lateInClosedPeriod: boolean;
  readonly createdAt: string;
  /** Markerad som testköp (ISO), eller null. */
  readonly testPurchaseAt: string | null;
  /** Vem som markerade (visningsnamn ur audit_log och profiles), eller null. */
  readonly testPurchaseBy: string | null;
}

/** En order med titel, automat, källans automat, datakälla och import. null om den inte finns (eller inte syns). */
export async function queryOrderDetail(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<RawOrderDetail | null> {
  const rows = list(
    await tx.execute(sql`
      select o.id, o.external_id, o.raw_title, o.title_id, t.name as title_name,
             t.series as title_series, o.ordered_at, o.business_date::text as business_date,
             o.amount_ore, o.payment_method, o.machine_id, m.code as machine_code,
             m.name as machine_name, sm.external_id as sm_external_id,
             sm.external_name as sm_name, sm.external_device_no as sm_device_no,
             o.data_source_id, ds.name as ds_name, ds.provider::text as ds_provider,
             o.import_id, i.file_name as import_file_name, i.trigger::text as import_trigger,
             coalesce(i.finished_at, i.started_at, i.created_at) as import_at,
             (select ir.row_number from public.import_rows ir
               where ir.organization_id = o.organization_id
                 and ir.import_id = o.import_id
                 and ir.order_id = o.id
               order by ir.row_number limit 1) as import_row_number,
             o.late_in_closed_period, o.created_at, o.test_purchase_at,
             (select p.display_name
                from public.audit_log a
                left join public.profiles p
                  on p.organization_id = a.organization_id and p.user_id = a.actor_id
                 and p.anonymized_at is null
               where o.test_purchase_at is not null
                 and a.organization_id = o.organization_id and a.table_name = 'orders'
                 and a.row_id = o.id and a.action = 'update'
                 and a.after ->> 'test_purchase_at' is not null
                 and a.before ->> 'test_purchase_at' is null
               order by a.occurred_at desc limit 1) as test_purchase_by
      from public.orders o
      join public.data_sources ds
        on ds.organization_id = o.organization_id and ds.id = o.data_source_id
      left join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
      left join public.machines m on m.organization_id = o.organization_id and m.id = o.machine_id
      left join public.source_machines sm
        on sm.organization_id = o.organization_id and sm.id = o.source_machine_id
      left join public.imports i on i.organization_id = o.organization_id and i.id = o.import_id
      where o.organization_id = ${orgId}::uuid and o.id = ${orderId}::uuid`),
  );
  const r = rows[0];
  if (!r) return null;
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    externalId: String(r.external_id),
    rawTitle: String(r.raw_title),
    titleId: str(r.title_id),
    titleName: str(r.title_name),
    titleSeries: str(r.title_series),
    orderedAt: toIso(r.ordered_at),
    businessDate: String(r.business_date),
    amountOre: toNumber(r.amount_ore),
    paymentMethod: str(r.payment_method),
    machineId: str(r.machine_id),
    machineCode: str(r.machine_code),
    machineName: str(r.machine_name),
    sourceMachineExternalId: str(r.sm_external_id),
    sourceMachineName: str(r.sm_name),
    sourceMachineDeviceNo: str(r.sm_device_no),
    dataSourceId: String(r.data_source_id),
    dataSourceName: String(r.ds_name),
    dataSourceProvider: String(r.ds_provider),
    importId: str(r.import_id),
    importFileName: str(r.import_file_name),
    importTrigger: str(r.import_trigger),
    importAt: r.import_at ? toIso(r.import_at) : null,
    importRowNumber:
      r.import_row_number === null || r.import_row_number === undefined
        ? null
        : toNumber(r.import_row_number),
    lateInClosedPeriod: Boolean(r.late_in_closed_period),
    createdAt: toIso(r.created_at),
    testPurchaseAt: r.test_purchase_at ? toIso(r.test_purchase_at) : null,
    testPurchaseBy: str(r.test_purchase_by),
  };
}
