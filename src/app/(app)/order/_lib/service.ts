/**
 * Orderlistans laddare, bundna till en given användare och organisation (testas i
 * test/db/order-*.test.ts utan Next). Sidan, server actions och exporten anropar dem via
 * ./session.
 *
 * Varje funktion kontrollerar först rollen mot databasen (bara roller som ser ekonomi:
 * ägare, admin, läsare) och läser sedan allt i EN transaktion som användaren (RLS).
 * Påfyllaren får AuthorizationError, och RLS ger henne inga order även om kontrollen
 * skulle kringgås.
 */

import "server-only";

import {
  averageOrderValueOre,
  PlacementIndex,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { requireRoleFor, withUserDbFor, isUuid } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import {
  queryMachines,
  queryPlacements,
  querySettings,
  queryStores,
  queryTitles,
} from "@/server/data/core/queries";
import { ECONOMY_ROLES, type DataScope } from "@/server/data/core/types";
import type { Tx } from "@/db/client";

import { searchTerms, type OrderParams } from "./params";
import {
  forEachOrderRowBatch,
  queryHasOrders,
  queryOrderAmounts,
  queryOrderDetail,
  queryOrderedAtText,
  queryOrderRows,
  queryOrderSpan,
  queryOrderTotals,
  type OrderQueryFilter,
  type RawOrderRow,
  type TimeCursor,
} from "./queries";
import { buildRefs, matchTerms, sortRanks } from "./refs";
import type {
  OrderDetail,
  OrderList,
  OrderPage,
  OrderPageStart,
  OrderRefs,
  OrderRow,
} from "./types";

/** Rader i första laddningen. */
export const FIRST_PAGE = 500;
/** Rader per påfyllning när man scrollar. */
export const NEXT_PAGE = 1000;
/** Flest rader i en CSV-export. */
export const EXPORT_LIMIT = 500_000;
/** Rader per sats när exporten strömmas ut. */
export const EXPORT_BATCH = 10_000;

export interface OrderListArgs {
  readonly period: Period;
  readonly compare: Period | null;
  readonly scope: DataScope;
  readonly params: OrderParams;
}

interface Context {
  readonly refs: OrderRefs;
  readonly placements: PlacementIndex;
  readonly filter: OrderQueryFilter;
}

async function context(
  tx: Tx,
  viewer: Viewer,
  args: Pick<OrderListArgs, "period" | "scope" | "params">,
  now: Date,
): Promise<Context> {
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const titles = await queryTitles(tx, orgId);
  const placements = await queryPlacements(tx, orgId);
  const machines = await queryMachines(tx, orgId, placements, today);
  const stores = await queryStores(tx, orgId);
  const refs = buildRefs({ titles, machines, stores });
  const filter: OrderQueryFilter = {
    period: args.period,
    placements,
    storeId: args.scope.storeId,
    machineId: args.scope.machineId,
    titleId: args.params.titleId,
    terms: matchTerms(searchTerms(args.params.q), refs),
  };
  return { refs, placements: new PlacementIndex(placements), filter };
}

function withStore(rows: readonly RawOrderRow[], placements: PlacementIndex): OrderRow[] {
  return rows.map((r) => ({
    ...r,
    storeId: r.machineId ? placements.storeOn(r.machineId, r.businessDate) : null,
  }));
}

/**
 * Orderna som rader för beräkningslagret, en per order, ur belopp och antal. Bara
 * beloppet används av snittordern; övriga fält är platshållare.
 */
function linesFromAmounts(
  amounts: readonly { amountOre: number; count: number }[],
  businessDate: IsoDate,
): OrderLine[] {
  const lines: OrderLine[] = [];
  for (const a of amounts) {
    const line: OrderLine = {
      id: "urval",
      externalId: "urval",
      titleId: "urval",
      machineId: null,
      businessDate,
      amountOre: a.amountOre,
    };
    for (let i = 0; i < a.count; i++) lines.push(line);
  }
  return lines;
}

async function asEconomyViewer<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, fn);
}

/** Listans huvud och första sida: antal, summa, jämförelse, senaste order och rader. */
export async function loadOrderListFor(
  viewer: Viewer,
  args: OrderListArgs,
  now: Date = new Date(),
  limit: number = FIRST_PAGE,
): Promise<OrderList> {
  const orgId = viewer.organization.id;
  return asEconomyViewer(viewer, async (tx) => {
    const ctx = await context(tx, viewer, args, now);
    const totals = await queryOrderTotals(tx, orgId, ctx.filter);
    const compareTotals = args.compare
      ? await queryOrderTotals(tx, orgId, ctx.filter, args.compare)
      : null;
    // Snittordern räknas i beräkningslagret (netto, som på Hem), ur beloppen i urvalet.
    const averageOre =
      totals.count > 0
        ? averageOrderValueOre(
            linesFromAmounts(await queryOrderAmounts(tx, orgId, ctx.filter), args.period.start),
            await querySettings(tx, orgId),
          )
        : null;
    const span = await queryOrderSpan(tx, orgId, ctx.filter);
    const hasOrders = span.latestAt !== null || (await queryHasOrders(tx, orgId));
    const page = await queryOrderRows(
      tx,
      orgId,
      ctx.filter,
      args.params.sort,
      sortRanks(ctx.refs),
      0,
      limit,
    );
    return {
      period: args.period,
      compare: args.compare,
      totals,
      compareTotals,
      averageOrderValueOre: averageOre,
      hasOrders,
      latestOrderAt: span.latestAt,
      firstOrderDate: span.firstDate,
      rows: withStore(page.rows, ctx.placements),
      nextOffset: page.more ? page.rows.length : null,
      refs: ctx.refs,
    };
  });
}

