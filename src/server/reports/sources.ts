/**
 * Laddar allt en rapport räknas på, i EN transaktion som redan kör som användaren (RLS)
 * eller, för det schemalagda jobbet, som systemet. Ingen ekonomilogik här: frågorna
 * hämtar rader, rapportunderlagen räknas i @/reports (via ./snapshot).
 *
 * Order hämtas från samma månad året innan till och med en månad efter rapportmånaden:
 * jämförelser och 12 månaders utveckling behöver historiken, och avstämningen av
 * nummerserien behöver se ordernummer som hamnat i grannmånaderna.
 */

import "server-only";

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import {
  addMonths,
  monthEnd,
  monthStart,
  type IsoDate,
  type IsoMonth,
  type Period,
} from "@/domain";
import type { LedgerAccount, PartnerOwner, ReportSources } from "@/reports";
import {
  queryAgreements,
  queryFirstOrderDate,
  queryMachines,
  queryPlacements,
  queryPrices,
  querySettings,
  queryStores,
  queryTitles,
} from "@/server/data/core/queries";

import type { ReportType } from "./kinds";
import type { SnapshotInput, SnapshotOrganization, SnapshotStockEvent } from "./snapshot";
import { busiestWindow, refillSummary, type StoreService } from "./store-service";

export interface LoadArgs {
  readonly organizationId: string;
  readonly type: ReportType;
  readonly month: IsoMonth;
  readonly storeId?: string | null;
  readonly greeting?: string | null;
  readonly comment?: string | null;
  /** Nu (ISO 8601). */
  readonly now: string;
}

/**
 * Titel-id för order vars titel i källan ännu inte är kopplad till en titel. Sådana order
 * är ändå försäljning: de bokförs och ger butiken ersättning. De saknar inköpspris och
 * står på en egen rad ("Titel ej kopplad") i tabeller per titel.
 */
export const UNLINKED_TITLE_ID = "titel-ej-kopplad";
export const UNLINKED_TITLE_NAME = "Titel ej kopplad";

export interface ReportOrder {
  readonly id: string;
  readonly externalId: string;
  readonly titleId: string;
  readonly machineId: string | null;
  readonly businessDate: IsoDate;
  readonly amountOre: number;
  readonly orderedAt: string | null;
  /** Sant när titeln inte är kopplad (titleId = UNLINKED_TITLE_ID). */
  readonly unlinkedTitle: boolean;
}

/**
 * ALLA order med affärsdatum i fönstret, även de vars titel inte är kopplad (till skillnad
 * från panelens queryOrders, som bara tar med prissättningsbara order).
 */
export async function queryReportOrders(tx: Tx, orgId: string, range: Period): Promise<ReportOrder[]> {
  const rows = await tx
    .select({
      id: s.orders.id,
      externalId: s.orders.externalId,
      titleId: s.orders.titleId,
      machineId: s.orders.machineId,
      businessDate: s.orders.businessDate,
      amountOre: s.orders.amountOre,
      orderedAt: s.orders.orderedAt,
    })
    .from(s.orders)
    .where(
      and(
        eq(s.orders.organizationId, orgId),
        gte(s.orders.businessDate, range.start),
        lte(s.orders.businessDate, range.end),
      ),
    )
    .orderBy(asc(s.orders.orderedAt), asc(s.orders.id));
  return rows.map((r) => ({
    id: r.id,
    externalId: r.externalId,
    titleId: r.titleId ?? UNLINKED_TITLE_ID,
    machineId: r.machineId,
    businessDate: r.businessDate,
    amountOre: r.amountOre,
    orderedAt: r.orderedAt ? r.orderedAt.toISOString() : null,
    unlinkedTitle: r.titleId === null,
  }));
}

/** Ordrarnas fönster för en rapportmånad. */
export function orderWindow(month: IsoMonth): Period {
  return { start: monthStart(addMonths(month, -12)), end: monthEnd(addMonths(month, 1)) };
}

