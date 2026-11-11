import { describe, expect, it } from "vitest";

import { fleetRanking, type FleetMachineInput } from "@/analytics/ranking/fleet";

import { homeRankingLine, rankingView } from "./ranking";

const machines = new Map(
  ["a", "b", "c", "d"].map((id, i) => [id, { code: `BL-00${i + 1}`, name: id.toUpperCase() }]),
);
const hrefOf = (code: string) => `/automater/${code.toLowerCase()}`;
const plain = (s: string | null) => (s ?? "").replace(/[ ⁠]/g, " ");

function m(id: string, profit: number, days = 30, extra: Partial<FleetMachineInput> = {}) {
  return {
    machineId: id,
    activeDays: days,
    orders: days * 4,
    revenuePerDayOre: profit * 3,
    profitPerDayOre: profit,
    ...extra,
  } satisfies FleetMachineInput;
}

function view(now: FleetMachineInput[], before: FleetMachineInput[] = [], deducted = false) {
  const ranking = fleetRanking(now, before);
  return {
    ranking,
    view: rankingView({ ranking, machines, hrefOf, storeShareDeducted: deducted }),
  };
}

describe("rankingView: flera automater", () => {
  it("rubriken säger vem som tjänar mest och vem som bör flyttas", () => {
    const { view: v, ranking } = view([
      m("a", 41_200, 30, { lostRevenueOre: 32_000, stockoutDayTenths: 35 }),
      m("b", 20_000),
      m("c", 3_500),
    ]);
    expect(plain(v.title)).toBe("BL-001 tjänar mest: 412 kr/dag.");
    expect(plain(v.aside)).toBe("BL-003 tjänar dåligt: överväg att flytta den.");
    expect(v.rows.map((r) => r.verdictText)).toEqual([
      "Bäst",
      "Tjänar bra",
      "Tjänar dåligt: överväg att flytta",
    ]);
    expect(v.rows.map((r) => r.warn)).toEqual([false, false, true]);
    expect(plain(v.rows[0]!.profit)).toBe("412 kr/dag");
    expect(plain(v.rows[0]!.sales)).toBe("Säljer 1 236 kr/dag · 4,0 pack/dag");
    expect(plain(v.rows[0]!.lost)).toBe("Titlar slutsålda 3,5 dagar · ca 320 kr förlorat");
    expect(v.rows[1]!.lost).toBeNull();
    expect(plain(v.rows[2]!.basis)).toBe("30 dagar · 165 kr/dag mindre än en vanlig automat");
    expect(v.rows[0]!.href).toBe("/automater/bl-001");
    expect(v.note).toBe("Vinst före butikernas andel.");
    expect(plain(homeRankingLine(v, ranking))).toBe(
      "BL-001 tjänar mest: 412 kr/dag. BL-003 tjänar dåligt: överväg att flytta den.",
    );
  });

  it("flera som går dåligt, och vyknappen byter fotnoten", () => {
    const { view: v } = view(
      [m("a", 40_000), m("b", 30_000), m("c", -100), m("d", 2_000)],
      [],
      true,
    );
    expect(plain(v.aside)).toBe("2 automater tjänar dåligt: överväg att flytta dem.");
    expect(v.note).toBe("Vinst efter butikernas andel.");
  });

  it("ingen går dåligt", () => {
    const { view: v, ranking } = view([m("a", 40_000), m("b", 30_000)]);
    expect(v.aside).toBe("Ingen automat tjänar dåligt.");
    expect(plain(homeRankingLine(v, ranking))).toBe(
      "BL-001 tjänar mest: 400 kr/dag. Ingen automat tjänar dåligt.",
    );
  });

  it("för lite data att jämföra: sägs rakt ut, och Hem visar ingen rad", () => {
    const { view: v, ranking } = view([m("a", 40_000, 6), m("b", 30_000, 5)]);
    expect(v.title).toBe("Vinst per dag.");
    expect(plain(v.aside)).toBe(
      "För lite data för att jämföra: minst två automater behöver 14 dagar.",
    );
    expect(plain(v.rows[0]!.verdictText)).toBe("För ny: 6 dagar");
    expect(homeRankingLine(v, ranking)).toBeNull();
  });

  it("arkiverade (okända) automater visas inte", () => {
    const { view: v } = view([m("a", 40_000), m("b", 30_000), m("okänd", 10)]);
    expect(v.rows.map((r) => r.code)).toEqual(["BL-001", "BL-002"]);
  });
});

describe("rankingView: automat ur drift", () => {
  it("raden visar driftläget i stället för omdömet, talen är desamma", () => {
    const ranking = fleetRanking([m("a", 40_000), m("b", 30_000)], []);
    const v = rankingView({
      ranking,
      machines,
      hrefOf,
      storeShareDeducted: false,
      down: new Map([["b", "Ur drift"]]),
    });
    expect(v.rows.map((r) => r.verdictText)).toEqual(["Bäst", "Ur drift nu"]);
    expect(v.rows.map((r) => r.warn)).toEqual([false, true]);
    expect(plain(v.rows[1]!.profit)).toBe("300 kr/dag");
    // Sammanfattningen talar om vinsten, inte om driften.
    expect(v.aside).toBe("Ingen automat tjänar dåligt.");
  });

  it("en enda automat: driftläget står först", () => {
    const ranking = fleetRanking([m("a", 41_200)], [m("a", 38_000)]);
    const v = rankingView({
      ranking,
      machines,
      hrefOf,
      storeShareDeducted: false,
      down: new Map([["a", "Ur drift"]]),
    });
    expect(plain(v.aside)).toBe("Ur drift nu. Går som förra perioden (+8 %).");
    expect(v.rows[0]!.verdictText).toBe("Ur drift nu");
  });
});

describe("rankingView: en automat", () => {
  it("jämför med förra perioden", () => {
    const { view: v, ranking } = view([m("a", 41_200)], [m("a", 38_000)]);
    expect(v.mode).toBe("single");
    expect(plain(v.title)).toBe("BL-001 tjänar 412 kr/dag.");
    expect(plain(v.aside)).toBe("Går som förra perioden (+8 %).");
    expect(plain(v.rows[0]!.basis)).toBe("30 dagar · förra perioden 380 kr/dag (+8 %)");
    // Hem visar ingen rad med en automat.
    expect(homeRankingLine(v, ranking)).toBeNull();
  });

  it("sämre än förra perioden varnar", () => {
    const { view: v } = view([m("a", 20_000)], [m("a", 40_000)]);
    expect(plain(v.aside)).toBe("Går sämre än förra perioden (−50 %).");
    expect(v.rows[0]!.warn).toBe(true);
  });

  it("utan förra period och med för få dagar sägs det", () => {
    expect(view([m("a", 20_000)]).view.aside).toBe(
      "Bara en automat och ingen förra period: inget att jämföra med än.",
    );
    expect(plain(view([m("a", 20_000, 5)]).view.aside)).toBe(
      "För lite data: 5 dagar. Minst 14 behövs.",
    );
  });

  it("ingen försäljning", () => {
    const { view: v } = view([]);
    expect(v).toMatchObject({
      mode: "empty",
      rows: [],
      title: "Ingen automat har sålt i perioden.",
    });
  });
});
