/**
 * Laddaren för Mystery packs (Vårt lager → Mystery packs). Alla roller i appen läser
 * innehållet och saldot (påfyllaren packar); belopp (snittkostnad, inköpspris, pris och kvar
 * per pack) och senaste packningarna bara ägare, admin och läsare. Rollen kontrolleras mot
 * databasen och allt läses som användaren med RLS.
 */

import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import {
  addDays,
  currentSalePriceDetails,
  mysteryBatchesToPack,
  mysteryCostDrifts,
  PRICE_ADVICE_WINDOW_DAYS,
  PriceIndex,
  type IsoDate,
  type MysteryPackPlan,
} from "@/domain";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import {
  businessToday,
  loadMasterDataFor,
  loadStockFor,
  type Viewer,
} from "@/server/data/core/loaders";
import {
  DEFAULT_SETTINGS,
  queryMysteryRecipeRefs,
  queryPrices,
  querySettings,
} from "@/server/data/core/queries";
import { ALL_ROLES, ECONOMY_ROLES } from "@/server/data/core/types";

import { queryOwnPlaces } from "../../../lager/_lib/data";
import { slotInputs, UNDO_MINUTES, type CalcFees, type Place, type Recipe } from "./model";
import { queryMysterySlotFacts } from "./slots";

/** Packar: ägare, admin och påfyllare (pack_mystery). */
export const PACK_ROLES = ["owner", "admin", "refiller"] as const satisfies readonly MemberRole[];
/** Ändrar innehållet och inköpspriset: ägare och admin. */
export const RECIPE_ROLES = ["owner", "admin"] as const satisfies readonly MemberRole[];

export interface MysteryTitle {
  readonly id: string;
  readonly name: string;
  readonly recipe: Recipe | null;
  /** Mystery packs i varje eget lager (lagrets id → pack). */
  readonly inPlaces: Readonly<Record<string, number>>;
  /** Mystery packs i automaterna (kända saldon). */
  readonly inMachines: number;
  /**
   * Omgångar att packa, räknat från facken i automaterna ("Packa 1 omgång före fredag").
   * null utan innehåll. Bara antal och dagar: alla roller ser det.
   */
  readonly toPack: MysteryPackPlan | null;
  /** Titelns inköpspris i dag (öre), bara för roller som ser belopp. */
  readonly currentCostOre: number | null;
}

export interface MysteryOverview {
  readonly role: MemberRole;
  readonly today: IsoDate;
  readonly canPack: boolean;
  readonly canEdit: boolean;
  readonly seesMoney: boolean;
  readonly places: readonly Place[];
  /** Saldot per lager: lagrets id → titelns id → pack. */
  readonly byPlace: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly titles: readonly MysteryTitle[];
  /** Dagens inköpspris per titel (öre), tom för påfyllaren. */
  readonly prices: ReadonlyMap<string, number>;
}

/** Gällande innehåll (senaste versionen) per titel, med radernas namn. */
async function queryRecipes(tx: Tx, orgId: string, titleIds: readonly string[]) {
  if (titleIds.length === 0) return new Map<string, Recipe>();
  const heads = await tx
    .selectDistinctOn([s.mysteryRecipes.titleId])
    .from(s.mysteryRecipes)
    .where(
      and(
        eq(s.mysteryRecipes.organizationId, orgId),
        inArray(s.mysteryRecipes.titleId, [...titleIds]),
      ),
    )
    .orderBy(s.mysteryRecipes.titleId, desc(s.mysteryRecipes.version));
  return withItems(tx, orgId, heads);
}

