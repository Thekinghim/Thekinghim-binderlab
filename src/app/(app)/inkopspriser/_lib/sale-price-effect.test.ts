/**
 * Effekten av ett nytt försäljningspris ("Redigera vara"): samma ekonomi som Inköpspriser
 * (kortavgift, butikens andel, dagens inköpspris), räknad om med det nya priset.
 */

import { describe, expect, it } from "vitest";

import type { TitleEconomicsInput } from "@/domain";
import { agreement, order, placement, price } from "@/domain/testing/fixtures";

import { currentPriceEconomics, salePriceEffect } from "./price-economics";

/** Mystery pack premium: 299 kr, inköp 190 kr, kortavgift 2,5 %, automat m-1 i Sega gubben. */
function input(
  terms: Parameters<typeof agreement>[3] = {},
  orders: TitleEconomicsInput["orders"] = [
    order({
      id: "o1",
      titleId: "t-mp",
      machineId: "m-1",
      businessDate: "2026-11-02",
      amountOre: 29_900,
    }),
    order({
      id: "o2",
      titleId: "t-mp",
      machineId: "m-1",
      businessDate: "2026-11-03",
      amountOre: 29_900,
    }),
    // Gratis-pack: räknas inte om.
    order({
      id: "o3",
      titleId: "t-mp",
      machineId: "m-1",
      businessDate: "2026-11-04",
      amountOre: 0,
    }),
  ],
): TitleEconomicsInput {
  return {
    orders,
    prices: [price("t-mp", 19_000, "2026-01-01")],
    agreements: [agreement("s-sega", "2026-01-01", null, terms)],
    placements: [placement("m-1", "s-sega", "2026-01-01", null)],
    settings: { vatRateBp: 0, cardFeeBp: 250 },
    period: { start: "2026-11-01", end: "2026-11-30" },
  };
}

describe("salePriceEffect", () => {
  it("före = listans kvar per order; efter = samma order till nytt pris; skillnad per månad", () => {
    const i = input();
    const listed = currentPriceEconomics({ ...i, titleIds: ["t-mp"] }).find(
      (e) => e.titleId === "t-mp",
    )!;
    const effect = salePriceEffect(i, "t-mp", 29_900, 39_900);
    expect(effect.orders).toBe(2);
    expect(effect.beforeOre).toBe(listed.leftBeforeStoreOre);
    // Två betalda order: 299 → 399 kr ger +100 kr minus 2,5 % kortavgift (2,50 kr) var.
    // Gratis-packet (0 kr) räknas fortfarande med i snittet per order.
    const totalBefore = listed.leftBeforeStoreTotalOre!;
    expect(effect.monthlyDeltaOre).toBe(2 * (10_000 - 250));
    expect(effect.afterOre).toBe(Math.round((totalBefore + 2 * 9_750) / 3));
  });

  it("med butikens andel (20 % av intäkten): vår del räknas om med andelen", () => {
    const effect = salePriceEffect(input({ commissionBp: 2000 }), "t-mp", 29_900, 39_900);
    // Per betald order: +100 kr − 2,50 kr avgift − 20 kr andel = +77,50 kr.
    expect(effect.shareMonthlyDeltaOre).toBe(Math.round((2 * 7_750) / 3) * 3);
    expect(effect.shareAfterOre! - effect.shareBeforeOre!).toBe(Math.round((2 * 7_750) / 3));
  });

  it("utan försäljning: ett tänkt pack, ingen månadseffekt", () => {
    const effect = salePriceEffect(input({}, []), "t-mp", 29_900, 39_900, "m-1");
    expect(effect).toMatchObject({
      orders: 0,
      beforeOre: 29_900 - 748 - 19_000,
      afterOre: 39_900 - 998 - 19_000,
      monthlyDeltaOre: null,
    });
  });

  it("utan inköpspris: inget kvar per order", () => {
    const i = { ...input(), prices: [] };
    const effect = salePriceEffect(i, "t-mp", 29_900, 39_900);
    expect(effect.afterOre).toBeNull();
    expect(effect.monthlyDeltaOre).toBeNull();
  });
});
