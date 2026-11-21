import { describe, expect, it } from "vitest";

import {
  compareByLoss,
  compareFleetRows,
  daysLeftOf,
  fillOf,
  fleetStatusLabel,
  fleetStatusOf,
  lossProfitPerDayOre,
  priceLossPerDayOre,
  profitPerPackOre,
  showsLoss,
  unitsPerDayMilli,
  type FleetStatusInput,
} from ".";

const base: FleetStatusInput = {
  offline: false,
  powerOff: false,
  startklar: false,
  units: 40,
  fillBp: 5_000,
  emptyChannels: 0,
  daysLeft: 10,
};

describe("fleetStatusOf", () => {
  it("följer prioritetsordningen", () => {
    expect(fleetStatusOf({ ...base, offline: true, units: 0 })).toBe("offline");
    expect(fleetStatusOf({ ...base, units: 0, startklar: true })).toBe("tom");
    expect(fleetStatusOf({ ...base, emptyChannels: 1, startklar: true })).toBe("fyll-pa");
    expect(fleetStatusOf({ ...base, fillBp: 2_500 })).toBe("fyll-pa");
    expect(fleetStatusOf({ ...base, fillBp: 2_501 })).toBe("i-drift");
    expect(fleetStatusOf({ ...base, startklar: true, powerOff: true })).toBe("startklar");
    expect(fleetStatusOf({ ...base, powerOff: true, daysLeft: 1 })).toBe("strom-av");
    expect(fleetStatusOf({ ...base, daysLeft: 3 })).toBe("tom-snart");
    expect(fleetStatusOf({ ...base, daysLeft: 4 })).toBe("i-drift");
    expect(fleetStatusOf({ ...base, daysLeft: null })).toBe("i-drift");
  });

  it("okänd fyllnad och okänt saldo ger inte Tom", () => {
    expect(fleetStatusOf({ ...base, units: null, fillBp: null })).toBe("i-drift");
  });

  it("etiketterna", () => {
    expect(fleetStatusLabel("tom-snart", 2)).toBe("Tom om 2 d");
    expect(fleetStatusLabel("tom-snart", 0)).toBe("Tom i dag");
    expect(fleetStatusLabel("fyll-pa")).toBe("Fyll på i dag");
    expect(fleetStatusLabel("strom-av")).toBe("Ström av");
  });

  it("sorterar offline först och ström av sist", () => {
    const rows = [
      { status: "strom-av" as const, daysLeft: 1, code: "BL-1" },
      { status: "i-drift" as const, daysLeft: 9, code: "BL-2" },
      { status: "tom-snart" as const, daysLeft: 3, code: "BL-3" },
      { status: "tom-snart" as const, daysLeft: 2, code: "BL-4" },
      { status: "offline" as const, daysLeft: null, code: "BL-5" },
    ];
    expect(rows.sort(compareFleetRows).map((r) => r.code)).toEqual([
      "BL-5",
      "BL-4",
      "BL-3",
      "BL-2",
      "BL-1",
    ]);
  });
});

describe("fyllnad och takt", () => {
  it("summerar Awish-facken", () => {
    const fill = fillOf([
      { title_id: "b", units: 0, capacity: 10, channels: 1, empty: 1 },
      { title_id: "a", units: 15, capacity: 20, channels: 2, empty: 0 },
    ]);
    expect(fill).toEqual({
      units: 15,
      capacity: 30,
      fillBp: 5_000,
      channels: 3,
      emptyChannels: 1,
      emptyTitleIds: ["b"],
    });
    expect(fillOf(null)).toBeNull();
    expect(fillOf([])).toBeNull();
    expect(
      fillOf([{ title_id: "a", units: 0, capacity: 0, channels: 0, empty: 0 }])?.fillBp,
    ).toBeNull();
  });

  it("takt i tusendelar och dagar till tom", () => {
    expect(unitsPerDayMilli(21, 14)).toBe(1_500);
    expect(unitsPerDayMilli(0)).toBe(0);
    expect(daysLeftOf(10, 1_500)).toBe(6);
    expect(daysLeftOf(0, 1_500)).toBe(0);
    expect(daysLeftOf(10, 0)).toBeNull();
  });
});

describe("förlorad vinst per dag", () => {
  const machine = {
    profitPerDayOre: 20_000,
    unitsPerDayMilli: 4_000,
    medianProfitPerDayOre: 15_000,
    daysLeft: 5,
  };

  it("offline = automatens vinst per dag, ström av = 0, startklar = medianen", () => {
    expect(lossProfitPerDayOre({ ...machine, status: "offline" })).toBe(20_000);
    expect(lossProfitPerDayOre({ ...machine, status: "strom-av" })).toBe(0);
    expect(lossProfitPerDayOre({ ...machine, status: "startklar" })).toBe(15_000);
    expect(lossProfitPerDayOre({ ...machine, status: "tom" })).toBe(20_000);
  });

  it("tomma fack = takten × vinst per pack (titelns, annars automatens snitt)", () => {
    expect(profitPerPackOre(20_000, 4_000)).toBe(5_000);
    expect(
      lossProfitPerDayOre({
        ...machine,
        status: "fyll-pa",
        emptyTitles: [
          { unitsPerDayMilli: 1_000 },
          { unitsPerDayMilli: 500, profitPerPackOre: 2_000 },
        ],
      }),
    ).toBe(6_000);
  });

  it("tom inom en dag = minst halva vinsten per dag, aldrig mer än hela", () => {
    expect(lossProfitPerDayOre({ ...machine, status: "fyll-pa", daysLeft: 1 })).toBe(10_000);
    expect(
      lossProfitPerDayOre({
        ...machine,
        status: "fyll-pa",
        emptyTitles: [{ unitsPerDayMilli: 9_000 }],
      }),
    ).toBe(20_000);
  });

  it("butikernas andel dras när den visas, och okänd vinst ger null", () => {
    expect(lossProfitPerDayOre({ ...machine, status: "offline", keepBp: 6_000 })).toBe(12_000);
    expect(
      lossProfitPerDayOre({ ...machine, status: "offline", profitPerDayOre: null }),
    ).toBeNull();
    expect(lossProfitPerDayOre({ ...machine, status: "offline", profitPerDayOre: -500 })).toBe(0);
  });

  it("prisrådet: skillnaden per pack gånger takten", () => {
    expect(
      priceLossPerDayOre({
        profitPerPackNowOre: 0,
        profitPerPackSuggestedOre: 7_500,
        unitsPerDayMilli: 8_400,
      }),
    ).toBe(63_000);
  });

  it("ordning och tröskel för texten", () => {
    const rows = [
      { lossOre: null, daysLeft: 1, code: "A" },
      { lossOre: 500, daysLeft: 4, code: "B" },
      { lossOre: 500, daysLeft: 2, code: "C" },
      { lossOre: 9_000, daysLeft: null, code: "D" },
    ];
    expect(rows.sort(compareByLoss).map((r) => r.code)).toEqual(["D", "C", "B", "A"]);
    expect(showsLoss(499)).toBe(false);
    expect(showsLoss(500)).toBe(true);
    expect(showsLoss(null)).toBe(false);
  });
});
