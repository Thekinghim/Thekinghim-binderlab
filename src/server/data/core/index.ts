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

import { revalidatePath, revalidateTag, unstable_cache, updateTag } from "next/cache";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { cache } from "react";

import type { SettlementRef, TodoItem } from "@/analytics/todos";
import { deniedHref, routeById, type RouteId } from "@/components/shell/nav";
import {
  STORE_SHARE_HEADER,
  VMB_HEADER,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import type { MemberRole } from "@/db/schema";
import type { IsoDate, Period } from "@/domain";
import { BUILD_ID } from "@/lib/build-id";
import { NotCacheableError, decodeFromCache, encodeForCache } from "@/lib/cache-codec";
import type { CostLines } from "@/lib/cost-lines";
import { ACTIVE_ORG_COOKIE } from "@/server/auth/flows";
import { nextCookieJar } from "@/server/auth/next-cookies";
import {
  AuthorizationError,
  getSessionUser,
  requireUser,
  type OrganizationMembership,
} from "@/server/session";
import { withUserDbFor } from "@/server/access";
import { redirectStoreUserToPortal } from "@/server/portal/session";
import { guardSimpleView } from "@/server/simple-view-guard";
import { cachedUnpaidSettlements, invalidateUnpaidSettlements } from "@/server/settlements/cache";
import { queryUnpaidSettlements } from "@/server/settlements/queries";

import {
  loadContextFor,
  loadDataStartFor,
  loadDomainInputFor,
  loadLastOrderDateFor,
  loadCostLinesFor,
  loadMasterDataFor,
  loadOrganizationsFor,
  loadSalesCountsFor,
  loadStockFor,
  loadSyncInfoFor,
  loadTodoStateFor,
  type DomainInputArgs,
  type SalesCountsArgs,
  type TodoState,
  type Viewer,
  verifiedViewer,
} from "./loaders";
import { resolveAppPeriod } from "./period";
import { resolveOwnerScope } from "./scope";
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
export {
  resolveOwnerScope,
  scopeFiltered,
  scopeStoreIds,
  storeInScope,
  storeScoped,
} from "./scope";
export {
  coverageDays,
  dataCoverage,
  isoDateToShellDate,
  resolveAppPeriod,
  scopeFromSearchParams,
} from "./period";
export { STALE_SYNC_HOURS, type DomainInputArgs, type SalesCountsArgs } from "./loaders";
export { isKnownStock } from "./queries";

/** Tidpunkten förfrågan räknar från (samma i alla laddare under en förfrågan). */
const requestNow = cache((): Date => new Date());

/** Organisationerna (organisationsväxlaren) och antal automater i var och en, i en transaktion. */
const loadOrganizationsAndCounts = cache(async () => loadOrganizationsFor(await requireUser()));

const loadOrganizations = cache(
  async (): Promise<OrganizationMembership[]> => (await loadOrganizationsAndCounts()).organizations,
);

/**
 * Användaren och den aktiva organisationen, eller null om användaren inte är medlem
 * någonstans. Skickar till /logga-in om ingen är inloggad.
 *
 * Samma val som getActiveOrganization (cookien om användaren är medlem där, annars den
 * första), men ur organisationslistan som skalet ändå läser, så att listan inte läses
 * två gånger efter varandra. Rollen är läst ur databasen (under RLS), så laddarna läser
 * den inte en gång till (verifiedViewer).
 */
const loadViewer = cache(async (): Promise<Viewer | null> => {
  const user = await requireUser();
  const [{ organizations }, jar] = await Promise.all([
    loadOrganizationsAndCounts(),
    nextCookieJar(),
  ]);
  const preferred = jar.get(ACTIVE_ORG_COOKIE)?.toLowerCase();
  const organization = organizations.find((o) => o.id === preferred) ?? organizations[0] ?? null;
  // Enkel vy: allt utanför det tillåtna skickas till startsidan (@/server/simple-view-guard).
  await guardSimpleView(organization);
  return organization ? verifiedViewer({ user, organization }) : null;
});

/**
 * Kontexten om någon är inloggad, annars null, utan att skicka till /logga-in (för språket
 * på sidor som visas både med och utan inloggning). Användare utan organisation: null.
 */
export const loadOptionalContextIfSignedIn = cache(async (): Promise<AppContext | null> => {
  const user = await getSessionUser().catch(() => null);
  if (!user) return null;
  return loadOptionalContext().catch((error: unknown) => {
    unstable_rethrow(error);
    return null;
  });
});

/**
 * Den inloggade som Viewer för laddarna i ./loaders (rollen redan läst i förfrågan).
 * Kastar AuthorizationError om användaren saknar organisation.
 */
export async function requireViewer(): Promise<Viewer> {
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
  // Nästan varje sida läser perioden (loadPeriod), som behöver första dagen med data:
  // den läses redan nu, parallellt med kontexten, i stället för efter den.
  loadDataStart().catch(() => {});
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
  const ctx = await loadPageContext();
  // Till startsidan med ?nekad=<rutt>, som skalet förklarar (DeniedNotice).
  if (!routeById(id).roles.includes(ctx.role)) redirect(deniedHref(ctx.role, id));
  return ctx;
}

/**
 * Kontexten för en sida. En butiksanvändare (rollen store, utan approll) skickas till
 * /portal i stället för att få ett fel (t.ex. /rapport/varde, som ligger utanför appens
 * layout). Övriga utan organisation: AuthorizationError som i loadContext (inuti appen
 * visar layouten då NoOrganization).
 */
async function loadPageContext(): Promise<AppContext> {
  const ctx = await loadOptionalContext();
  if (ctx) return ctx;
  await redirectStoreUserToPortal();
  return loadContext();
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
  const p = resolveAppPeriod(searchParams, {
    timeZone: ctx.timeZone,
    dataStart,
    now: requestNow(),
  });
  // En butiksägare (?agare=): dess butiker ur stamdatan (som nästan varje sida läser ändå).
  if (!p.scope.ownerId) return p;
  return { ...p, scope: resolveOwnerScope(p.scope, (await loadMasterData()).stores) };
}

/** Titlar, automater, butiker och placeringar. Alla roller. */
export const loadMasterData = cache(async (): Promise<MasterData> =>
  loadMasterDataFor(await requireViewer(), requestNow()),
);

/**
 * Vilka kostnadsrader sidorna visar: hyra och fasta kostnader bara när organisationen har
 * någon (@/lib/cost-lines). Ägare, admin och läsare. Memoiseras per förfrågan.
 */
export const loadCostLines = cache(async (): Promise<CostLines> =>
  loadCostLinesFor(await requireViewer()),
);

/**
 * Vyknappen "Med VMB" i förfrågan: proxyn sätter headern från ?vmb=1 (src/proxy.ts), så
 * att alla laddare i förfrågan (sidan, server actions) räknar likadant. Utan förfrågan
 * (tester, cron): av.
 */
export const requestVmbView = cache(async (): Promise<boolean> => {
  try {
    return (await headers()).get(VMB_HEADER) === "1";
  } catch {
    return false;
  }
});

/**
 * Vyknappen "Visa butikernas andel" i förfrågan: proxyn sätter headern från ?andel=1 eller
 * från kakan som knappen sparar (src/proxy.ts), så att alla laddare i förfrågan räknar vår
 * vinst likadant: före butikernas andel som standard, efter den med knappen. Utan förfrågan
 * (tester, cron): av.
 */
export const requestStoreShareView = cache(async (): Promise<boolean> => {
  try {
    return (await headers()).get(STORE_SHARE_HEADER) === "1";
  } catch {
    return false;
  }
});

const loadDomainInputCached = cache(
  async (
    start: IsoDate,
    end: IsoDate,
    compareStart: IsoDate | null,
    compareEnd: IsoDate | null,
    storeId: string | null,
    machineId: string | null,
    vmb: boolean,
    storeShare: boolean,
    ownerId: string | null,
    /** Ägarens butiker som "id,id" (cache-nyckel), "" = inga, null = läses av laddaren. */
    storeIdsKey: string | null,
  ): Promise<DomainInput> => {
    const compare: Period | null =
      compareStart && compareEnd ? { start: compareStart, end: compareEnd } : null;
    return loadDomainInputFor(
      await requireViewer(),
      {
        period: { start, end },
        compare,
        storeId,
        machineId,
        vmb,
        storeShare,
        ...ownerArgs(ownerId, storeIdsKey),
      },
      requestNow(),
    );
  },
);

/** Ägarfiltret ur cache-nyckeln: "a,b" → ["a", "b"], "" → [], null → läses av laddaren. */
function ownerArgs(
  ownerId: string | null,
  storeIdsKey: string | null,
): { ownerId: string | null; storeIds?: readonly string[] } {
  if (!ownerId) return { ownerId: null };
  if (storeIdsKey === null) return { ownerId };
  return { ownerId, storeIds: storeIdsKey === "" ? [] : storeIdsKey.split(",") };
}

/** Ägaren och dess butiker som cache-nycklar (null när en butik är vald eller ingen ägare). */
function ownerKeys(args: {
  storeId?: string | null;
  ownerId?: string | null;
  storeIds?: readonly string[] | null;
}): [string | null, string | null] {
  if (args.storeId || !args.ownerId) return [null, null];
  return [args.ownerId, args.storeIds ? [...args.storeIds].sort().join(",") : null];
}

/**
 * Indata till beräkningslagret för perioden (och jämförelsen): order, priser, avtal,
 * placeringar, inställningar, investeringar, titlar, automater och butiker. Bara
 * ägare, admin och läsare; kastar AuthorizationError("forbidden") för påfyllare.
 * Memoiseras per förfrågan på periodens och filtrets värden. Vinsten följer vyknapparna
 * "Med VMB" (requestVmbView) och "Visa butikernas andel" (requestStoreShareView) i
 * förfrågan, om inte `args.vmb`/`args.storeShare` anges.
 */
export async function loadDomainInput(args: DomainInputArgs): Promise<DomainInput> {
  return loadDomainInputCached(
    args.period.start,
    args.period.end,
    args.compare?.start ?? null,
    args.compare?.end ?? null,
    args.storeId ?? null,
    args.machineId ?? null,
    args.vmb ?? (await requestVmbView()),
    args.storeShare ?? (await requestStoreShareView()),
    ...ownerKeys(args),
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
    ownerId: string | null,
    storeIdsKey: string | null,
  ): Promise<SalesCounts> =>
    loadSalesCountsFor(await requireViewer(), {
      period: { start, end },
      storeId,
      machineId,
      ...ownerArgs(ownerId, storeIdsKey),
    }),
);

/** Sålda pack per dag, titel och automat (ur lagret). Alla roller, inga belopp. */
export function loadSalesCounts(args: SalesCountsArgs): Promise<SalesCounts> {
  return loadSalesCountsCached(
    args.period.start,
    args.period.end,
    args.storeId ?? null,
    args.machineId ?? null,
    ...ownerKeys(args),
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
export const loadTodoState = cache(async (): Promise<TodoState> => {
  const viewer = await requireViewer();
  const now = requestNow();
  return loadTodoStateFor(viewer, now, {
    unpaidSettlements: () => unpaidSettlementsInRequest(viewer, now),
  });
});

/**
 * Obetalda avräkningar för Att göra: en gång per förfrågan (React cache) och sparade
 * UNPAID_SETTLEMENTS_SECONDS mellan förfrågningar (src/server/settlements/cache.ts), så att
 * menyns räknare, Hem och Att göra inte räknar om alla avräkningar vid varje sidladdning.
 * Rensas av revalidateSettlementData (och revalidateAppData).
 */
const unpaidSettlementsInRequest = cache((viewer: Viewer, now: Date): Promise<SettlementRef[]> => {
  const orgId = viewer.organization.id;
  return cachedUnpaidSettlements(
    { organizationId: orgId, userId: viewer.user.userId, role: viewer.organization.role },
    () => withUserDbFor(viewer.user, (tx) => queryUnpaidSettlements(tx, orgId, now)),
    [appDataTag(orgId)],
  );
});

/** Antal automater per organisation (organisationsväxlarens detaljrad). */
export const loadMachineCounts = cache(
  async (): Promise<Map<string, number>> => (await loadOrganizationsAndCounts()).machineCounts,
);

const loadLastOrderDateCached = cache(
  async (
    start: IsoDate,
    end: IsoDate,
    storeId: string | null,
    machineId: string | null,
    ownerId: string | null,
    storeIdsKey: string | null,
  ): Promise<IsoDate | null> =>
    loadLastOrderDateFor(await requireViewer(), {
      period: { start, end },
      storeId,
      machineId,
      ...ownerArgs(ownerId, storeIdsKey),
    }),
);

/**
 * Senaste affärsdagen med en order i perioden och filtret, eller null (en fråga, för
 * tomma lägen: "senast såld …"). Bara ägare, admin och läsare.
 */
export function loadLastOrderDate(args: {
  period: Period;
  storeId?: string | null;
  machineId?: string | null;
  ownerId?: string | null;
  storeIds?: readonly string[] | null;
}): Promise<IsoDate | null> {
  return loadLastOrderDateCached(
    args.period.start,
    args.period.end,
    args.storeId ?? null,
    args.machineId ?? null,
    ...ownerKeys(args),
  );
}

/** Taggen för allt som cachas mellan förfrågningar för organisationen (unstable_cache). */
export function appDataTag(organizationId: string): string {
  return `app-data:${organizationId}`;
}

/**
 * Kör fn högst en gång per `seconds` för användaren i organisationen (mellan förfrågningar,
 * Next:s datacache). Bara för sådant där några sekunders fördröjning är ofarlig, som
 * menyns räknare. Nyckeln är användaren, organisationen och rollen, så inget delas
 * mellan användare. Rensas av revalidateAppData och av revalidateTag(appDataTag(org)).
 */
export async function cachedForViewer<T>(
  name: string,
  seconds: number,
  fn: (viewer: Viewer) => Promise<T>,
): Promise<T> {
  const viewer = await requireViewer();
  const { userId } = viewer.user;
  const { id: orgId, role } = viewer.organization;
  return unstable_cache(() => fn(viewer), [name, userId, orgId, role], {
    revalidate: seconds,
    tags: [appDataTag(orgId)],
  })();
}

/**
 * Hur länge (sekunder) ett sparat läge (cachedViewState) används innan det läses om i
 * bakgrunden, och längsta ålder (nytt tidsfack i nyckeln var VIEW_STATE_BUCKET_SECONDS).
 * Awish-synken (var 5:e minut) och ändringarna i appen rensar det ändå direkt (appDataTag),
 * så det som kan bli äldre än en minut är bara det som enbart beror på klockan.
 */
export const VIEW_STATE_REVALIDATE_SECONDS = 60;
export const VIEW_STATE_BUCKET_SECONDS = 300;

const notCacheableWarned = new Set<string>();

/**
 * Förfrågans markering att ett fel har fångats och ersatts med ett reservvärde (null, [],
 * standardgränsen …), en gång per förfrågan (React cache). Ett sparat läge (cachedViewState)
 * som blir klart efter det sparas inte: annars skulle ett tillfälligt fel (en timeout) visas
 * i minuter i stället för på en sida.
 */
const requestDegraded = cache((): { degraded: boolean } => ({ degraded: false }));

/**
 * Anropas där ett fel fångas och ersätts med ett reservvärde i det som cachedViewState
 * sparar, så att reservvärdet inte sparas mellan förfrågningar (bara den här sidan får det).
 */
export function markViewStateDegraded(): void {
  try {
    requestDegraded().degraded = true;
  } catch {
    // Utanför en förfrågan: inget sparas ändå.
  }
}

/** Kastas ur unstable_cache när läsningen bar ett reservvärde: då sparas inget. */
class DegradedRead extends Error {
  constructor() {
    super("Läsningen bar ett reservvärde och sparas inte.");
    this.name = "DegradedRead";
  }
}

/**
 * Ett läge som inte beror på vald period (flottan, dagens rutt, Att göra, Vårt lager …),
 * sparat mellan förfrågningar för den inloggade, så att ett periodbyte på Hem inte läser
 * om det.
 *
 * Nyckeln är användaren, organisationen, rollen, dagens datum, språket, vyknapparna (VMB,
 * butikernas andel) och ett tidsfack på VIEW_STATE_BUCKET_SECONDS: inget delas mellan
 * användare eller roller och inget lever kvar över ett dygnsskifte. Taggen är appDataTag:
 * varje ändring i appen (revalidateAppData) och varje Awish-synk (cron) rensar den, så att
 * nästa sida räknar om. Värdet kodas (Map, Set, Date …, @/lib/cache-codec) så att en träff
 * ger samma värde som en ny läsning. Utanför Next (tester, skript): fn direkt.
 *
 * fn läser som vanligt via de memoiserade laddarna. Vem som tittar och vyknapparna läses här
 * först, så att inget i fn behöver kakor eller headers (som unstable_cache inte tillåter).
 */
export async function cachedViewState<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const [viewer, ctx, vmb, storeShare] = await Promise.all([
    requireViewer(),
    loadContext(),
    requestVmbView(),
    requestStoreShareView(),
  ]);
  const { userId } = viewer.user;
  const { id: orgId, role } = viewer.organization;
  const bucket = Math.floor(requestNow().getTime() / (VIEW_STATE_BUCKET_SECONDS * 1000));
  // Läst i den här förfrågan men inte sparbart (t.ex. en klassinstans): ges tillbaka som det är.
  let fresh: { value: T } | null = null;
  let ran = false;
  type Entry = { ok: true; v: ReturnType<typeof encodeForCache> } | { ok: false };
  let entry: Entry;
  try {
    const load = unstable_cache(
      async () => {
        ran = true;
        const value = await fn();
        if (requestDegraded().degraded) {
          fresh = { value };
          throw new DegradedRead();
        }
        try {
          return { ok: true as const, v: encodeForCache(value) };
        } catch (error) {
          if (!(error instanceof NotCacheableError)) throw error;
          if (!notCacheableWarned.has(name)) {
            notCacheableWarned.add(name);
            console.warn(`[cache] ${name} sparas inte mellan förfrågningar: ${error.message}`);
          }
          fresh = { value };
          return { ok: false as const };
        }
      },
      [
        "view-state:v1",
        // Bygget: datacachen lever kvar över en driftsättning, och ett läge som ett äldre
        // bygge sparade kan ha en annan form eller räkning än den här koden.
        BUILD_ID,
        name,
        userId,
        orgId,
        role,
        ctx.today,
        ctx.locale,
        vmb ? "vmb" : "-",
        storeShare ? "andel" : "-",
        String(bucket),
      ],
      { revalidate: VIEW_STATE_REVALIDATE_SECONDS, tags: [appDataTag(orgId)] },
    );
    entry = await load();
  } catch (error) {
    // Läsningen bar ett reservvärde: den här sidan får det, men det sparas inte.
    const degraded = fresh as { value: T } | null;
    if (error instanceof DegradedRead && degraded) return degraded.value;
    // Ingen datacache (utanför en Next-förfrågan, eller i tester utan den): läs som vanligt.
    // Bara när fn inte hann köras, så att ett fel i själva läsningen inte läses en gång till.
    if (!ran) return fn();
    throw error;
  }
  const kept = fresh as { value: T } | null;
  if (kept) return kept.value;
  if (!entry.ok) return fn();
  return decodeFromCache(entry.v) as T;
}

/**
 * Rensar organisationens sparade tal (appDataTag) utan inloggad kontext: efter Awish-synken
 * och personalens påfyllning, som inte har någon app-kontext.
 */
export function expireAppData(organizationId: string): void {
  expireTag(appDataTag(organizationId));
}

/**
 * Efter en ändring som påverkar siffror (priser, inställningar, lager, avtal …): bara den
 * egna organisationens sparade tal rensas (taggen appDataTag: menyns räknare för Att göra,
 * de obetalda avräkningarna), inte hela appens alla sidor för alla organisationer. Sidorna
 * läser annars alltid nytt (de är dynamiska), och sidan man står på räknas om i samma svar
 * som åtgärden: klienten behöver ingen egen router.refresh() efteråt. Anropa sist i server
 * actions, efter att ändringen sparats.
 */
export async function revalidateAppData(): Promise<void> {
  const ctx = await loadOptionalContext().catch(() => null);
  if (!ctx) {
    // Ingen organisation (t.ex. utloggad): som förut, allt under layouten.
    revalidatePath("/", "layout");
    return;
  }
  expireTag(appDataTag(ctx.organization.id));
}

/**
 * Taggen rensas så att nästa läsning väntar på nya tal: i en server action med updateTag
 * (svaret har då sidan med de nya talen), annars (Route Handler, jobb) med revalidateTag
 * utan gammalt innehåll. Utanför Next (tester, skript) finns inget sparat att rensa.
 */
function expireTag(tag: string): void {
  try {
    updateTag(tag);
    return;
  } catch {
    // Inte i en server action.
  }
  try {
    revalidateTag(tag, { expire: 0 });
  } catch {
    // Inte i Next.
  }
}

/**
 * Som revalidateAppData, och rensar dessutom organisationens sparade obetalda avräkningar
 * (menyns räknare, Hem, Att göra) direkt. För åtgärder som ändrar order, testköp,
 * inköpspriser, avtal, butiker eller avräkningar. Anropa sist, efter att ändringen sparats.
 */
export async function revalidateSettlementData(): Promise<void> {
  await revalidateAppData();
  const ctx = await loadOptionalContext().catch(() => null);
  if (ctx) invalidateUnpaidSettlements(ctx.organization.id);
}
