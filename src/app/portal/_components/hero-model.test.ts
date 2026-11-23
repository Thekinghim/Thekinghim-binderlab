import { describe, expect, it } from "vitest";

import type { PortalTrendMonth } from "@/server/portal/model";

import {
  compactKr,
  compensationChange,
  compSegments,
  faultDescription,
  faultStepIndex,
  isBestMonth,
  packsPerDay,
  podium,
} from "./hero-model";

const m = (
  month: string,
  revenueOre: number,
  compensationOre: number,
  extra: Partial<PortalTrendMonth> = {},
): PortalTrendMonth => ({
  month: month as PortalTrendMonth["month"],
  revenueOre,
  orders: 0,
  compensationOre,
  compensationPending: false,
  partial: false,
  ...extra,
});

describe("compSegments", () => {
  it("provision och hyra, utan delar som är 0", () => {
    expect(
      compSegments({ shareOre: 0, commissionOre: 375_100, rentOre: 90_000, pending: false }),
    ).toEqual([
      { kind: "commission", label: "Provision", ore: 375_100 },
      { kind: "rent", label: "Hyra", ore: 90_000 },
    ]);
  });
  it("en andel som inte kunde räknas visas inte", () => {
    expect(
      compSegments({ shareOre: 10_000, commissionOre: 0, rentOre: 50_000, pending: true }),
    ).toEqual([{ kind: "rent", label: "Hyra", ore: 50_000 }]);
  });
});

describe("compensationChange", () => {
  const trend = [m("2026-09", 3_000_000, 395_200), m("2026-10", 3_750_000, 465_100)];
  it("mot månaden före", () => {
    expect(compensationChange(trend, "2026-10")).toEqual({
      prevOre: 395_200,
      prevMonth: "2026-09",
      changeBp: 1769,
    });
  });
  it("ingen jämförelse för första månaden, pågående månad eller okänd andel", () => {
    expect(compensationChange(trend, "2026-09")).toBeNull();
    expect(
      compensationChange([trend[0]!, m("2026-10", 1, 1, { partial: true })], "2026-10"),
    ).toBeNull();
    expect(
      compensationChange([m("2026-09", 1, 1, { compensationPending: true }), trend[1]!], "2026-10"),
    ).toBeNull();
    expect(compensationChange([m("2026-09", 1, 0), trend[1]!], "2026-10")).toBeNull();
  });
});

describe("isBestMonth", () => {
  const trend = [
    m("2026-08", 2_000_000, 0),
    m("2026-09", 3_000_000, 0),
    m("2026-10", 3_750_000, 0),
  ];
  it("sant när månaden sålt mest", () => {
    expect(isBestMonth(trend, "2026-10")).toBe(true);
    expect(isBestMonth(trend, "2026-09")).toBe(false);
  });
  it("falskt med bara en månad eller lika mycket", () => {
    expect(isBestMonth([trend[2]!], "2026-10")).toBe(false);
    expect(isBestMonth([m("2026-09", 5, 0), m("2026-10", 5, 0)], "2026-10")).toBe(false);
  });
});

describe("podium", () => {
  it("flest sålda först, etta i mitten", () => {
    const top = [
      { name: "A", orders: 27, revenueOre: 900 },
      { name: "B", orders: 38, revenueOre: 800 },
      { name: "C", orders: 46, revenueOre: 700 },
      { name: "D", orders: 31, revenueOre: 600 },
      { name: "E", orders: 22, revenueOre: 500 },
      { name: "F", orders: 3, revenueOre: 99_999 },
    ];
    const { places, ordersTop } = podium(top);
    expect(places.map((p) => `${p.rank}${p.name}`)).toEqual(["4A", "2B", "1C", "3D", "5E"]);
    expect(ordersTop).toBe(164);
  });
  it("färre än fem", () => {
    expect(podium([{ name: "A", orders: 2, revenueOre: 1 }]).places).toEqual([
      { rank: 1, name: "A", orders: 2 },
    ]);
    expect(podium([]).places).toEqual([]);
  });
});

describe("små hjälpare", () => {
  it("pack per dag och korta belopp", () => {
    expect(packsPerDay(218, 31)).toBe(7);
    expect(packsPerDay(5, 0)).toBe(5);
    expect(compactKr(3_751_200)).toBe("37,5k");
    expect(compactKr(94_000)).toBe("940");
  });
  it("beskrivningen tar med delen bara när den säger något nytt", () => {
    expect(faultDescription("store_screen", "screen", "")).toBeUndefined();
    expect(faultDescription("store_damage", "screen", " Spricka ")).toBe("Gäller skärmen. Spricka");
    expect(faultDescription("store_other", null, "Låter konstigt")).toBe("Låter konstigt");
  });
  it("ärendets steg", () => {
    expect(faultStepIndex("open")).toBe(0);
    expect(faultStepIndex("in_progress")).toBe(1);
    expect(faultStepIndex("resolved")).toBe(2);
  });
});