async function withItems(
  tx: Tx,
  orgId: string,
  heads: ReadonlyArray<typeof s.mysteryRecipes.$inferSelect>,
): Promise<Map<string, Recipe>> {
  const out = new Map<string, Recipe>();
  if (heads.length === 0) return out;
  const items = await tx
    .select({
      recipeId: s.mysteryRecipeItems.recipeId,
      titleId: s.mysteryRecipeItems.componentTitleId,
      name: s.titles.name,
      quantity: s.mysteryRecipeItems.quantity,
      hit: s.mysteryRecipeItems.isHit,
    })
    .from(s.mysteryRecipeItems)
    .innerJoin(
      s.titles,
      and(
        eq(s.titles.organizationId, s.mysteryRecipeItems.organizationId),
        eq(s.titles.id, s.mysteryRecipeItems.componentTitleId),
      ),
    )
    .where(
      and(
        eq(s.mysteryRecipeItems.organizationId, orgId),
        inArray(
          s.mysteryRecipeItems.recipeId,
          heads.map((h) => h.id),
        ),
      ),
    )
    .orderBy(asc(s.mysteryRecipeItems.position));
  for (const h of heads) {
    out.set(h.id, {
      id: h.id,
      titleId: h.titleId,
      version: h.version,
      validFrom: h.validFrom,
      batchSize: h.batchSize,
      note: h.note,
      items: items
        .filter((i) => i.recipeId === h.id)
        .map((i) => ({ titleId: i.titleId, name: i.name, quantity: i.quantity, hit: i.hit })),
    });
  }
  // Nyckeln är titelns id för gällande innehåll.
  return new Map([...out.values()].map((r) => [r.titleId, r]));
}

/** Dagens inköpspris per titel (öre). */
function pricesOn(
  prices: ReadonlyArray<{ titleId: string; unitCostOre: number; validFrom: string }>,
  today: IsoDate,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of prices) {
    // Sorterade på titel och datum: den sista som gäller i dag vinner.
    if (p.validFrom <= today) out.set(p.titleId, p.unitCostOre);
  }
  return out;
}

/** Översikten: varje egen produkt med innehåll, saldo och (för rätt roller) belopp. */
export async function loadMysteryOverviewFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<MysteryOverview> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ALL_ROLES);
  const seesMoney = (ECONOMY_ROLES as readonly string[]).includes(role);
  const today = businessToday(now, viewer.organization.timezone);

  const [master, stock] = await Promise.all([loadMasterDataFor(viewer, now), loadStockFor(viewer)]);
  const db = await withUserDbFor(viewer.user, async (tx) => {
    const places = await queryOwnPlaces(tx, orgId);
    const prices = seesMoney ? await queryPrices(tx, orgId) : [];
    const own = await tx
      .select({ id: s.titles.id })
      .from(s.titles)
      .where(
        and(
          eq(s.titles.organizationId, orgId),
          eq(s.titles.ownProduct, true),
          isNull(s.titles.archivedAt),
          isNull(s.titles.mergedIntoId),
        ),
      );
    const recipes = await queryRecipes(
      tx,
      orgId,
      own.map((t) => t.id),
    );
    // Facken i automaterna för mystery packs med innehåll (saldo, takt, ny automat).
    const slots = await queryMysterySlotFacts(tx, orgId, today, [...recipes.keys()], {
      machines: master.machines,
      stock: stock.rows,
    });
    return { places, prices, recipes, slots };
  });

  const byPlace: Record<string, Record<string, number>> = Object.fromEntries(
    db.places.map((p) => [p.id, {}]),
  );
  const inMachines = new Map<string, number>();
  for (const r of stock.rows) {
    const place = byPlace[r.locationId];
    if (r.locationKind === "warehouse" && place) place[r.titleId] = r.onHand;
    if (r.locationKind === "machine" && (r.lastCountedAt || r.lastRestockedAt)) {
      inMachines.set(r.titleId, (inMachines.get(r.titleId) ?? 0) + Math.max(0, r.onHand));
    }
  }
  const prices = pricesOn(db.prices, today);
  const titles: MysteryTitle[] = master.titles
    .filter((t) => t.ownProduct === true && !t.archived && t.mergedIntoId === null)
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .map((t) => {
      const recipe = db.recipes.get(t.id) ?? null;
      const inPlaces = Object.fromEntries(db.places.map((p) => [p.id, byPlace[p.id]?.[t.id] ?? 0]));
      return {
        id: t.id,
        name: t.name,
        recipe,
        inPlaces,
        inMachines: inMachines.get(t.id) ?? 0,
        // Färdiga hemma: hela omgångar per lager (ett minus i ett lager räknas som 0 där).
        toPack: recipe
          ? mysteryBatchesToPack({
              batchSize: recipe.batchSize,
              planPacks: 0,
              packedAtHome: Object.values(inPlaces).reduce((n, q) => n + Math.max(0, q), 0),
              slots: slotInputs(db.slots.get(t.id) ?? [], today),
              today,
            })
          : null,
        currentCostOre: seesMoney ? (prices.get(t.id) ?? null) : null,
      };
    });

  return {
    role,
    today,
    canPack: (PACK_ROLES as readonly string[]).includes(role) && db.places.length > 0,
    canEdit: (RECIPE_ROLES as readonly string[]).includes(role),
    seesMoney,
    places: db.places,
    byPlace,
    titles,
    prices,
  };
}

