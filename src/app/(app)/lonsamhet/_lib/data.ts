/**
 * Lönsamhets indata och modell med givna laddare: sidan med förfrågans
 * (requestPageLoaders), Daglig kontroll med en given användare och vyknappens läge
 * (src/server/self-check). Samma kod för båda, så att kontrollen räknar exakt som sidan.
 */

import "server-only";

import type { SearchParamsInput } from "@/components/shell/period-state";
import type { IsoDate } from "@/domain";
import type { AppContext, AppPeriod, DomainInput } from "@/server/data/core/types";
import type { PageLoaders } from "@/server/data/page-loaders";

import { buildLonsamhetModel, type LonsamhetModel } from "./model";

export interface LonsamhetData {
  readonly ctx: AppContext;
  readonly p: AppPeriod;
  /** Indata med periodens filter. */
  readonly input: DomainInput;
  /** Hela organisationens indata (samma som `input` utan filter). */
  readonly organization: DomainInput;
  readonly model: LonsamhetModel;
}

export async function loadLonsamhetWith(
  loaders: Pick<PageLoaders, "context" | "period" | "domainInput">,
  searchParams: SearchParamsInput,
  options: {
    /** Sidans query-sträng för länkar (utan "?"). */
    readonly carry?: string;
    /** Senaste orderdagen i urvalet (tomt läge). Standard: ingen. */
    readonly lastOrderDate?: (args: {
      period: { start: IsoDate; end: IsoDate };
      storeId: string | null;
      machineId: string | null;
    }) => Promise<IsoDate | null>;
  } = {},
): Promise<LonsamhetData> {
  const [ctx, p] = await Promise.all([loaders.context(), loaders.period(searchParams)]);
  // Fördelningen av de fasta kostnaderna räknas på hela organisationen även med filter
  // (annars fick automaten alla), så med filter läses också organisationens indata.
  const filtered = Boolean(p.scope.machineId || p.scope.storeId);
  const [input, organizationInput] = await Promise.all([
    loaders.domainInput({ period: p.period, compare: p.compare, ...p.scope }),
    filtered ? loaders.domainInput({ period: p.period }) : null,
  ]);
  const organization = organizationInput ?? input;

  // Tomt läge: senaste ordern i urvalet (samma filter), för att säga när det såldes senast.
  const lastOrderDate =
    options.lastOrderDate &&
    input.current.orders.length === 0 &&
    p.dataStart &&
    p.dataStart <= ctx.today
      ? await options.lastOrderDate({ period: { start: p.dataStart, end: ctx.today }, ...p.scope })
      : null;

  const model = buildLonsamhetModel(
    {
      current: input.current,
      previous: input.previous,
      titles: input.titles,
      machines: input.machines,
      stores: input.stores,
      scope: input.scope,
    },
    {
      today: ctx.today,
      carry: options.carry ?? "",
      lastOrderDate,
      dataStart: p.dataStart,
      hasOrdersToday: organization.current.orders.some((o) => o.businessDate === ctx.today),
    },
  );
  return { ctx, p, input, organization, model };
}