async function queryOrganization(tx: Tx, orgId: string): Promise<SnapshotOrganization> {
  const rows = await tx
    .select({ id: s.organizations.id, name: s.organizations.name, tz: s.organizations.timezone })
    .from(s.organizations)
    .where(eq(s.organizations.id, orgId));
  const row = rows[0];
  if (!row) throw new Error("Organisationen hittades inte.");
  return { id: row.id, name: row.name, orgNumber: null, timeZone: row.tz };
}

/** Ägarandelarna som gällde dagen `asOf` (senaste valid_from ≤ dagen). */
export async function queryOwnersOn(tx: Tx, orgId: string, asOf: IsoDate): Promise<PartnerOwner[]> {
  const rows = await tx
    .select({
      id: s.ownerShares.id,
      name: s.ownerShares.holderName,
      shareBp: s.ownerShares.shareBp,
      validFrom: s.ownerShares.validFrom,
    })
    .from(s.ownerShares)
    .where(and(eq(s.ownerShares.organizationId, orgId), lte(s.ownerShares.validFrom, asOf)))
    .orderBy(desc(s.ownerShares.validFrom), asc(s.ownerShares.holderName));
  const latest = rows[0]?.validFrom;
  return rows
    .filter((r) => r.validFrom === latest)
    .map((r) => ({ id: r.id, name: r.name, shareBp: r.shareBp }));
}

export async function queryLedgerAccounts(tx: Tx, orgId: string): Promise<LedgerAccount[]> {
  const rows = await tx
    .select({
      key: s.ledgerAccounts.key,
      account: s.ledgerAccounts.basAccount,
      name: s.ledgerAccounts.name,
    })
    .from(s.ledgerAccounts)
    .where(eq(s.ledgerAccounts.organizationId, orgId))
    .orderBy(asc(s.ledgerAccounts.key));
  return rows;
}

/** Lagerhändelser till och med `end` (för saldot vid månadens slut). */
export async function queryStockEventsUntil(
  tx: Tx,
  orgId: string,
  end: IsoDate,
): Promise<SnapshotStockEvent[]> {
  const rows = await tx
    .select({
      id: s.stockEvents.id,
      locationId: s.stockEvents.locationId,
      machineId: s.stockLocations.machineId,
      titleId: s.stockEvents.titleId,
      kind: s.stockEvents.kind,
      quantity: s.stockEvents.quantity,
      businessDate: s.stockEvents.businessDate,
      occurredAt: s.stockEvents.occurredAt,
      seq: s.stockEvents.seq,
    })
    .from(s.stockEvents)
    .innerJoin(
      s.stockLocations,
      and(
        eq(s.stockLocations.id, s.stockEvents.locationId),
        eq(s.stockLocations.organizationId, s.stockEvents.organizationId),
      ),
    )
    .where(and(eq(s.stockEvents.organizationId, orgId), lte(s.stockEvents.businessDate, end)));
  return rows.map((r) => ({
    id: r.id,
    locationId: r.locationId,
    machineId: r.machineId,
    titleId: r.titleId,
    kind: r.kind,
    quantity: r.quantity,
    businessDate: r.businessDate!,
    occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
    seq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
  }));
}

/**
 * Dagar med påfyllning i butikens automater under månaden (dagar då automaten stod i
 * butiken). En rad per dag: lagerhändelserna har en rad per titel, inte per besök.
 */
async function queryStoreRefillDates(
  tx: Tx,
  orgId: string,
  storeId: string,
  period: Period,
): Promise<IsoDate[]> {
  const rows = await tx.execute(
    sql`select distinct se.business_date::text as d
        from public.stock_events se
        join public.stock_locations sl
          on sl.id = se.location_id and sl.organization_id = se.organization_id
        where se.organization_id = ${orgId}::uuid
          and se.kind = 'refill'
          and se.business_date between ${period.start}::date and ${period.end}::date
          and exists (
            select 1 from public.machine_placements mp
            where mp.organization_id = se.organization_id
              and mp.machine_id = sl.machine_id
              and mp.store_id = ${storeId}::uuid
              and mp.valid_from <= se.business_date
              and (mp.valid_to is null or mp.valid_to >= se.business_date)
          )`,
  );
  return Array.from(rows).map((r) => String((r as { d: string }).d));
}