/** En tidigare version av innehållet (för historiken). */
export interface RecipeVersion {
  readonly id: string;
  readonly version: number;
  readonly validFrom: IsoDate;
  readonly batchSize: number;
  readonly rows: number;
}

/** En packning (senaste först). */
export interface PackingRow {
  readonly id: string;
  readonly packedAt: string;
  readonly batches: number;
  readonly packs: number;
  readonly placeName: string;
  readonly version: number;
  readonly costPerPackOre: number | null;
  readonly undone: boolean;
  /** Går att ångra nu (inom 30 minuter, inte ångrad). */
  readonly undoable: boolean;
}

export interface MysteryDetail {
  readonly overview: MysteryOverview;
  readonly title: MysteryTitle;
  readonly versions: readonly RecipeVersion[];
  readonly packings: readonly PackingRow[];
  /** Titlar som kan vara delar (aktiva, inte egna produkter), med namn. */
  readonly choices: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Priset i automaten (öre, med moms), eller null. Samma regel som Prisråd: det lägsta av
   * automaternas senaste pris de senaste 30 dagarna; utan köp i fönstret det senaste köpet.
   */
  readonly salePriceOre: number | null;
  /** Automaterna har olika pris: koden för automaten med det låga priset ("BL-002"). */
  readonly salePriceMachine: string | null;
  /** Avgifterna i kalkylen (moms och kortavgift, organisationens inställningar). */
  readonly fees: CalcFees;
}

/**
 * Priset i automaten för titeln, med samma regel som Prisråd (@/domain price-advice): det
 * lägsta av automaternas senaste betalda pris de senaste 30 dagarna (inte testköp), så att
 * kalkylen och Prisråd aldrig visar olika pris. Utan köp i fönstret: det senaste köpet.
 */
async function querySalePrice(
  tx: Tx,
  orgId: string,
  titleId: string,
  today: IsoDate,
): Promise<{ ore: number; machineId: string | null; differs: boolean } | null> {
  const since = addDays(today, -(PRICE_ADVICE_WINDOW_DAYS - 1));
  const recent = (await tx.execute(sql`
    select o.machine_id, o.business_date::text as business_date, o.amount_ore,
           to_char(o.ordered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ordered_at
    from public.orders o
    where o.organization_id = ${orgId}::uuid and o.title_id = ${titleId}::uuid
      and o.test_purchase_at is null and o.amount_ore > 0
      and o.business_date >= ${since}::date and o.business_date <= ${today}::date
  `)) as unknown as Iterable<{
    machine_id: string | null;
    business_date: string;
    amount_ore: string | number;
    ordered_at: string;
  }>;
  const current = currentSalePriceDetails(
    [...recent].map((r) => ({
      titleId,
      machineId: r.machine_id,
      businessDate: r.business_date,
      amountOre: Number(r.amount_ore),
      orderedAt: r.ordered_at,
    })),
    since,
  ).get(titleId);
  if (current) return { ore: current.ore, machineId: current.machineId, differs: current.differs };
  const [row] = await tx
    .select({ amountOre: s.orders.amountOre })
    .from(s.orders)
    .where(
      and(
        eq(s.orders.organizationId, orgId),
        eq(s.orders.titleId, titleId),
        isNull(s.orders.testPurchaseAt),
        sql`${s.orders.amountOre} > 0`,
      ),
    )
    .orderBy(desc(s.orders.orderedAt))
    .limit(1);
  return row ? { ore: row.amountOre, machineId: null, differs: false } : null;
}

