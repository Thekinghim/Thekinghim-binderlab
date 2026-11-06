import { describe, expect, it } from "vitest";

import { timeSaved } from "@/analytics/value";
import type { ValueData } from "@/server/varde/load";

import { buildValueView, changeText, hoursText, monthLabel } from "./view";

function data(overrides: Partial<ValueData> = {}): ValueData {
  return {
    organizationName: "Testbolaget",
    timeZone: "Europe/Stockholm",
    today: "2026-11-05",
    month: "2026-10",
    period: { start: "2026-10-01", end: "2026-10-31" },
    partial: false,
    months: ["2026-11", "2026-10"],
    hasData: true,
    refill: {
      period: { start: "2026-10-01", end: "2026-10-31" },
      maxDays: 7,
      refills: { onTime: 3, afterEmpty: 1, unknown: 0 },
      onTimeShareBp: 7_500,
      savedUnits: 10,
      savedRevenueOre: 49_000,
      savedGrossProfitOre: 29_000,
      unitsWithoutPrice: 0,
      byMonth: [],
      series: [],
    },
    lost: { lostRevenueOre: 12_300, heuristicLostRevenueOre: 0, stockoutDays: 2 },
    time: timeSaved([{ month: "2026-10", kind: "refill_visit", count: 30 }], {
      months: ["2026-10"],
    }),
    hourlyCostOre: null,
    margin: {
      month: "2026-10",
      months: [],
      current: {
        month: "2026-10",
        partial: false,
        orders: 100,
        revenueOre: 490_000,
        keptOre: 290_000,
        unpricedRevenueOre: 0,
      },
      previous: {
        month: "2026-09",
        partial: false,
        orders: 80,
        revenueOre: 392_000,
        keptOre: 232_000,
        unpricedRevenueOre: 0,
      },
      revenueChangeBp: 2_500,
      keptChangeBp: 2_500,
      keptMarginBp: 5_918,
      machines: [
        {
          key: "m-1",
          orders: 100,
          revenueOre: 490_000,
          keptOre: 290_000,
          previousKeptOre: 232_000,
          changeBp: 2_500,
        },
      ],
      stores: [
        {
          key: "s-1",
          orders: 100,
          revenueOre: 490_000,
          keptOre: 290_000,
          previousKeptOre: null,
          changeBp: null,
          storeShareOre: 49_000,
          ourOre: 241_000,
        },
      ],
    },
    trend: [
      {
        month: "2026-10",
        partial: false,
        revenueOre: 490_000,
        keptOre: 290_000,
        savedRevenueOre: 49_000,
        lostRevenueOre: 12_300,
        minutesSaved: 150,
      },
    ],
    actions: [],
    names: {
      titles: [],
      machines: [{ id: "m-1", code: "BL-001", name: "Automat 1" }],
      stores: [{ id: "s-1", name: "ICA Test" }],
    },
    ...overrides,
  };
}

describe("text", () => {
  it("timmar och minuter", () => {
    expect(hoursText(45)).toBe("45 min");
    expect(hoursText(150)).toBe("2,5 h");
    expect(changeText(null)).toBe("–");
    expect(changeText(2_500)).toBe("+25 %");
    expect(monthLabel("2026-10")).toBe("oktober 2026");
  });
});

describe("buildValueView", () => {
  it("rubriken säger det viktigaste: räddad försäljning och sparad tid", () => {
    const v = buildValueView(data());
    // Påfyllningen görs av människor: rubriken säger inte att Binderlab räddade pengarna.
    expect(v.headline.title).toBe(
      "I oktober räddade påfyllning i tid 490\u00a0kr i försäljning och Binderlab sparade 2,5\u00a0h.",
    );
    expect(v.cards.map((c) => c.id)).toEqual(["saved", "time", "kept", "revenue"]);
    expect(v.cards[0]!.sub).toContain("3 av 4 påfyllningar i tid");
    expect(v.cards[0]!.sub).toContain("123 kr");
    expect(v.cards[2]).toMatchObject({ value: "2 900 kr", tone: "good" });
    expect(v.cards[2]!.sub).toBe("+25 % mot september.");
  });

  it("butikens andel bara i tabellen per butik, och bara med vyknappen", () => {
    const off = buildValueView(data());
    expect(off.stores.head).toEqual(["Butik", "Försäljning", "Kvar efter inköp"]);
    expect(off.stores.rows[0]!.cells).toHaveLength(3);
    const v = buildValueView(data(), { showStoreShare: true });
    expect(v.stores.head).toContain("Butikens andel");
    expect(v.stores.rows[0]!.cells).toEqual([
      "ICA Test",
      "4 900 kr",
      "2 900 kr",
      "490 kr",
      "2 410 kr",
    ]);
    expect(v.machines.head).not.toContain("Butikens andel");
    expect(v.machines.rows[0]!.cells[0]).toBe("BL-001");
  });

  it("visar antagandena, även att tiden inte värderas utan timkostnad", () => {
    const v = buildValueView(data());
    // Ärligt: räddat är försäljning, inte vinst, och gäller alla påfyllningar i tid.
    expect(v.assumptions.some((a) => a.includes("inte vinst"))).toBe(true);
    expect(v.assumptions.some((a) => a.includes("inte bara dem Binderlab föreslog"))).toBe(true);
    expect(v.assumptions.some((a) => a.startsWith("Påfyllning registrerad: 5 min"))).toBe(true);
    expect(v.assumptions).toContain(
      "Tiden värderas inte i kronor: ange en timkostnad under Effekt.",
    );
    const valued = buildValueView(
      data({
        hourlyCostOre: 30_000,
        time: timeSaved([{ month: "2026-10", kind: "refill_visit", count: 30 }], {
          months: ["2026-10"],
          hourlyCostOre: 30_000,
        }),
      }),
    );
    expect(valued.cards[1]!.sub).toBe("30 uppgifter. Värt 750 kr.");
  });

  it("utan data", () => {
    const v = buildValueView(data({ hasData: false, refill: null, margin: null, trend: [] }));
    expect(v.headline.title).toBe("Inget att visa för oktober än.");
    expect(v.machines.rows).toEqual([]);
  });

  it("pågående månad", () => {
    const v = buildValueView(data({ partial: true }));
    expect(v.headline.title).toMatch(/^Hittills i oktober räddade/);
    expect(v.cards[3]!.sub).toContain("(samma dagar)");
    expect(v.headline.aside).toBe("Månaden pågår. Räknat till och med i går.");
  });
});
