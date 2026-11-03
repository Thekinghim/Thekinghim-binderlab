/**
 * "Rätta priset": det nya priset gäller all försäljning hittills. Förhandsvisningen ("X order
 * får nytt inköp, vinsten ändras med Y kr") och stegen som server action kör räknas här.
 */

import { describe, expect, it } from "vitest";

import { correctionText as rawText, correctionToast as rawToast, planCorrection } from "./model";

const NBSP = " ";
const MINUS = "\u2212";

/** Hårda mellanslag (format.ts) som vanliga, så att texterna går att läsa här. */
const plain = (t: string) => t.replace(/\u00a0|\u202f/g, " ");
const correctionText = (...a: Parameters<typeof rawText>) => rawText(...a).map(plain);
const correctionToast = (...a: Parameters<typeof rawToast>) => plain(rawToast(...a));
const TODAY = "2026-11-03";

/** Fyra prisperioder (som ägarens fyra prisändringar) och order i varje. */
const PRICES = [
  { unitCostOre: 10_000, validFrom: "2026-10-01" },
  { unitCostOre: 10_500, validFrom: "2026-10-15" },
  { unitCostOre: 11_000, validFrom: "2026-10-25" },
  { unitCostOre: 11_200, validFrom: "2026-11-03" },
];
const DAYS = [
  { date: "2026-10-02", orders: 3 },
  { date: "2026-10-16", orders: 2 },
  { date: "2026-10-26", orders: 4 },
  { date: "2026-11-03", orders: 1 },
];

