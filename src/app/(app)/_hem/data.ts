/**
 * Hems data: hämtar indata via de gemensamma laddarna och bygger modellen.
 *
 * Laddarna skickas in (HomeLoaders), så att sidan kan använda de memoiserade
 * (@/server/data/core) och testerna "For"-varianterna mot testdatabasen. All
 * dataåtkomst går via laddarna, som läser med RLS (withUserDb) och kontrollerar rollen
 * mot databasen. Här kontrolleras rollen en gång till: bara roller som ser ekonomi får
 * Hem, och påfyllaren får aldrig något belopp.
 */

import type { GoalProgress } from "@/analytics/goals";
import type { TodoItem } from "@/analytics/todos";
import { routeById } from "@/components/shell/nav";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { addDays, monthOf, type IsoDate, type Period } from "@/domain";
import { AuthorizationError } from "@/server/access";
import type {
  AppContext,
  AppPeriod,
  DataScope,
  DomainInput,
  DomainInputArgs,
  SyncInfo,
} from "@/server/data/core";
import type { OnboardingStatus } from "@/server/onboarding/model";
import type { LostSalesSummary } from "@/server/purchasing/types";

import { homeGoals, type HomeGoal } from "./goals";
import { PACE_WEEKS, periodIncludesToday, todayPace, type TodayPace } from "./pace";
import {
  buildHomeModel,
  emptyRefillsInScope,
  homeLostSales,
  homeStaleImport,
  type HomeLostSales,
  type HomeModel,
  type HomeStaleImport,
} from "./model";

export interface HomeLoaders {
  context(): Promise<AppContext>;
  period(sp: SearchParamsInput): Promise<AppPeriod>;
  domainInput(args: DomainInputArgs): Promise<DomainInput>;
  todos(): Promise<TodoItem[]>;
  /**
   * Förlorad försäljning för perioden och filtret (lostSalesSummary i Prognos & inköp).
   * null för roller utan ekonomi. Utelämnad = visas inte.
   */
  lostSales?(period: Period, scope: DataScope): Promise<LostSalesSummary | null>;
  /** Kom igång-checklistan för organisationen, eller null. Utelämnad = visas inte. */
  onboarding?(orgId: string): Promise<OnboardingStatus | null>;
  /** Senaste synk (för varningen om inaktuell import). Utelämnad = ingen varning. */
  sync?(): Promise<SyncInfo | null>;
  /** Utfall och prognos för målen i dagens månad (alla omfattningar). Utelämnad = visas inte. */
  goals?(today: IsoDate): Promise<GoalProgress[]>;
}

/** Filtret som det visas: automatens kod och namn, eller butikens namn. */
export interface HomeScopeLabel {
  readonly kind: "machine" | "store";
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  /** Automaten eller butiken finns inte (eller syns inte för den inloggade). */
  readonly missing: boolean;
}

export interface HomeData {
  readonly model: HomeModel;
  readonly periodKey: AppPeriod["key"];
  readonly today: IsoDate;
  readonly scope: HomeScopeLabel | null;
  /** Rollen får ändra (ägare, admin): styr länkar till åtgärder. */
  readonly canEdit: boolean;
  /** Förlorad försäljning i perioden, eller null (ingen, eller rollen ser den inte). */
  readonly lostSales: HomeLostSales | null;
  /** Kom igång, tills alla nödvändiga steg är klara (annars null). */
  readonly onboarding: OnboardingStatus | null;
  /** Senaste importen när den är gammal och perioden går förbi den, annars null. */
  readonly staleImport: HomeStaleImport | null;
  /** Mål i dagens månad (högst tre, efter filtret); null när laddaren saknas. */
  readonly goals: HomeGoal[] | null;
  /** I dag hittills mot samma klockslag en vanlig veckodag; null när perioden inte har i dag. */
  readonly pace: TodayPace | null;
  readonly timeZone: string;
}

/**
 * Allt Hem visar för den inloggade. Kastar AuthorizationError("forbidden") för roller
 * som inte ser ekonomi (sidan skickar dem vidare innan dess med requireRoute).
 */
