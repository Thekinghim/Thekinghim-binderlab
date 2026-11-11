/**
 * Granskningen av runda 2: minus hemma + tomt fack ska ge SAMMA besked på Mystery, Vårt
 * lager, Inköp och delägarens inköpslista, och delarna ska köpas för samma antal omgångar.
 *
 * Ett läge matas till båda modellerna: omgång 14 med 4 Pokémon 151, −14 färdiga hemma
 * (någon har fyllt på utan att trycka Packa), facket i BL-001 tomt.
 */
import { describe, expect, it } from "vitest";

import { purchasePlan, purchaseQty } from "@/analytics/purchasing";
import type { PurchasingInput } from "@/analytics/purchasing";
import { sv } from "@/i18n/sv";

import { countFirst, needAction } from "../../_lib/steps";
import {
  mergedPack,
  packActionHref,
  packInPlaceHref,
  packNowFor,
  toPackFromSlots,
  type SlotFacts,
} from "./model";

const TODAY = "2026-11-02";
const HEMMA = "11111111-1111-4111-8111-111111111111";
const KONTORET = "22222222-2222-4222-8222-222222222222";
const RECIPE = { titleId: "MP", batchSize: 14, items: [{ titleId: "151", quantity: 4 }] };
const EMPTY_SLOT: SlotFacts = {
  machineId: "m1",
  label: "BL-001",
  onHand: 0,
  sold: 14,
  everSold: true,
};

function plan(home: number, given: NonNullable<PurchasingInput["mysteryBatches"]>[number]) {
  return purchasePlan({
    today: TODAY,
    titles: [
      { id: "MP", name: "Mystery Pack", mysteryBatchSize: 14 },
      { id: "151", name: "Pokémon 151" },
    ],
    suppliers: [],
    supplierItems: [],
    warehouseStock: [{ titleId: "MP", onHand: home }],
    machineStock: [],
    openPurchaseOrders: [],
    // 1 pack om dagen: planen själv ser 14 dagar = 1 omgång.
    demand: [
      { titleId: "MP", dailyMilli: new Array<number>(28).fill(1_000), dayVarianceMilli2: 0 },
    ],
    mysteryRecipes: [RECIPE],
    mysteryBatches: [given],
  });
}

describe("minus hemma och ett tomt fack: samma antal överallt", () => {
  const places = [{ id: HEMMA }, { id: KONTORET }];

  it("−14 hemma: Mystery säger 2 omgångar, och planen, raderna och delarna säger också 2", () => {
    const inPlaces: Record<string, number> = { [HEMMA]: -14, [KONTORET]: 0 };
    // Mystery-kortet.
    const slots = toPackFromSlots({
      batchSize: 14,
      perPlace: Object.values(inPlaces),
      facts: [EMPTY_SLOT],
      today: TODAY,
    });
    const card = mergedPack({ places, inPlaces, batchSize: 14, plan: slots, t: sv });
    expect(card).toMatchObject({
      placeId: HEMMA,
      fixBatches: 1,
      slotBatches: 1,
      batches: 2,
      packs: 28,
    });
    expect(card?.text).toContain("Packa 2 omgångar nu");

    // Talet inköpsplanen får (queryMysteryPackNow anropar samma funktion).
    const now = packNowFor({
      batchSize: 14,
      inPlaces: places.map((p) => ({ id: p.id, quantity: inPlaces[p.id] ?? 0 })),
      facts: [EMPTY_SLOT],
      today: TODAY,
    });
    expect(now).toEqual({ batches: card!.batches, fixPlaceId: HEMMA });

    // Planen: mystery-packets rad och delarna.
    const p = plan(-14, { titleId: "MP", ...now });
    const mp = p.lines.find((l) => l.titleId === "MP")!;
    expect(mp.packNow).toEqual({ batches: 2, packs: 28, fixPlaceId: HEMMA });
    expect(purchaseQty(mp)).toBe(card!.packs);
    const part = p.lines.find((l) => l.titleId === "151")!;
    // Delar för 2 omgångar (8 st), inte 1: den opackade omgången har också ätit delar.
    expect(part.mysteryNeed).toMatchObject({ packs: 8, parts: [{ batches: 2 }] });
    expect(purchaseQty(part)).toBe(8);

    // Raden på Vårt lager, Inköp och delägarens lista: "Packa 2 omgångar", inte "Räkna om",
    // med samma länk som Mystery-kortets knapp.
    const fix = mp.packNow?.fixPlaceId;
    expect(countFirst(-14, fix)).toBe(false);
    const action = needAction({
      own: true,
      needQty: purchaseQty(mp),
      mysteryBatchSize: 14,
      home: -14,
      fixPlaceId: fix,
    });
    expect(action).toMatchObject({
      batches: 2,
      packs: 28,
      text: "Packa 2 omgångar",
      placeId: HEMMA,
    });
    expect(packActionHref("MP", action!.packs, action!.placeId)).toBe(
      packInPlaceHref("MP", card!.placeId, card!.packs),
    );
  });

  it("−14 hemma utan något fack att fylla: 1 omgång rättar minuset, på båda", () => {
    const now = packNowFor({
      batchSize: 14,
      inPlaces: [{ id: HEMMA, quantity: -14 }],
      facts: [{ ...EMPTY_SLOT, onHand: 14, sold: 0 }],
      today: TODAY,
    });
    expect(now).toEqual({ batches: 1, fixPlaceId: HEMMA });
    expect(countFirst(-14, now.fixPlaceId)).toBe(false);
  });

  it("udda minus (−1) eller minus i två lager: räkna om först, på båda", () => {
    const odd: Record<string, number> = { [HEMMA]: -1, [KONTORET]: 0 };
    const slots = toPackFromSlots({
      batchSize: 14,
      perPlace: Object.values(odd),
      facts: [EMPTY_SLOT],
      today: TODAY,
    });
    expect(mergedPack({ places, inPlaces: odd, batchSize: 14, plan: slots, t: sv })).toBeNull();
    const now = packNowFor({
      batchSize: 14,
      inPlaces: places.map((p) => ({ id: p.id, quantity: odd[p.id] ?? 0 })),
      facts: [EMPTY_SLOT],
      today: TODAY,
    });
    // Bara fackets omgång, och inget lager att packa i: raden säger "1. Räkna om. 2. Packa".
    expect(now).toEqual({ batches: 1 });
    expect(countFirst(-1, now.fixPlaceId)).toBe(true);

    const two = packNowFor({
      batchSize: 14,
      inPlaces: [
        { id: HEMMA, quantity: -14 },
        { id: KONTORET, quantity: -14 },
      ],
      facts: [EMPTY_SLOT],
      today: TODAY,
    });
    expect(two).toEqual({ batches: 1 });
    expect(
      mergedPack({
        places,
        inPlaces: { [HEMMA]: -14, [KONTORET]: -14 },
        batchSize: 14,
        plan: slots,
        t: sv,
      }),
    ).toBeNull();
  });

  it('delägarens inköpslista: inget "Räkna om" när minuset packas bort', () => {
    // Raden som buyList() läser: action.placeId sätter packPlaceId, negative styr countFirst.
    expect(countFirst(-14, null)).toBe(true);
    expect(countFirst(0, HEMMA)).toBe(false);
  });
});
