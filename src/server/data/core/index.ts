/**
 * Gemensamma serverladdare för alla sidor i appen (src/app/(app)).
 *
 * Allt läses som den inloggade användaren med RLS (withUserDb), rollen kontrolleras mot
 * databasen i varje laddare, och resultaten memoiseras per förfrågan (React cache), så
 * att layouten och sidan kan anropa samma laddare utan dubbla frågor.
 *
 *   const ctx = await loadContext();                       // vem, var, roll, tidszon
 *   const p = await loadPeriod(await searchParams);        // ?period ?from ?to ?butik ?automat
 *   const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
 *   const result = profitability(input.current, "machine"); // @/domain
 *
 * Påfyllare: loadDomainInput kastar AuthorizationError. Använd loadMasterData, loadStock
 * och loadSalesCounts (inga belopp). Sidor som inte är till för rollen: requireRoute().
 */

import "server-only";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { TodoItem } from "@/analytics/todos";
import { deniedHref, routeById, type RouteId } from "@/components/shell/nav";
import type { SearchParamsInput } from "@/components/shell/period-state";
import type { MemberRole } from "@/db/schema";
import type { IsoDate, Period } from "@/domain";
import { listOrganizationsFor } from "@/server/access";
import {
  AuthorizationError,
  getActiveOrganization,
  requireUser,
  type OrganizationMembership,
} from "@/server/session";

import {
  loadContextFor,
  loadDataStartFor,
  loadDomainInputFor,
  loadMachineCountsFor,
  loadMasterDataFor,
  loadSalesCountsFor,
  loadStockFor,
  loadSyncInfoFor,
  loadTodoStateFor,
  type DomainInputArgs,
  type SalesCountsArgs,
  type TodoState,
  type Viewer,
} from "./loaders";
import { resolveAppPeriod } from "./period";
import type {
  AppContext,
  AppPeriod,
  DomainInput,
  MasterData,
  SalesCounts,
  StockSnapshot,
  SyncInfo,
} from "./types";

export * from "./types";
export { isoDateToShellDate, resolveAppPeriod, scopeFromSearchParams } from "./period";
export { STALE_SYNC_HOURS, type DomainInputArgs, type SalesCountsArgs } from "./loaders";

/** Tidpunkten förfrågan räknar från (samma i alla laddare under en förfrågan). */
const requestNow = cache((): Date => new Date());

const loadOrganizations = cache(async (): Promise<OrganizationMembership[]> => {
  const user = await requireUser();
  return listOrganizationsFor(user);
});

/**
 * Användaren och den aktiva organisationen, eller null om användaren inte är medlem
 * någonstans. Skickar till /logga-in om ingen är inloggad.
 */
const loadViewer = cache(async (): Promise<Viewer | null> => {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  return organization ? { user, organization } : null;
});

async function requireViewer(): Promise<Viewer> {
  const viewer = await loadViewer();
  if (!viewer) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  return viewer;
}

/**
 * Kontexten, eller null om användaren saknar organisation (layouten visar då en
 * förklaring i stället för appen). Skickar till /logga-in om ingen är inloggad.
 */
export const loadOptionalContext = cache(async (): Promise<AppContext | null> => {
  const viewer = await loadViewer();
  if (!viewer) return null;
  return loadContextFor(viewer, await loadOrganizations(), requestNow());
});

/**
 * Vem som tittar och var: användare, aktiv organisation, roll (läst ur databasen),
 * organisationer, inställningar (null för påfyllare), tidszon och dagens affärsdatum.
 * Kastar AuthorizationError om användaren saknar organisation.
 */
export const loadContext = cache(async (): Promise<AppContext> => {
  const ctx = await loadOptionalContext();
  if (!ctx) throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  return ctx;
});

/**
 * Kräver en av rollerna (läst ur databasen). Kastar AuthorizationError("forbidden").
 * Använd i server actions: `const ctx = await requireContextRole(OPERATOR_ROLES)`.
 */
export async function requireContextRole(roles: readonly MemberRole[]): Promise<AppContext> {
  const ctx = await loadContext();
  if (!roles.includes(ctx.role)) throw new AuthorizationError("forbidden");
  return ctx;
}

/**
 * För sidor: kräver att rollen får se rutten (enligt menyns regler i
 * components/shell/nav). Annars skickas användaren till sin startsida (påfyllare:
 * Att göra). Returnerar kontexten.
 */
export async function requireRoute(id: RouteId): Promise<AppContext> {
  const ctx = await loadContext();
  // Till startsidan med ?nekad=<rutt>, som skalet förklarar (DeniedNotice).
  if (!routeById(id).roles.includes(ctx.role)) redirect(deniedHref(ctx.role, id));
  return ctx;
}

