import { describe, expect, it } from "vitest";

import type { AnalyticsOrder } from "@/analytics/todos/types";
import type { EconomicsSources, IsoDate, ProfitabilityInput } from "@/domain";
import { NBSP } from "@/lib/format";

import { buildMovers, changeText, moversSummary, MOVERS_TOP_N, type MoverNames } from "./movers";

const SOURCES: EconomicsSources = {
  prices: [],
  agreements: [],
  placements: [
    { machineId: "M1", storeId: "S1", from: "2026-01-01", to: null },
    { machineId: "M2", storeId: "S2", from: "2026-01-01", to: null },
    { machineId: "M3", storeId: "S2", from: "2026-01-01", to: null },
  ],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
};

let seq = 0;
function o(machineId: string, titleId: string, date: IsoDate, ore: number): AnalyticsOrder {
  seq += 1;
  return {
    id: `o${seq}`,
    externalId: `x${seq}`,
    titleId,
    machineId,
    businessDate: date,
    amountOre: ore,
  };
}

function input(orders: AnalyticsOrder[], start: IsoDate, end: IsoDate): ProfitabilityInput {
  return { ...SOURCES, orders, period: { start, end } };
}

const MACHINES: Record<string, string> = { M1: "Sega gubben", M2: "Ica Nära", M3: "Coop" };
const STORES: Record<string, string> = { S1: "Butik Ett", S2: "Butik Två" };
const TITLES: Record<string, string> = { A: "Surging Sparks", B: "Prismatic" };

const NAMES: MoverNames = {
  machine: (id) => (MACHINES[id] ? { name: MACHINES[id], code: `BL-00${id.slice(1)}` } : null),
  store: (id) => STORES[id] ?? null,
  title: (id) => TITLES[id] ?? null,
};

const CUR = input(
  [
    o("M1", "A", "2026-11-02", 30000),
    o("M2", "A", "2026-11-02", 20000),
    o("M2", "B", "2026-11-02", 5000),
  ],
  "2026-10-27",
  "2026-11-02",
);
const PREV = input(
  [o("M1", "A", "2026-10-20", 10000), o("M3", "B", "2026-10-20", 40000)],
  "2026-10-20",
  "2026-10-26",
);

describe("buildMovers", () => {
  it("rangordnar efter intäkt med förändring och placering mot förra perioden", () => {
    const m = buildMovers({
      current: CUR,
      previous: PREV,
      names: NAMES,
      hrefs: { machine: (code) => `/automater/${code}` },
    });
    const rows = m.machine.rows;
    expect(rows.map((r) => r.code)).toEqual(["BL-001", "BL-002"]);
    expect(rows[0]).toMatchObject({
      rank: 1,
      revenueOre: 30000,
      previousOre: 10000,
      changeBp: 20000,
      changeText: `+200${NBSP}%`,
      // Var tvåa (M3 sålde mer), nu etta.
      rankMove: 1,
      bar: 1,
      href: "/automater/BL-001",
    });
    expect(rows[1]).toMatchObject({ revenueOre: 25000, changeText: "Ny", rankMove: null });
    // Mest upp i kronor: M2 (+250 kr); mest ned: M3 som slutade sälja (−400 kr).
    expect(m.machine.up?.key).toBe("M2");
    expect(m.machine.down?.key).toBe("M3");
    expect(m.machine.down?.changeText).toBe(`−100${NBSP}%`);
    expect(m.machine.total).toBe(2);
  });

  it("butiker och titlar räknas på samma order", () => {
    const m = buildMovers({ current: CUR, previous: PREV, names: NAMES });
    expect(m.store.rows.map((r) => [r.name, r.revenueOre])).toEqual([
      ["Butik Ett", 30000],
      ["Butik Två", 25000],
    ]);
    expect(m.title.rows.map((r) => [r.name, r.changeText])).toEqual([
      ["Surging Sparks", `+400${NBSP}%`],
      ["Prismatic", `−88${NBSP}%`],
    ]);
  });

  it("utan jämförelseperiod: ingen förändring", () => {
    const m = buildMovers({ current: CUR, previous: null, names: NAMES });
    expect(m.machine.rows.every((r) => r.changeText === null && r.rankMove === null)).toBe(true);
    expect(m.machine.up).toBeNull();
    expect(moversSummary(m.machine)).toBeNull();
  });

  it('jämförelseperiod utan försäljning: som ingen jämförelse (inte allt "Ny")', () => {
    const m = buildMovers({
      current: CUR,
      previous: input([], "2026-10-20", "2026-10-26"),
      names: NAMES,
    });
    expect(m.machine.rows.map((r) => r.changeText)).toEqual([null, null]);
    expect(m.machine.up).toBeNull();
  });

  it(`visar högst ${MOVERS_TOP_N} rader`, () => {
    const many = input(
      Array.from({ length: 12 }, (_, i) => o("M1", `T${i}`, "2026-11-02", 1000 + i)),
      "2026-10-27",
      "2026-11-02",
    );
    const m = buildMovers({
      current: many,
      previous: null,
      names: { ...NAMES, title: (id) => id },
    });
    expect(m.title.rows).toHaveLength(MOVERS_TOP_N);
    expect(m.title.total).toBe(12);
    expect(m.title.rows[0]!.name).toBe("T11");
  });

  it("sammanfattningen säger mest upp och mest ned", () => {
    const m = buildMovers({ current: CUR, previous: PREV, names: NAMES });
    expect(moversSummary(m.machine)).toBe(
      `Mest upp: BL-002${NBSP}Ica Nära Ny. Mest ned: BL-003${NBSP}Coop −100${NBSP}%.`,
    );
  });
});

describe("changeText", () => {
  it("decimal under 10 %", () => {
    expect(changeText(450, 100)).toBe(`+4,5${NBSP}%`);
    expect(changeText(0, 100)).toBe(`±0${NBSP}%`);
    expect(changeText(null, 0)).toBe("Ny");
  });
});
