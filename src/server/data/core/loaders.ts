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
import { cache } from "react";

import {
  AuthorizationError,
  getRoleFor,
  MEMBER_ROLES,
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
  queryLastOrderDate,
  queryMachineCountsByOrg,
  queryMasterData,
  queryOpenAlerts,
  queryOrders,
  queryOrganizationsWithMachines,
  queryPrices,
  queryReportDeliveries,
  queryReportDrafts,
  queryReportRecipients,
  querySaleEventsAsOrders,
  querySalesCounts,
  querySettings,
  queryStock,
  queryTodoDismissals,
} from "./queries";
import { effectivePlacements } from "./placements";
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
  type StockRow,
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

/**
 * Viewers vars roll redan lästs ur databasen under RLS i den här förfrågan
 * (organisationen kommer från listOrganizationsFor, se ./index.ts). För dem läses
 * rollen inte en gång till före varje laddare: det var en egen transaktion per
 * laddare (15 på Hem, cirka 150 ms vardera mot databasen i drift).
 */
const verifiedViewers = new WeakSet<Viewer>();

/**
 * Markerar att viewerns organisation och roll är lästa ur databasen (under RLS) i den
 * här förfrågan. Bara för ./index.ts, som bygger viewern ur getActiveOrganization.
 */
export function verifiedViewer(viewer: Viewer): Viewer {
  verifiedViewers.add(viewer);
  return viewer;
}

/** Rollen ur databasen, en gång per förfrågan och organisation (React cache i serverkomponenter). */
const roleInRequest = cache(
  (userId: string, email: string, organizationId: string): Promise<MemberRole | null> =>
    getRoleFor({ userId, email }, organizationId),
);

/**
 * Kräver en av rollerna. Rollen läses ur databasen (under RLS), om den inte redan
 * lästs så i förfrågan (verifiedViewer). Kastar AuthorizationError("forbidden").
 */
export async function requireViewerRole(
  viewer: Viewer,
  roles: readonly MemberRole[],
): Promise<MemberRole> {
  const role = verifiedViewers.has(viewer)
    ? viewer.organization.role
    : await roleInRequest(viewer.user.userId, viewer.user.email, viewer.organization.id);
  if (role === null || !roles.includes(role)) throw new AuthorizationError("forbidden");
  return role;
}