/** Första dagen med data ("Allt" börjar där). Påfyllare: första försäljningen i lagret. */
export const loadDataStart = cache(async (): Promise<IsoDate | null> =>
  loadDataStartFor(await requireViewer()),
);

/**
 * Periodvalet och filtret ur sidans searchParams, tolkade i organisationens tidszon.
 * "Allt" = från första ordern. Ta emot `await searchParams` (Next 16: searchParams är ett Promise).
 */
export async function loadPeriod(searchParams: SearchParamsInput): Promise<AppPeriod> {
  const [ctx, dataStart] = await Promise.all([loadContext(), loadDataStart()]);
  return resolveAppPeriod(searchParams, {
    timeZone: ctx.timeZone,
    dataStart,
    now: requestNow(),
  });
}

/** Titlar, automater, butiker och placeringar. Alla roller. */
export const loadMasterData = cache(async (): Promise<MasterData> =>
  loadMasterDataFor(await requireViewer(), requestNow()),
);

const loadDomainInputCached = cache(
  async (
    start: IsoDate,
    end: IsoDate,
    compareStart: IsoDate | null,
    compareEnd: IsoDate | null,
    storeId: string | null,
    machineId: string | null,
  ): Promise<DomainInput> => {
    const compare: Period | null =
      compareStart && compareEnd ? { start: compareStart, end: compareEnd } : null;
    return loadDomainInputFor(
      await requireViewer(),
      { period: { start, end }, compare, storeId, machineId },
      requestNow(),
    );
  },
);

/**
 * Indata till beräkningslagret för perioden (och jämförelsen): order, priser, avtal,
 * placeringar, inställningar, investeringar, titlar, automater och butiker. Bara
 * ägare, admin och läsare; kastar AuthorizationError("forbidden") för påfyllare.
 * Memoiseras per förfrågan på periodens och filtrets värden.
 */
export function loadDomainInput(args: DomainInputArgs): Promise<DomainInput> {
  return loadDomainInputCached(
    args.period.start,
    args.period.end,
    args.compare?.start ?? null,
    args.compare?.end ?? null,
    args.storeId ?? null,
    args.machineId ?? null,
  );
}

/** Lagersaldon just nu (alla lagerplatser). Alla roller, inga belopp. */
export const loadStock = cache(async (): Promise<StockSnapshot> =>
  loadStockFor(await requireViewer()),
);

const loadSalesCountsCached = cache(
  async (
    start: IsoDate,
    end: IsoDate,
    storeId: string | null,
    machineId: string | null,
  ): Promise<SalesCounts> =>
    loadSalesCountsFor(await requireViewer(), { period: { start, end }, storeId, machineId }),
);

/** Sålda pack per dag, titel och automat (ur lagret). Alla roller, inga belopp. */
export function loadSalesCounts(args: SalesCountsArgs): Promise<SalesCounts> {
  return loadSalesCountsCached(
    args.period.start,
    args.period.end,
    args.storeId ?? null,
    args.machineId ?? null,
  );
}

/** Senaste synk över datakällorna. null för påfyllare. */
export const loadSyncInfo = cache(async (): Promise<SyncInfo | null> =>
  loadSyncInfoFor(await requireViewer(), requestNow()),
);

/**
 * Punkterna i Att göra (@/analytics/todos), sorterade och utan avbockade. Påfyllare:
 * bara påfyllning och tysta automater, utan belopp. Läsare: tom lista.
 */
export const loadTodos = cache(async (): Promise<TodoItem[]> => (await loadTodoState()).items);

/**
 * Punkterna i Att göra med de avbockade vars orsak finns kvar, memoiserad per förfrågan:
 * menyns räknare, Hem och Att göra räknar punkterna en gång per sidladdning.
 */
export const loadTodoState = cache(async (): Promise<TodoState> =>
  loadTodoStateFor(await requireViewer(), requestNow()),
);

/** Antal automater per organisation (organisationsväxlarens detaljrad). */
export const loadMachineCounts = cache(async (): Promise<Map<string, number>> => {
  const user = await requireUser();
  return loadMachineCountsFor(user, await loadOrganizations());
});

/**
 * Efter en ändring som påverkar siffror (priser, inställningar, lager, avtal …): alla
 * sidor under appens layout räknas om vid nästa visning, även skalets räknare för Att
 * göra och synkstatus. Anropa sist i server actions, efter att ändringen sparats.
 */
export function revalidateAppData(): void {
  revalidatePath("/", "layout");
}
