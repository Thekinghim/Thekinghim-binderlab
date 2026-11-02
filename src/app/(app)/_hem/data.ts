/**
 * Hems data: hämtar indata via de gemensamma laddarna och bygger modellen.
 *
 * Laddarna skickas in (HomeLoaders), så att sidan kan använda de memoiserade
 * (@/server/data/core) och testerna "For"-varianterna mot testdatabasen. All
 * dataåtkomst går via laddarna, som läser med RLS (withUserDb) och kontrollerar rollen
 * mot databasen. Här kontrolleras rollen en gång till: bara roller som ser ekonomi får
 * Hem, och påfyllaren får aldrig något belopp.
 */

import type { TodoItem } from "@/analytics/todos";
import { routeById } from "@/components/shell/nav";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { addDays, type IsoDate, type Period } from "@/domain";
import { AuthorizationError } from "@/server/access";
import type {
  AppContext,
  AppPeriod,
  DataScope,
  DomainInput,
  DomainInputArgs,
} from "@/server/data/core";
import type { OnboardingStatus } from "@/server/onboarding/model";
import type { LostSalesSummary } from "@/server/purchasing/types";

import {
  buildHomeModel,
  emptyRefillsInScope,
  homeLostSales,
  type HomeLostSales,
  type HomeModel,
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

  const [input, laterInput, todos, lost, onboarding] = await Promise.all([
    loaders.domainInput({ period: p.period, compare: p.compare, ...p.scope }),
    later ? loaders.domainInput({ period: later, compare: null, ...p.scope }) : null,
    hasTodos ? loaders.todos() : Promise.resolve(null),
    loaders.lostSales ? loaders.lostSales(p.period, p.scope) : Promise.resolve(null),
    loaders.onboarding ? loaders.onboarding(ctx.organization.id) : Promise.resolve(null),
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
    timeZone: ctx.timeZone,
  };
}