describe("planCorrection", () => {
  it("ger alla sålda order det nya priset och räknar vinstens förändring", () => {
    const c = planCorrection({
      prices: PRICES,
      orderDays: DAYS,
      unitCostOre: 9_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.start).toBe("2026-10-01");
    expect(c.validTo).toBeNull();
    expect(c.closedUntil).toBeNull();
    expect(c.affectedOrders).toBe(10);
    expect(c.ordersGainingPrice).toBe(0);
    // 3·(−1000) + 2·(−1500) + 4·(−2000) + 1·(−2200) = −16 200 öre i inköp.
    expect(c.costDeltaOre).toBe(-16_200);
    expect(c.profitDeltaOre).toBe(16_200);
    expect(c.steps).toEqual(
      PRICES.map((p) => ({ kind: "update", validFrom: p.validFrom, newValidFrom: null })),
    );
    expect(correctionText(c, TODAY)).toEqual([
      `10 order får nytt inköp, vinsten ändras med +162${NBSP}kr.`,
    ]);
    expect(correctionToast(c)).toBe(`Priset rättat – vinsten ändrades med +162${NBSP}kr`);
  });

  it("perioder som redan har priset rörs inte; dyrare inköp sänker vinsten", () => {
    const c = planCorrection({
      prices: PRICES,
      orderDays: DAYS,
      unitCostOre: 11_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.steps.map((s) => s.validFrom)).toEqual(["2026-10-01", "2026-10-15", "2026-11-03"]);
    // 3·1000 + 2·500 + 0 + 1·(−200) = 3 800 öre dyrare.
    expect(c.affectedOrders).toBe(6);
    expect(c.profitDeltaOre).toBe(-3_800);
    expect(correctionText(c, TODAY)[0]).toBe(
      `6 order får nytt inköp, vinsten ändras med ${MINUS}38${NBSP}kr.`,
    );
  });

  it("ett pris som börjar senare än i dag behålls", () => {
    const c = planCorrection({
      prices: [...PRICES, { unitCostOre: 20_000, validFrom: "2026-12-01" }],
      orderDays: DAYS,
      unitCostOre: 9_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.validTo).toBe("2026-11-30");
    expect(c.steps.some((s) => s.validFrom === "2026-12-01")).toBe(false);
  });

  it("order före första priset får pris: första perioden flyttas bakåt", () => {
    const c = planCorrection({
      prices: [{ unitCostOre: 10_000, validFrom: "2026-10-10" }],
      orderDays: [
        { date: "2026-10-05", orders: 2 },
        { date: "2026-10-12", orders: 1 },
      ],
      unitCostOre: 10_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.start).toBe("2026-10-05");
    expect(c.steps).toEqual([
      { kind: "update", validFrom: "2026-10-10", newValidFrom: "2026-10-05" },
    ]);
    expect(c.affectedOrders).toBe(2);
    expect(c.ordersGainingPrice).toBe(2);
    expect(c.profitDeltaOre).toBe(0);
    expect(correctionText(c, TODAY)).toEqual([
      "2 order får inköpspris.",
      "2 order saknade pris och räknas nu in i vinsten.",
    ]);
    expect(correctionToast(c)).toBe("Priset rättat – 2 order räknas nu in i vinsten");
  });

  it("utan pris läggs ett nytt in från titelns första order", () => {
    const c = planCorrection({
      prices: [],
      orderDays: [{ date: "2026-10-20", orders: 5 }],
      unitCostOre: 8_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.steps).toEqual([{ kind: "insert", validFrom: "2026-10-20" }]);
    expect(c.ordersGainingPrice).toBe(5);
  });

  it("utan order och pris gäller priset från i dag", () => {
    const c = planCorrection({
      prices: [],
      orderDays: [],
      unitCostOre: 8_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.steps).toEqual([{ kind: "insert", validFrom: TODAY }]);
    expect(correctionText(c, TODAY)).toEqual(["Inga sålda order får nytt inköp."]);
    expect(correctionToast(c)).toBe("Priset rättat");
  });

  it("en stängd månad rörs inte: rättelsen börjar dagen efter den", () => {
    const c = planCorrection({
      prices: PRICES,
      orderDays: DAYS,
      unitCostOre: 9_000,
      closedMonths: ["2026-09", "2026-10"],
      today: TODAY,
    });
    expect(c.start).toBe("2026-11-01");
    expect(c.closedUntil).toBe("2026-10");
    // Oktoberpriset (110 kr från 25 okt.) får en ny period från 1 nov.; dagens pris rättas.
    expect(c.steps).toEqual([
      { kind: "insert", validFrom: "2026-11-01" },
      { kind: "update", validFrom: "2026-11-03", newValidFrom: null },
    ]);
    expect(c.affectedOrders).toBe(1);
    expect(c.profitDeltaOre).toBe(2_200);
    expect(correctionText(c, TODAY)).toEqual([
      "Oktober 2026 är stängd, rättas från 1 nov.",
      `1 order får nytt inköp, vinsten ändras med +22${NBSP}kr.`,
    ]);
  });

  it("har priset före den stängda månadens slut redan rätt belopp läggs ingen ny period in", () => {
    const c = planCorrection({
      prices: [{ unitCostOre: 9_000, validFrom: "2026-09-25" }],
      orderDays: DAYS,
      unitCostOre: 9_000,
      closedMonths: ["2026-10"],
      today: TODAY,
    });
    expect(c.start).toBe("2026-11-01");
    expect(c.steps).toEqual([]);
  });

  it("en stängd månad före titelns början spelar ingen roll", () => {
    const c = planCorrection({
      prices: PRICES,
      orderDays: DAYS,
      unitCostOre: 9_000,
      closedMonths: ["2026-08"],
      today: TODAY,
    });
    expect(c.start).toBe("2026-10-01");
    expect(c.closedUntil).toBeNull();
  });

  it("är dagens månad stängd går det inte att rätta", () => {
    const c = planCorrection({
      prices: PRICES,
      orderDays: DAYS,
      unitCostOre: 9_000,
      closedMonths: ["2026-11"],
      today: TODAY,
    });
    expect(c.start).toBeNull();
    expect(c.steps).toEqual([]);
    expect(correctionText(c, TODAY)).toEqual(["November 2026 är stängd. Välj Nytt inköpspris."]);
  });

  it("samma pris överallt ger inga steg", () => {
    const c = planCorrection({
      prices: [{ unitCostOre: 10_000, validFrom: "2026-10-01" }],
      orderDays: DAYS,
      unitCostOre: 10_000,
      closedMonths: [],
      today: TODAY,
    });
    expect(c.steps).toEqual([]);
    expect(c.affectedOrders).toBe(0);
  });

  it("öre visas bara när de finns", () => {
    const c = planCorrection({
      prices: [{ unitCostOre: 10_000, validFrom: "2026-10-01" }],
      orderDays: [{ date: "2026-10-02", orders: 1 }],
      unitCostOre: 9_950,
      closedMonths: [],
      today: TODAY,
    });
    expect(correctionToast(c)).toBe(`Priset rättat – vinsten ändrades med +0,50${NBSP}kr`);
  });
});