/**
 * En egen produkt: översiktens rad, innehållets versioner, senaste packningarna, valbara
 * delar och (för roller som ser belopp) pris och kvar per pack. null = ingen sådan titel.
 */
export async function loadMysteryDetailFor(
  viewer: Viewer,
  titleId: string,
  now: Date = new Date(),
): Promise<MysteryDetail | null> {
  const overview = await loadMysteryOverviewFor(viewer, now);
  const title = overview.titles.find((t) => t.id === titleId);
  if (!title) return null;
  const orgId = viewer.organization.id;
  const master = await loadMasterDataFor(viewer, now);
  const choices = master.titles
    .filter((t) => !t.archived && t.mergedIntoId === null && t.ownProduct !== true)
    .map((t) => ({ id: t.id, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));

  const { versions, packings, salePrice, settings } = await withUserDbFor(
    viewer.user,
    async (tx) => {
      const v = await tx
        .select({
          id: s.mysteryRecipes.id,
          version: s.mysteryRecipes.version,
          validFrom: s.mysteryRecipes.validFrom,
          batchSize: s.mysteryRecipes.batchSize,
          rows: sql<number>`(select count(*)::int from public.mystery_recipe_items i
                           where i.organization_id = ${s.mysteryRecipes.organizationId}
                             and i.recipe_id = ${s.mysteryRecipes.id})`,
        })
        .from(s.mysteryRecipes)
        .where(
          and(eq(s.mysteryRecipes.organizationId, orgId), eq(s.mysteryRecipes.titleId, titleId)),
        )
        .orderBy(desc(s.mysteryRecipes.version))
        .limit(10);
      const p = overview.seesMoney
        ? await tx
            .select({
              id: s.mysteryPackings.id,
              packedAt: s.mysteryPackings.packedAt,
              batches: s.mysteryPackings.batches,
              packs: s.mysteryPackings.packs,
              placeName: s.stockLocations.name,
              version: s.mysteryRecipes.version,
              costPerPackOre: s.mysteryPackings.costPerPackOre,
              undoneAt: s.mysteryPackings.undoneAt,
              packedBy: s.mysteryPackings.packedBy,
            })
            .from(s.mysteryPackings)
            .innerJoin(
              s.stockLocations,
              and(
                eq(s.stockLocations.organizationId, s.mysteryPackings.organizationId),
                eq(s.stockLocations.id, s.mysteryPackings.locationId),
              ),
            )
            .innerJoin(
              s.mysteryRecipes,
              and(
                eq(s.mysteryRecipes.organizationId, s.mysteryPackings.organizationId),
                eq(s.mysteryRecipes.id, s.mysteryPackings.recipeId),
              ),
            )
            .where(
              and(
                eq(s.mysteryPackings.organizationId, orgId),
                eq(s.mysteryPackings.titleId, titleId),
                gte(s.mysteryPackings.packedAt, new Date(now.getTime() - 90 * 86_400_000)),
              ),
            )
            .orderBy(desc(s.mysteryPackings.packedAt))
            .limit(5)
        : [];
      const price = overview.seesMoney
        ? await querySalePrice(tx, orgId, titleId, overview.today)
        : null;
      // Påfyllaren ser inga belopp (och får inte läsa inställningarna): standardvärden.
      const settings = overview.seesMoney ? await querySettings(tx, orgId) : DEFAULT_SETTINGS;
      return { versions: v, packings: p, salePrice: price, settings };
    },
  );

  const limit = now.getTime() - UNDO_MINUTES * 60_000;
  const canUndoAny = overview.canEdit;
  const packingRows: PackingRow[] = packings.map((p) => ({
    id: p.id,
    packedAt: new Date(p.packedAt).toISOString(),
    batches: p.batches,
    packs: p.packs,
    placeName: p.placeName,
    version: p.version,
    costPerPackOre: p.costPerPackOre,
    undone: p.undoneAt !== null,
    undoable:
      overview.canPack &&
      p.undoneAt === null &&
      new Date(p.packedAt).getTime() >= limit &&
      (canUndoAny || p.packedBy === viewer.user.userId),
  }));

  return {
    overview,
    title,
    versions: versions.map((v) => ({ ...v, rows: Number(v.rows) })),
    packings: packingRows,
    choices,
    salePriceOre: salePrice?.ore ?? null,
    salePriceMachine:
      salePrice?.differs && salePrice.machineId
        ? (master.machines.find((m) => m.id === salePrice.machineId)?.code ?? null)
        : null,
    fees: { vatRateBp: settings.vatRateBp, cardFeeBp: settings.cardFeeBp },
  };
}

/** Ett mystery pack vars inköpspris inte stämmer med kalkylen (för notisen). */
export interface CostDrift {
  readonly titleId: string;
  readonly name: string;
  /** Titelns inköpspris i dag (öre), null när det saknas. */
  readonly currentOre: number | null;
  /** Kalkylen: innehållet × dagens inköpspriser, per pack (öre). */
  readonly calculatedOre: number;
}

/**
 * Mystery packs som "kostar nu X kr, inte Y kr": kalkylen är inte titelns inköpspris i dag.
 * För notisen på Inköpspriser (hela appen och Enkel vy). Ägare, admin och läsare; andra
 * roller får en tom lista (påfyllaren ser inga belopp).
 */
export async function loadMysteryCostDriftsFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<CostDrift[]> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ALL_ROLES);
  if (!(ECONOMY_ROLES as readonly string[]).includes(role)) return [];
  const today = businessToday(now, viewer.organization.timezone);
  return withUserDbFor(viewer.user, async (tx) => {
    const recipes = await queryMysteryRecipeRefs(tx, orgId);
    if (recipes.length === 0) return [];
    const prices = await queryPrices(tx, orgId);
    const index = new PriceIndex(prices);
    const drifts = mysteryCostDrifts(
      recipes,
      (id) => index.priceOn(id, today)?.unitCostOre ?? null,
    );
    if (drifts.length === 0) return [];
    const names = await tx
      .select({ id: s.titles.id, name: s.titles.name })
      .from(s.titles)
      .where(
        and(
          eq(s.titles.organizationId, orgId),
          inArray(
            s.titles.id,
            drifts.map((d) => d.titleId),
          ),
        ),
      );
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return drifts
      .map((d) => ({ ...d, name: nameOf.get(d.titleId) ?? d.titleId }))
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  });
}

/**
 * Omgångar att packa per mystery pack (titelns id → svaret), räknat från facken: samma tal
 * och samma dag som Mystery-sidorna visar. För Vårt lager, Inköp och delägarens inköpslista
 * (kopplas in i R2-9). Alla roller.
 */
export async function loadMysteryPackPlansFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<Map<string, MysteryPackPlan>> {
  const overview = await loadMysteryOverviewFor(viewer, now);
  return new Map(overview.titles.flatMap((t) => (t.toPack ? [[t.id, t.toPack] as const] : [])));
}
