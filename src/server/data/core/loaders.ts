/**
 * De gemensamma laddarna, bundna till en given användare och organisation.
 *
 * Varje funktion kontrollerar rollen mot databasen (requireRoleFor, läst under RLS) och
 * läser sedan allt i EN transaktion som användaren (withUserDbFor, RLS). Inget läses som
 * databasägare. Sidorna använder inte de här direkt utan de request-memoiserade
 * varianterna i ./index.ts; de här finns för att kunna testas utan Next (test/db).
 *
 * Påfyllaren får aldrig ekonomi: loadDomainInputFor kastar AuthorizationError, och
 * laddarna som påfyllaren får använda (stamdata, lager, försäljning i antal, Att göra)
 * returnerar inga belopp. RLS är det andra lagret.
 */

import {
  applyDismissals,
  computeTodos,
  type AnalyticsOrder,
  type TodoInput,
  type TodoItem,
  type TodoKind,
} from "@/analytics/todos";
import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";
import {
  addDays,
  maxDate,
  minDate,
  type EconomicsSources,
  type IsoDate,
  type MachineInvestment,
  type Period,
  type ProfitabilityInput,
} from "@/domain";
import {
  requireRoleFor,
  withUserDbFor,
  type OrganizationMembership,
  type SessionUser,
} from "@/server/access";
import { todayIn, toIsoDate } from "@/components/shell/period-state";
import { loadCoverage } from "@/server/alerts/inputs";

import {
  DEFAULT_SETTINGS,
  queryActiveContracts,
  queryAgreements,
  queryDataSources,
  queryDisplayName,
  queryFirstOrderDate,
  queryFirstSaleDate,
  queryInvestments,
  queryMachineCountsByOrg,
  queryMachines,
  queryOpenAlerts,
  queryOrders,
  queryPlacements,
  queryPrices,
  queryReportDeliveries,
  queryReportDrafts,
  queryReportRecipients,
  querySaleEventsAsOrders,
  querySalesCounts,
  querySettings,
  queryStock,
  queryStores,
  queryTitles,
  queryTodoDismissals,
} from "./queries";
import {
  ALL_ROLES,
  canSeeEconomy,
  ECONOMY_ROLES,
  OPERATOR_ROLES,
  type AppContext,
  type DataScope,
  type DomainInput,
  type MasterData,
  type PlacementRecord,
  type SalesCounts,
  type StockSnapshot,
  type SyncInfo,
} from "./types";

/** Den som tittar: verifierad användare och aktiv organisation (med roll). */
export interface Viewer {
  readonly user: SessionUser;
  readonly organization: OrganizationMembership;
}

const NO_SCOPE: DataScope = { storeId: null, machineId: null };

/** Dagens affärsdatum i tidszonen. */
export function businessToday(now: Date, timeZone: string): IsoDate {
  return toIsoDate(todayIn(now, timeZone));
}

/** Kör fn som användaren efter en rollkontroll mot databasen. Returnerar den aktuella rollen. */
async function asViewer<T>(
  viewer: Viewer,
  roles: readonly MemberRole[],
  fn: (tx: Tx, role: MemberRole) => Promise<T>,
): Promise<T> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, roles);
  return withUserDbFor(viewer.user, (tx) => fn(tx, role));
}

// ---------------------------------------------------------------------------
// Kontext
// ---------------------------------------------------------------------------

export async function loadContextFor(
  viewer: Viewer,
  organizations: readonly OrganizationMembership[],
  now: Date = new Date(),
): Promise<AppContext> {
  const org = viewer.organization;
  return asViewer(viewer, ALL_ROLES, async (tx, role) => {
    const economy = canSeeEconomy(role);
    const [displayName, settings] = await Promise.all([
      queryDisplayName(tx, org.id, viewer.user.userId),
      economy ? querySettings(tx, org.id) : Promise.resolve(null),
    ]);
    return {
      user: { id: viewer.user.userId, email: viewer.user.email, displayName },
      organization: { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone },
      role,
      organizations: organizations.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        timezone: o.timezone,
        role: o.role,
      })),
      canSeeEconomy: economy,
      canEdit: (OPERATOR_ROLES as readonly MemberRole[]).includes(role),
      settings,
      timeZone: org.timezone,
      now: now.toISOString(),
      today: businessToday(now, org.timezone),
    };
  });
}