/** Kör fn som användaren efter rollkontrollen. Returnerar den aktuella rollen. */
async function asViewer<T>(
  viewer: Viewer,
  roles: readonly MemberRole[],
  fn: (tx: Tx, role: MemberRole) => Promise<T>,
): Promise<T> {
  const role = await requireViewerRole(viewer, roles);
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

/**
 * Organisationerna där användaren är medlem (som listOrganizationsFor) och antal aktiva
 * automater i var och en (som loadMachineCountsFor), i en transaktion.
 */
export async function loadOrganizationsFor(user: SessionUser): Promise<{
  organizations: OrganizationMembership[];
  machineCounts: Map<string, number>;
}> {
  const rows = await withUserDbFor(user, (tx) => queryOrganizationsWithMachines(tx));
  const organizations: OrganizationMembership[] = [];
  const machineCounts = new Map<string, number>();
  for (const r of rows) {
    const role = MEMBER_ROLES.find((x) => x === r.role);
    if (!role) continue;
    organizations.push({ id: r.id, name: r.name, slug: r.slug, timezone: r.timezone, role });
    // Som queryMachineCountsByOrg: organisationer utan automater saknas i kartan.
    if (r.machines > 0) machineCounts.set(r.id, r.machines);
  }
  return { organizations, machineCounts };
}

// ---------------------------------------------------------------------------
// Stamdata och första dag med data
// ---------------------------------------------------------------------------

/**
 * Stamdata en gång per förfrågan (React cache): layouten, Hem, Att göra och
 * beräkningsindata använde den var för sig (fem gånger per sidladdning på Hem).
 * Bara efter en rollkontroll (requireViewerRole).
 */
const masterInRequest = cache(
  (userId: string, email: string, orgId: string, today: IsoDate): Promise<MasterData> =>
    withUserDbFor({ userId, email }, (tx) => queryMasterData(tx, orgId, today)),
);

function masterData(viewer: Viewer, today: IsoDate): Promise<MasterData> {
  return masterInRequest(viewer.user.userId, viewer.user.email, viewer.organization.id, today);
}

/** Titlar, automater (med aktuell butik), butiker och placeringar. Alla roller. */
export async function loadMasterDataFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<MasterData> {
  const today = businessToday(now, viewer.organization.timezone);
  await requireViewerRole(viewer, ALL_ROLES);
  return masterData(viewer, today);
}

interface EconomyBase {
  readonly prices: Awaited<ReturnType<typeof queryPrices>>;
  readonly agreements: Awaited<ReturnType<typeof queryAgreements>>;
  readonly investments: Awaited<ReturnType<typeof queryInvestments>>;
  readonly settings: Awaited<ReturnType<typeof querySettings>>;
}

/**
 * Priser, avtal, investeringar och inställningar en gång per förfrågan (React cache):
 * samma för alla perioder, så Hem (perioden och dagarna efter), Att göra och
 * Lönsamhet med filter (filtret och hela organisationen) delar dem. Bara efter en
 * rollkontroll mot ECONOMY_ROLES.
 */
const economyInRequest = cache(
  (userId: string, email: string, orgId: string): Promise<EconomyBase> =>
    withUserDbFor({ userId, email }, async (tx) => {
      const [prices, agreements, investments, settings] = await Promise.all([
        queryPrices(tx, orgId),
        queryAgreements(tx, orgId),
        queryInvestments(tx, orgId),
        querySettings(tx, orgId),
      ]);
      return { prices, agreements, investments, settings };
    }),
);

function economyBase(viewer: Viewer): Promise<EconomyBase> {
  return economyInRequest(viewer.user.userId, viewer.user.email, viewer.organization.id);
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

  await requireViewerRole(viewer, ECONOMY_ROLES);
  // Stamdata och priser m.m. är gemensamma för förfrågan och läses parallellt med
  // perioden; i transaktionen nedan bara det som beror på perioden och filtret.
  const masterP = masterData(viewer, today);
  const baseP = economyBase(viewer);
  // Avvisas transaktionen först väntar ingen på dessa; felet kommer därifrån.
  masterP.catch(() => {});
  baseP.catch(() => {});
  return withUserDbFor(viewer.user, async (tx) => {
    const orderResult = await queryOrders(tx, orgId, span, scope);
    const [master, { prices, agreements, investments, settings }] = await Promise.all([
      masterP,
      baseP,
    ]);
    const scoped = scopeSources(
      {
        prices,
        agreements,
        placements: effectivePlacements(master.placements, orderResult.orders),
        settings,
      },
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

/**
 * Senaste affärsdagen med en order i perioden och filtret (samma urval som
 * loadDomainInputFor), eller null. Bara ägare, admin och läsare.
 */
export async function loadLastOrderDateFor(
  viewer: Viewer,
  args: { period: Period; storeId?: string | null; machineId?: string | null },
): Promise<IsoDate | null> {
  return asViewer(viewer, ECONOMY_ROLES, (tx) =>
    queryLastOrderDate(tx, viewer.organization.id, args.period, normalizeScope(args)),
  );
}

// ---------------------------------------------------------------------------
// Lager och försäljning i antal (alla roller)
// ---------------------------------------------------------------------------

const stockInRequest = cache((userId: string, email: string, orgId: string): Promise<StockRow[]> =>
  withUserDbFor({ userId, email }, (tx) => queryStock(tx, orgId)),
);

/**
 * Lagerraderna en gång per förfrågan (React cache): Lager, Att göra och larmgränserna
 * läste dem var för sig. Anroparen har kontrollerat rollen (alla roller får läsa lagret).
 */
export function stockRowsInRequest(viewer: Viewer): Promise<StockRow[]> {
  return stockInRequest(viewer.user.userId, viewer.user.email, viewer.organization.id);
}

/** Lagersaldon just nu. Alla roller, inga belopp. */
export async function loadStockFor(viewer: Viewer): Promise<StockSnapshot> {
  await requireViewerRole(viewer, ALL_ROLES);
  const rows = await stockRowsInRequest(viewer);
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
    const [ds, firstOrder] = await Promise.all([
      queryDataSources(tx, viewer.organization.id),
      queryFirstOrderDate(tx, viewer.organization.id),
    ]);
    // Ett hjärtslag eller en lyckad synk utan rader sätter last_synced_at. Utan en enda
    // importerad order finns ingen synk att visa: skalet skriver "Ingen synk än".
    if (firstOrder === null) {
      return { syncedAt: null, state: ds.failing > 0 ? "failed" : "ok", sources: ds.sources };
    }
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

  const role = await requireViewerRole(viewer, ALL_ROLES);
  if (role === "viewer") return { items: [], dismissed: [] };
  const economy = canSeeEconomy(role);
  const masterP = masterData(viewer, today);
  const baseP = economy ? economyBase(viewer) : null;
  const stockP = stockRowsInRequest(viewer);
  masterP.catch(() => {});
  baseP?.catch(() => {});
  stockP.catch(() => {});

  return withUserDbFor(viewer.user, async (tx) => {
    const [dismissals, coverage] = await Promise.all([
      queryTodoDismissals(tx, orgId),
      loadCoverage(tx, orgId, now),
    ]);
    const [master, stockRows] = await Promise.all([masterP, stockP]);
    const stock = stockRows
      .filter((r) => r.locationKind === "machine" && r.machineId !== null)
      .map((r) => ({
        machineId: r.machineId as string,
        titleId: r.titleId,
        onHand: r.onHand,
        lastRestockedAt: r.lastRestockedAt,
      }));
    // Hur långt försäljningen är importerad per automat: tystnaden räknas fram till dit,
    // som på Drift (maskinhälsan), så att alla sidor säger samma antal timmar.
    const salesDataUntil = coverage.map((c) => ({
      machineId: c.machineId,
      until: c.dataUntil?.toISOString() ?? null,
    }));

    let input: TodoInput;
    if (baseP) {
      const reportSince = addDays(today, -TODO_REPORT_LOOKBACK_DAYS);
      const [orders, recipients, deliveries, drafts, contracts, alerts] = await Promise.all([
        queryOrders(tx, orgId, range, NO_SCOPE),
        queryReportRecipients(tx, orgId),
        queryReportDeliveries(tx, orgId, reportSince),
        queryReportDrafts(tx, orgId, reportSince),
        queryActiveContracts(tx, orgId),
        queryOpenAlerts(tx, orgId),
      ]);
      const { prices, agreements, settings } = await baseP;
      input = {
        orders: orders.orders,
        prices,
        agreements,
        placements: effectivePlacements(master.placements, orders.orders),
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