export async function loadHomeWith(
  loaders: HomeLoaders,
  searchParams: SearchParamsInput,
): Promise<HomeData> {
  const ctx = await loaders.context();
  if (!ctx.canSeeEconomy) throw new AuthorizationError("forbidden");

  const p = await loaders.period(searchParams);
  const hasTodos = routeById("att-gora").roles.includes(ctx.role);

  // Order efter perioden (t.o.m. i dag) behövs för att "har inte sålt sedan" ska bli rätt.
  const later =
    p.period.end < ctx.today ? { start: addDays(p.period.end, 1), end: ctx.today } : null;

  // Dagens takt: samma veckodag de senaste veckorna och i dag, med samma filter.
  const withPace = periodIncludesToday(p.period, ctx.today);

  const [input, laterInput, paceInput, todos, lost, onboarding, sync, goals] = await Promise.all([
    loaders.domainInput({ period: p.period, compare: p.compare, ...p.scope }),
    later ? loaders.domainInput({ period: later, compare: null, ...p.scope }) : null,
    withPace
      ? loaders.domainInput({
          period: { start: addDays(ctx.today, -7 * PACE_WEEKS), end: ctx.today },
          compare: null,
          ...p.scope,
        })
      : null,
    hasTodos ? loaders.todos() : Promise.resolve(null),
    loaders.lostSales ? loaders.lostSales(p.period, p.scope) : Promise.resolve(null),
    loaders.onboarding ? loaders.onboarding(ctx.organization.id) : Promise.resolve(null),
    loaders.sync ? loaders.sync() : Promise.resolve(null),
    loaders.goals ? loaders.goals(ctx.today) : Promise.resolve(null),
  ]);

  const model = buildHomeModel({
    current: input.current,
    previous: input.previous,
    sources: input.sources,
    titles: input.titles,
    machines: input.machines,
    laterOrders: laterInput?.current.orders ?? [],
    period: p.period,
    compare: p.compare,
    dataStart: p.dataStart,
    today: ctx.today,
    now: ctx.now,
    timeZone: ctx.timeZone,
    scope: p.scope,
    todos,
    costLines: input.costLines,
  });

  let scope: HomeScopeLabel | null = null;
  if (p.scope.machineId) {
    const m = input.machines.find((x) => x.id === p.scope.machineId);
    scope = {
      kind: "machine",
      id: p.scope.machineId,
      name: m?.name ?? "Okänd automat",
      code: m?.code ?? null,
      missing: !m,
    };
  } else if (p.scope.storeId) {
    const s = input.stores.find((x) => x.id === p.scope.storeId);
    scope = {
      kind: "store",
      id: p.scope.storeId,
      name: s?.name ?? "Okänd butik",
      code: null,
      missing: !s,
    };
  }

  return {
    model,
    periodKey: p.key,
    today: ctx.today,
    scope,
    canEdit: ctx.canEdit,
    lostSales: homeLostSales(
      lost,
      ctx.today,
      todos ? emptyRefillsInScope(todos, p.scope, input.machines) : null,
    ),
    onboarding: onboarding && !onboarding.complete ? onboarding : null,
    staleImport: homeStaleImport(sync, p.period.end, ctx.now, ctx.timeZone),
    goals: goals
      ? homeGoals(
          goals,
          {
            month: monthOf(ctx.today),
            storeId: p.scope.storeId,
            machineId: p.scope.machineId,
            machineStoreId: p.scope.machineId
              ? (input.machines.find((m) => m.id === p.scope.machineId)?.storeId ?? null)
              : null,
          },
          { stores: input.stores, machines: input.machines },
        )
      : null,
    pace: paceInput ? paceOf(paceInput, sync, ctx, p.dataStart) : null,
    timeZone: ctx.timeZone,
  };
}

/**
 * Klockslaget är det tidigaste av nu och senaste lyckade synk (senare order finns inte än).
 * Utan någon synk alls (bara manuell import) visas inget: dagens order kommer inte löpande.
 */
function paceOf(
  input: DomainInput,
  sync: SyncInfo | null,
  ctx: AppContext,
  dataStart: IsoDate | null,
): TodayPace | null {
  if (sync && !sync.syncedAt) return null;
  const now = Date.parse(ctx.now);
  const synced = sync?.syncedAt ? Date.parse(sync.syncedAt) : Number.NaN;
  return todayPace({
    orders: input.current.orders,
    today: ctx.today,
    cutoffMs: Number.isFinite(synced) ? Math.min(now, synced) : now,
    timeZone: ctx.timeZone,
    vatRateBp: input.current.settings.vatRateBp,
    dataStart,
    weeks: PACE_WEEKS,
  });
}