/** Antal aktiva automater per organisation (för organisationsväxlaren). */
export async function loadMachineCountsFor(
  user: SessionUser,
  organizations: readonly OrganizationMembership[],
): Promise<Map<string, number>> {
  return withUserDbFor(user, (tx) =>
    queryMachineCountsByOrg(
      tx,
      organizations.map((o) => o.id),
    ),
  );
}

// ---------------------------------------------------------------------------
// Stamdata och första dag med data
// ---------------------------------------------------------------------------

async function masterData(tx: Tx, orgId: string, today: IsoDate): Promise<MasterData> {
  const [titles, placements, stores] = await Promise.all([
    queryTitles(tx, orgId),
    queryPlacements(tx, orgId),
    queryStores(tx, orgId),
  ]);
  const machines = await queryMachines(tx, orgId, placements, today);
  return { titles, machines, stores, placements };
}

/** Titlar, automater (med aktuell butik), butiker och placeringar. Alla roller. */
export async function loadMasterDataFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<MasterData> {
  const today = businessToday(now, viewer.organization.timezone);
  return asViewer(viewer, ALL_ROLES, (tx) => masterData(tx, viewer.organization.id, today));
}

/**
 * Första dagen med data: första ordern för roller som ser ekonomi, första försäljningen i
 * lagret för påfyllare. null om det inte finns något.
 */
export async function loadDataStartFor(viewer: Viewer): Promise<IsoDate | null> {
  return asViewer(viewer, ALL_ROLES, (tx, role) =>
    canSeeEconomy(role)
      ? queryFirstOrderDate(tx, viewer.organization.id)
      : queryFirstSaleDate(tx, viewer.organization.id),
  );
}

// ---------------------------------------------------------------------------
// Beräkningsindata (bara roller som ser ekonomi)
// ---------------------------------------------------------------------------

export interface DomainInputArgs {
  /** Perioden ('ÅÅÅÅ-MM-DD', båda ändar inräknade). */
  readonly period: Period;
  /** Jämförelseperioden, eller null/utelämnad för ingen jämförelse. */
  readonly compare?: Period | null;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
}

interface ScopedSources {
  readonly sources: EconomicsSources;
  readonly investments: MachineInvestment[];
}

/**
 * Begränsar avtal, placeringar och investeringar till filtret, så att andra butikers hyra
 * inte räknas in. Ingen beräkning: bara urval av rader.
 */
function scopeSources(
  all: EconomicsSources & { readonly placements: readonly PlacementRecord[] },
  investments: readonly MachineInvestment[],
  scope: DataScope,
): ScopedSources {
  if (!scope.storeId && !scope.machineId) {
    return { sources: all, investments: [...investments] };
  }
  const placements = all.placements.filter(
    (p) =>
      (!scope.storeId || p.storeId === scope.storeId) &&
      (!scope.machineId || p.machineId === scope.machineId),
  );
  const storeIds = new Set(placements.map((p) => p.storeId));
  if (scope.storeId) storeIds.add(scope.storeId);
  const machineIds = new Set(placements.map((p) => p.machineId));
  if (scope.machineId) machineIds.add(scope.machineId);
  return {
    sources: {
      prices: all.prices,
      settings: all.settings,
      placements,
      agreements: all.agreements.filter((a) => storeIds.has(a.storeId)),
    },
    investments: investments.filter((i) => machineIds.has(i.machineId)),
  };
}

function normalizeScope(args: { storeId?: string | null; machineId?: string | null }): DataScope {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim().toLowerCase() : null);
  return { storeId: clean(args.storeId), machineId: clean(args.machineId) };
}

/**
 * Allt profitability(), titleEconomics(), unitEconomics(), keyMetrics() m.fl. behöver för
 * perioden och jämförelseperioden. Bara ägare, admin och läsare (kastar
 * AuthorizationError("forbidden") för påfyllare).
 */