/**
 * Nästa sida i samma sortering (när man scrollar). I tidsordning börjar sidan efter
 * `start.afterId` (markör), så att order som importeras under tiden inte förskjuter
 * raderna; annars från `start.offset`.
 */
export async function loadOrderPageFor(
  viewer: Viewer,
  args: Omit<OrderListArgs, "compare">,
  start: OrderPageStart,
  now: Date = new Date(),
  limit: number = NEXT_PAGE,
): Promise<OrderPage> {
  const offset = Number.isSafeInteger(start.offset) && start.offset > 0 ? start.offset : 0;
  const size = Math.min(Math.max(1, Math.trunc(limit)), 5000);
  const orgId = viewer.organization.id;
  return asEconomyViewer(viewer, async (tx) => {
    const ctx = await context(tx, viewer, args, now);
    let after: TimeCursor | null = null;
    if (args.params.sort.key === "tid" && start.afterId && isUuid(start.afterId)) {
      const id = start.afterId.toLowerCase();
      const at = await queryOrderedAtText(tx, orgId, id);
      if (at) after = { orderedAt: at, id };
    }
    const page = await queryOrderRows(
      tx,
      orgId,
      ctx.filter,
      args.params.sort,
      sortRanks(ctx.refs),
      offset,
      size,
      false,
      after,
    );
    return {
      rows: withStore(page.rows, ctx.placements),
      nextOffset: page.more ? offset + page.rows.length : null,
    };
  });
}

/** Alla rader som matchar (för CSV), högst EXPORT_LIMIT. */
export async function loadOrderExportFor(
  viewer: Viewer,
  args: Omit<OrderListArgs, "compare">,
  now: Date = new Date(),
): Promise<{ rows: OrderRow[]; refs: OrderRefs; truncated: boolean }> {
  return asEconomyViewer(viewer, async (tx) => {
    const ctx = await context(tx, viewer, args, now);
    const page = await queryOrderRows(
      tx,
      viewer.organization.id,
      ctx.filter,
      args.params.sort,
      sortRanks(ctx.refs),
      0,
      EXPORT_LIMIT,
      true,
    );
    return {
      rows: withStore(page.rows, ctx.placements),
      refs: ctx.refs,
      truncated: page.more,
    };
  });
}

export interface OrderExportSink {
  /**
   * Anropas en gång före första satsen med antalet order och namnen. Returnerar false
   * för att avbryta (för många order); då hämtas inga rader.
   */
  begin(info: { readonly count: number; readonly refs: OrderRefs }): boolean;
  /** En sats rader i vald sortering. Får vänta (mottryck). */
  batch(rows: OrderRow[]): Promise<void>;
}

/**
 * Exporten som ström: räknar urvalet, och om det ryms (högst EXPORT_LIMIT) hämtas alla
 * rader i satser om EXPORT_BATCH ur en databasmarkör i samma transaktion. Ingen sats
 * hålls kvar i minnet efter att den skickats vidare.
 */
export async function streamOrderExportFor(
  viewer: Viewer,
  args: Omit<OrderListArgs, "compare">,
  sink: OrderExportSink,
  now: Date = new Date(),
  batch: number = EXPORT_BATCH,
): Promise<void> {
  const orgId = viewer.organization.id;
  await asEconomyViewer(viewer, async (tx) => {
    const ctx = await context(tx, viewer, args, now);
    const { count } = await queryOrderTotals(tx, orgId, ctx.filter);
    if (!sink.begin({ count, refs: ctx.refs })) return;
    await forEachOrderRowBatch(
      tx,
      orgId,
      ctx.filter,
      args.params.sort,
      sortRanks(ctx.refs),
      batch,
      (rows) => sink.batch(withStore(rows, ctx.placements)),
    );
  });
}

/** En order med import och källa, eller null (finns inte, eller annan organisation). */
export async function loadOrderDetailFor(
  viewer: Viewer,
  orderId: string,
): Promise<OrderDetail | null> {
  if (!isUuid(orderId)) return null;
  const orgId = viewer.organization.id;
  return asEconomyViewer(viewer, async (tx) => {
    const r = await queryOrderDetail(tx, orgId, orderId.toLowerCase());
    if (!r) return null;
    let store: OrderDetail["store"] = null;
    if (r.machineId) {
      const placements = new PlacementIndex(await queryPlacements(tx, orgId));
      const storeId = placements.storeOn(r.machineId, r.businessDate);
      if (storeId) {
        const found = (await queryStores(tx, orgId)).find((s) => s.id === storeId);
        if (found) store = { id: found.id, name: found.name };
      }
    }
    return {
      id: r.id,
      externalId: r.externalId,
      orderedAt: r.orderedAt,
      businessDate: r.businessDate,
      amountOre: r.amountOre,
      paymentMethod: r.paymentMethod,
      rawTitle: r.rawTitle,
      title:
        r.titleId && r.titleName
          ? { id: r.titleId, name: r.titleName, series: r.titleSeries }
          : null,
      machine:
        r.machineId && r.machineCode
          ? { id: r.machineId, code: r.machineCode, name: r.machineName ?? r.machineCode }
          : null,
      store,
      sourceMachine: r.sourceMachineExternalId
        ? {
            externalId: r.sourceMachineExternalId,
            externalName: r.sourceMachineName,
            deviceNo: r.sourceMachineDeviceNo,
          }
        : null,
      dataSource: { id: r.dataSourceId, name: r.dataSourceName, provider: r.dataSourceProvider },
      import:
        r.importId && r.importTrigger && r.importAt
          ? {
              id: r.importId,
              fileName: r.importFileName,
              trigger: r.importTrigger,
              at: r.importAt,
              rowNumber: r.importRowNumber,
            }
          : null,
      lateInClosedPeriod: r.lateInClosedPeriod,
      createdAt: r.createdAt,
    };
  });
}