/** Allt `buildSnapshot` behöver för en rapport. */
export async function loadSnapshotInput(tx: Tx, args: LoadArgs): Promise<SnapshotInput> {
  const orgId = args.organizationId;
  const window = orderWindow(args.month);
  const period = { start: monthStart(args.month), end: monthEnd(args.month) };
  const today = args.now.slice(0, 10);

  const [organization, settings, titles, placements, stores, prices, agreements, orders] =
    await Promise.all([
      queryOrganization(tx, orgId),
      querySettings(tx, orgId),
      queryTitles(tx, orgId),
      queryPlacements(tx, orgId),
      queryStores(tx, orgId),
      queryPrices(tx, orgId),
      queryAgreements(tx, orgId),
      queryReportOrders(tx, orgId, window),
    ]);
  const inPeriod = (o: ReportOrder) => o.businessDate >= period.start && o.businessDate <= period.end;
  const ordersWithoutTitle = orders.filter((o) => inPeriod(o) && o.unlinkedTitle).length;
  const machines = await queryMachines(tx, orgId, placements, today);
  const historyStart = await queryFirstOrderDate(tx, orgId);

  const sources: ReportSources = {
    orders: orders.map((o) => ({
      id: o.id,
      externalId: o.externalId,
      titleId: o.titleId,
      machineId: o.machineId,
      businessDate: o.businessDate,
      amountOre: o.amountOre,
    })),
    prices,
    agreements,
    placements: placements.map((p) => ({
      machineId: p.machineId,
      storeId: p.storeId,
      from: p.from,
      to: p.to,
    })),
    settings: { vatRateBp: settings.vatRateBp, cardFeeBp: settings.cardFeeBp },
    stores: stores.map((x) => ({ id: x.id, name: x.name })),
    machines: machines.map((m) => ({ id: m.id, name: m.name, code: m.code })),
    titles: [
      ...titles.map((t) => ({ id: t.id, name: t.name })),
      ...(orders.some((o) => o.unlinkedTitle)
        ? [{ id: UNLINKED_TITLE_ID, name: UNLINKED_TITLE_NAME }]
        : []),
    ],
  };

  const input: SnapshotInput = {
    type: args.type,
    month: args.month,
    organization,
    sources,
    generatedAt: args.now,
    historyStart,
    ordersWithoutTitle,
  };

  switch (args.type) {
    case "butik": {
      if (!args.storeId) return { ...input, storeId: null };
      const storeId = args.storeId;
      const onDay = (machineId: string | null, date: IsoDate) =>
        machineId !== null &&
        placements.some(
          (p) =>
            p.machineId === machineId &&
            p.storeId === storeId &&
            p.from <= date &&
            (p.to === null || p.to >= date),
        );
      const storeOrders = orders.filter(inPeriod);
      const busy = busiestWindow(
        storeOrders
          .filter((o) => onDay(o.machineId, o.businessDate))
          .flatMap((o) => (o.orderedAt ? [o.orderedAt] : [])),
        organization.timeZone,
      );
      const refills = refillSummary(await queryStoreRefillDates(tx, orgId, storeId, period));
      const storeService: StoreService = {
        refills,
        busiest: busy.text,
        busiestOrders: busy.orders,
      };
      return {
        ...input,
        storeId,
        greeting: args.greeting ?? null,
        storeService,
      };
    }
    case "bokforing":
      return {
        ...input,
        ledgerAccounts: await queryLedgerAccounts(tx, orgId),
        fiscalYearStartMonth: settings.fiscalYearStartMonth,
      };
    case "delagare": {
      const [owners, stockEvents] = await Promise.all([
        queryOwnersOn(tx, orgId, period.end),
        queryStockEventsUntil(tx, orgId, period.end),
      ]);
      return { ...input, owners, stockEvents, comment: args.comment ?? null };
    }
  }
}

/** Butiker som hade en automat placerad någon dag under månaden. */
export function storesPlacedIn(
  placements: readonly { storeId: string; from: IsoDate; to: IsoDate | null }[],
  period: Period,
): string[] {
  const ids = new Set<string>();
  for (const p of placements) {
    if (p.from <= period.end && (p.to === null || p.to >= period.start)) ids.add(p.storeId);
  }
  return [...ids].sort();
}