export async function loadDomainInputFor(
  viewer: Viewer,
  args: DomainInputArgs,
  now: Date = new Date(),
): Promise<DomainInput> {
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const scope = normalizeScope(args);
  const period = args.period;
  const compare = args.compare ?? null;
  const span: Period = compare
    ? { start: minDate(period.start, compare.start), end: maxDate(period.end, compare.end) }
    : period;

  return asViewer(viewer, ECONOMY_ROLES, async (tx) => {
    const master = await masterData(tx, orgId, today);
    const [prices, agreements, investments, settings, orderResult] = await Promise.all([
      queryPrices(tx, orgId),
      queryAgreements(tx, orgId),
      queryInvestments(tx, orgId),
      querySettings(tx, orgId),
      queryOrders(tx, orgId, span, scope),
    ]);
    const scoped = scopeSources(
      { prices, agreements, placements: master.placements, settings },
      investments,
      scope,
    );
    const inRange = (o: AnalyticsOrder, p: Period) =>
      o.businessDate >= p.start && o.businessDate <= p.end;
    const currentOrders = orderResult.orders.filter((o) => inRange(o, period));
    const input = (
      orders: AnalyticsOrder[],
      p: Period,
    ): ProfitabilityInput & { orders: AnalyticsOrder[] } => ({
      ...scoped.sources,
      orders,
      period: p,
    });
    return {
      ...master,
      period,
      compare,
      scope,
      current: input(currentOrders, period),
      previous: compare
        ? input(
            orderResult.orders.filter((o) => inRange(o, compare)),
            compare,
          )
        : null,
      sources: scoped.sources,
      investments: scoped.investments,
      settings,
      diagnostics: {
        // Order utan titel räknas över hela spannet; de förekommer inte efter en lyckad import.
        ordersWithoutTitle: orderResult.withoutTitle,
        ordersWithoutMachine: currentOrders.filter((o) => o.machineId === null).length,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Lager och försäljning i antal (alla roller)
// ---------------------------------------------------------------------------

/** Lagersaldon just nu. Alla roller, inga belopp. */
export async function loadStockFor(viewer: Viewer): Promise<StockSnapshot> {
  return asViewer(viewer, ALL_ROLES, async (tx) => {
    const rows = await queryStock(tx, viewer.organization.id);
    return {
      rows,
      machineStock: rows
        .filter((r) => r.locationKind === "machine" && r.machineId !== null)
        .map((r) => ({
          machineId: r.machineId as string,
          titleId: r.titleId,
          onHand: r.onHand,
          lastRestockedAt: r.lastRestockedAt,
        })),
      warehouse: rows.filter((r) => r.isCentral),
    };
  });
}

export interface SalesCountsArgs {
  readonly period: Period;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
}

/** Sålda pack per dag, titel och automat (lagerhändelser av typen sale). Alla roller, inga belopp. */
export async function loadSalesCountsFor(
  viewer: Viewer,
  args: SalesCountsArgs,
): Promise<SalesCounts> {
  const scope = normalizeScope(args);
  return asViewer(viewer, ALL_ROLES, async (tx) => {
    const rows = await querySalesCounts(tx, viewer.organization.id, args.period, scope);
    return {
      period: args.period,
      scope,
      rows,
      units: rows.reduce((sum, r) => sum + r.units, 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Synk och Att göra
// ---------------------------------------------------------------------------

/** Data äldre än så här räknas som inaktuell i skalet. */
export const STALE_SYNC_HOURS = 26;

/** Senaste synk. null för påfyllare (datakällor är inte deras). */
export async function loadSyncInfoFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<SyncInfo | null> {
  if (!canSeeEconomy(viewer.organization.role)) return null;
  return asViewer(viewer, ECONOMY_ROLES, async (tx) => {
    const ds = await queryDataSources(tx, viewer.organization.id);
    const stale =
      ds.lastSyncedAt === null ||
      now.getTime() - ds.lastSyncedAt.getTime() > STALE_SYNC_HOURS * 3_600_000;
    return {
      syncedAt: ds.lastSyncedAt ? ds.lastSyncedAt.toISOString() : null,
      state: ds.failing > 0 ? "failed" : stale ? "stale" : "ok",
      sources: ds.sources,
    };
  });
}

/** Dagar bakåt som Att göra läser order (fönstren är 14 och 30 dagar). */
const TODO_LOOKBACK_DAYS = 45;
/** Dagar bakåt för rapportutskick (förra månadens rapporter). */
const TODO_REPORT_LOOKBACK_DAYS = 75;
/** Punkterna en påfyllare ser: de som gäller lagret och automaterna. */
const REFILLER_TODO_KINDS: ReadonlySet<TodoKind> = new Set(["refill", "stale-machine"]);

/**
 * Tar bort det som är ekonomi ur en punkt som räknats på order utan belopp:
 * kronor i risk, beloppstal i underlaget och "… och 0 kr per dag" i texten.
 */
function withoutEconomy(item: TodoItem): TodoItem {
  return {
    ...item,
    atStakeOre: null,
    detail: item.detail.replace(/ och [^.()]*?kr per dag/g, ""),
    evidence: {
      ...item.evidence,
      orderIds: [],
      figures: item.evidence.figures.filter((f) => f.unit !== "ore"),
    },
  };
}

/** Punkterna i Att göra före och efter avbockningarna. */
export interface TodoState {
  /** Det som står i listan: sorterat efter brådska, utan avbockade. */
  readonly items: TodoItem[];
  /**
   * Punkter som finns (orsaken finns kvar) men är avbockade med samma fingerprint. En
   * avbockning vars nyckel inte står här har en orsak som är löst eller ändrad.
   */
  readonly dismissed: TodoItem[];
}

/**
 * Punkterna i Att göra, sorterade efter brådska och utan avbockade. Ägare och admin får
 * alla regler; påfyllaren påfyllning och tysta automater, räknade på försäljningen i
 * lagret (utan belopp). Läsaren har ingen Att göra-lista (tom).
 */
export async function loadTodosFor(viewer: Viewer, now: Date = new Date()): Promise<TodoItem[]> {
  return (await loadTodoStateFor(viewer, now)).items;
}

/**
 * Som loadTodosFor, men med de avbockade punkterna vars orsak finns kvar (för listan
 * "Avbockade" i Att göra, som då inte visar punkter som redan är lösta).
 *
 * Ägare och admin får också larm som kräver åtgärd, rapportutkast att granska och avtal
 * att säga upp eller omförhandla (påminnelsen 90 dagar före sista uppsägningsdag).
 */
export async function loadTodoStateFor(viewer: Viewer, now: Date = new Date()): Promise<TodoState> {
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const range: Period = { start: addDays(today, -TODO_LOOKBACK_DAYS), end: today };

  return asViewer(viewer, ALL_ROLES, async (tx, role) => {
    if (role === "viewer") return { items: [], dismissed: [] };
    const economy = canSeeEconomy(role);
    const master = await masterData(tx, orgId, today);
    const stockRows = await queryStock(tx, orgId);
    const stock = stockRows
      .filter((r) => r.locationKind === "machine" && r.machineId !== null)
      .map((r) => ({
        machineId: r.machineId as string,
        titleId: r.titleId,
        onHand: r.onHand,
        lastRestockedAt: r.lastRestockedAt,
      }));
    const dismissals = await queryTodoDismissals(tx, orgId);
    // Hur långt försäljningen är importerad per automat: tystnaden räknas fram till dit,
    // som på Drift (maskinhälsan), så att alla sidor säger samma antal timmar.
    const salesDataUntil = (await loadCoverage(tx, orgId, now)).map((c) => ({
      machineId: c.machineId,
      until: c.dataUntil?.toISOString() ?? null,
    }));

    let input: TodoInput;
    if (economy) {
      const reportSince = addDays(today, -TODO_REPORT_LOOKBACK_DAYS);
      const [prices, agreements, settings, orders, recipients, deliveries] = await Promise.all([
        queryPrices(tx, orgId),
        queryAgreements(tx, orgId),
        querySettings(tx, orgId),
        queryOrders(tx, orgId, range, NO_SCOPE),
        queryReportRecipients(tx, orgId),
        queryReportDeliveries(tx, orgId, reportSince),
      ]);
      const [drafts, contracts, alerts] = await Promise.all([
        queryReportDrafts(tx, orgId, reportSince),
        queryActiveContracts(tx, orgId),
        queryOpenAlerts(tx, orgId),
      ]);
      input = {
        orders: orders.orders,
        prices,
        agreements,
        placements: master.placements,
        settings,
        titles: master.titles,
        machines: master.machines,
        stores: master.stores,
        stock,
        reportRecipients: recipients,
        reportDeliveries: deliveries,
        reportDrafts: drafts,
        contracts,
        alerts,
        salesDataUntil,
        options: { timeZone },
      };
    } else {
      input = {
        orders: await querySaleEventsAsOrders(tx, orgId, range),
        prices: [],
        agreements: [],
        placements: master.placements,
        settings: DEFAULT_SETTINGS,
        titles: master.titles,
        machines: master.machines,
        stores: master.stores,
        stock,
        reportRecipients: [],
        reportDeliveries: [],
        salesDataUntil,
        options: { timeZone },
      };
    }

    const computed = computeTodos(input, now);
    const visible = economy
      ? computed
      : computed.filter((t) => REFILLER_TODO_KINDS.has(t.kind)).map(withoutEconomy);
    const items = applyDismissals(visible, dismissals);
    const shown = new Set(items.map((t) => t.key));
    return { items, dismissed: visible.filter((t) => !shown.has(t.key)) };
  });
}
