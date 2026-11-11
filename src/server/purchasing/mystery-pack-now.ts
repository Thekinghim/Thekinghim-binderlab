/**
 * Omgångar mystery packs att packa NU, för inköpsplanen (runda 2, R2-9).
 *
 * Samma tal som Mystery-sidan visar ("Packa 1 omgång före fredag"): ett fack som är tomt eller
 * blir tomt inom 7 dagar behöver en omgång, minus hela omgångar som ligger färdiga hemma.
 * Räknas med samma funktion (toPackFromSlots) och samma underlag (fackens saldo och takt,
 * de egna lagren, automatens veckoform), så att Vårt lager, Inköp och delägarens inköpslista
 * säger samma antal som Mystery-sidan.
 *
 * Planen använder talet så här (se PurchasingInput.mysteryBatches):
 * - raden för mystery packet visar det,
 * - DELARNA köps för det största av det här talet och planens eget antal, som täcker ledtid
 *   + dagar till nästa beställning. Fackens tal ser bara 7 dagar fram och får aldrig sänka
 *   det som köps: delar tar ca 7 dagar att få hem.
 *
 * Bara antal, inga belopp. Körs som den inloggade (RLS).
 */

import "server-only";

import type { WeekShare } from "@/analytics/sellout";
import { queryOwnPlaces } from "@/app/(app)/lager/_lib/data";
import { toPackFromSlots } from "@/app/(app)/vart-lager/mystery/_lib/model";
import { queryMysterySlotFacts, type SlotSources } from "@/app/(app)/vart-lager/mystery/_lib/slots";
import type { Tx } from "@/db/client";
import { mysteryBatch, type IsoDate, type MysteryRecipeRef } from "@/domain";

export interface MysteryPackNow {
  readonly titleId: string;
  /** Hela omgångar att packa nu (0 = inget den här veckan). */
  readonly batches: number;
}

/** Omgångar att packa nu per mystery pack med innehåll. Tom utan mystery packs. */
export async function queryMysteryPackNow(
  tx: Tx,
  orgId: string,
  today: IsoDate,
  src: {
    readonly recipes: readonly Pick<MysteryRecipeRef, "titleId" | "batchSize">[];
    readonly machines: SlotSources["machines"];
    readonly stock: SlotSources["stock"];
    readonly weekShares: ReadonlyMap<string, WeekShare>;
  },
): Promise<MysteryPackNow[]> {
  const recipes = src.recipes.filter((r) => mysteryBatch(r.batchSize) !== null);
  if (recipes.length === 0) return [];
  const [places, slots] = await Promise.all([
    queryOwnPlaces(tx, orgId),
    queryMysterySlotFacts(
      tx,
      orgId,
      today,
      recipes.map((r) => r.titleId),
      { machines: src.machines, stock: src.stock },
    ),
  ]);
  const own = new Set(places.map((p) => p.id));
  return recipes.map((r) => {
    // Färdiga pack per eget lager (ett lager utan rad har 0).
    const perPlace = new Map<string, number>(places.map((p) => [p.id, 0]));
    for (const row of src.stock) {
      if (
        row.locationKind === "warehouse" &&
        row.titleId === r.titleId &&
        own.has(row.locationId)
      ) {
        perPlace.set(row.locationId, row.onHand);
      }
    }
    const plan = toPackFromSlots({
      batchSize: r.batchSize,
      perPlace: [...perPlace.values()],
      facts: slots.get(r.titleId) ?? [],
      today,
      weekShareOf: (id) => src.weekShares.get(id),
    });
    return { titleId: r.titleId, batches: plan?.batches ?? 0 };
  });
}
