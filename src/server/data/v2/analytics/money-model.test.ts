import { describe, expect, it } from "vitest";

import {
  axisKr,
  chartScale,
  goalShortOre,
  monthTable,
  monthTableCsv,
  NO_CITY,
  pickMoneyGoal,
  profitBars,
  profitByCity,
  topTitles,
  waterfallRows,
  weeklyUnits,
} from "./money-model";

describe("waterfallRows", () => {
  const base = {
    revenueOre: 100_000,
    vmbVatOre: null,
    costOre: 50_000,
    feesOre: 4_000,
    profitBeforeShareOre: 46_000,
    compensationOre: 20_000,
    refundOre: 0,
    freePackOre: 0,
    fixedCostOre: 6_000,
    cardFeeBp: 400,
    stores: 3,
  };

  it("går från intäkt till det som blir kvar, steg för steg", () => {
    const rows = waterfallRows(base);
    expect(rows.map((r) => r.key)).toEqual([
      "revenue",
      "cost",
      "fees",
      "profit",
      "share",
      "fixed",
      "result",
    ]);
    expect(rows.find((r) => r.key === "profit")!.valueOre).toBe(46_000);
    expect(rows.at(-1)!.valueOre).toBe(46_000 - 20_000 - 6_000);
    expect(rows.find((r) => r.key === "fees")!.label).toBe("Kortavgift 4 %");
    // Kostnaderna är negativa och andelen av intäkten absolut.
    expect(rows.find((r) => r.key === "cost")!.valueOre).toBe(-50_000);
    expect(rows.find((r) => r.key === "cost")!.shareBp).toBe(5_000);
  });

  it("ritar varje kostnad där den förra slutade", () => {
    const rows = waterfallRows(base);
    const cost = rows.find((r) => r.key === "cost")!;
    expect(cost.from).toBeCloseTo(0.5);
    expect(cost.to).toBeCloseTo(1);
    const fees = rows.find((r) => r.key === "fees")!;
    expect(fees.from).toBeCloseTo(0.46);
    expect(fees.to).toBeCloseTo(0.5);
  });

  it("tar med VMB, återbetalningar och gratis-pack bara när de finns", () => {
    const rows = waterfallRows({ ...base, vmbVatOre: 1_000, refundOre: 500, freePackOre: 0 });
    expect(rows.map((r) => r.key)).toContain("vmb");
    expect(rows.map((r) => r.key)).toContain("refunds");
    expect(rows.map((r) => r.key)).not.toContain("free");
  });

  it("utan fasta kostnader (butiksfilter) slutar den efter andelen", () => {
    const rows = waterfallRows({ ...base, fixedCostOre: null });
    expect(rows.map((r) => r.key)).not.toContain("fixed");
    expect(rows.at(-1)!.valueOre).toBe(26_000);
    expect(rows.at(-1)!.sub).toBe("Efter butikernas andel");
  });

  it("klarar noll intäkt", () => {
    const rows = waterfallRows({
      ...base,
      revenueOre: 0,
      costOre: 0,
      feesOre: 0,
      profitBeforeShareOre: 0,
      compensationOre: 0,
      fixedCostOre: 0,
    });
    expect(rows.every((r) => r.from === 0 && r.to === 0)).toBe(true);
    expect(rows[0]!.shareBp).toBeNull();
  });
});

describe("profitBars", () => {
  it("ger den pågående veckan takten och en delvis vecka sina dagar", () => {
    const bars = profitBars(
      [
        {
          key: "w1",
          axis: "V45",
          start: "2026-11-05",
          end: "2026-11-08",
          partial: true,
          profitOre: 400,
        },
        {
          key: "w2",
          axis: "V46",
          start: "2026-11-09",
          end: "2026-11-15",
          partial: false,
          profitOre: 700,
        },
        {
          key: "w3",
          axis: "V47",
          start: "2026-11-16",
          end: "2026-11-21",
          partial: true,
          profitOre: 600,
        },
      ],
      "week",
      "2026-11-21",
    );
    expect(bars.map((b) => b.label)).toEqual(["v. 45", "v. 46", "v. 47"]);
    expect(bars[0]!.partial).toBe(false);
    expect(bars[0]!.partialText).toBe("4 av 7 d");
    expect(bars[0]!.paceOre).toBeNull();
    expect(bars[2]!.partial).toBe(true);
    expect(bars[2]!.partialText).toBe("6 av 7 d");
    expect(bars[2]!.paceOre).toBe(700);
  });
});

describe("chartScale och axisKr", () => {
  it("ger jämna steg med lite luft över det högsta värdet", () => {
    // 36 000 kr → 0 / 10k / 20k / 30k / 40k (prototypen: 0/20k/40k med halva steg).
    expect(chartScale(3_600_000)).toEqual({
      topOre: 4_000_000,
      ticks: [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000],
    });
    // 40 688 kr: 25k-steg ger toppen 50k i stället för 60k.
    expect(chartScale(4_068_800).ticks).toEqual([0, 2_500_000, 5_000_000]);
    expect(chartScale(900_000).ticks).toEqual([0, 250_000, 500_000, 750_000, 1_000_000]);
    expect(chartScale(130_000).ticks.at(-1)).toBeGreaterThanOrEqual(143_000);
    expect(chartScale(0)).toEqual({ topOre: 100, ticks: [0, 100] });
    expect(chartScale(-5_000)).toEqual({ topOre: 100, ticks: [0, 100] });
  });

  it("toppen rymmer alltid värdet och stegen är hela kronor", () => {
    for (const v of [1, 99, 12_345, 777_777, 9_999_999, 123_456_789]) {
      const s = chartScale(v);
      expect(s.topOre).toBeGreaterThanOrEqual(v);
      expect(s.ticks[0]).toBe(0);
      expect(s.ticks.length).toBeLessThanOrEqual(5);
      for (const t of s.ticks) expect(t % 100).toBe(0);
    }
  });

  it("skriver kronor i sin helhet under 10 000, annars med k", () => {
    expect(axisKr(0)).toBe("0");
    expect(axisKr(200_000).replace(/\s/g, " ")).toBe("2 000");
    expect(axisKr(2_000_000)).toBe("20k");
    expect(axisKr(2_500_000)).toBe("25k");
  });
});

describe("profitByCity", () => {
  it("grupperar per stad, sorterar på vinst per automat och jämför bara jämförbara", () => {
    const cities = profitByCity([
      {
        machineId: "a",
        code: "A",
        name: "A",
        city: "Borås",
        profitOre: 300,
        previousProfitOre: 200,
      },
      {
        machineId: "b",
        code: "B",
        name: "B",
        city: "Borås",
        profitOre: 100,
        previousProfitOre: null,
      },
      {
        machineId: "c",
        code: "C",
        name: "C",
        city: "Lerum",
        profitOre: 500,
        previousProfitOre: 500,
      },
      { machineId: "d", code: "D", name: "D", city: null, profitOre: 900, previousProfitOre: null },
    ]);
    expect(cities.map((c) => c.city)).toEqual(["Lerum", "Borås", NO_CITY]);
    const boras = cities[1]!;
    expect(boras.totalOre).toBe(400);
    expect(boras.perMachineOre).toBe(200);
    expect(boras.deltaBp).toBe(5_000);
    expect(boras.items[0]!.machineId).toBe("a");
    expect(cities[2]!.deltaBp).toBeNull();
  });
});

describe("topTitles och weeklyUnits", () => {
  it("tar de med mest vinst med andel och förändring", () => {
    const top = topTitles(
      [
        { titleId: "x", name: "X", orders: 10, revenueOre: 1000, profitOre: 300 },
        { titleId: "y", name: "Y", orders: 5, revenueOre: 900, profitOre: 700 },
        { titleId: "z", name: "Z", orders: 0, revenueOre: 0, profitOre: 0 },
      ],
      new Map([["y", 350]]),
      new Map([["y", [1, 2]]]),
      5,
    );
    expect(top.map((t) => t.titleId)).toEqual(["y", "x"]);
    expect(top[0]!.shareBp).toBe(7_000);
    expect(top[0]!.deltaBp).toBe(10_000);
    expect(top[0]!.weekly).toEqual([1, 2]);
    expect(top[1]!.deltaBp).toBeNull();
  });

  it("räknar pack per vecka måndag–söndag", () => {
    // 2026-11-21 är en lördag; veckan börjar måndag 16 nov.
    const w = weeklyUnits(
      [
        { titleId: "t", businessDate: "2026-11-16" },
        { titleId: "t", businessDate: "2026-11-21" },
        { titleId: "t", businessDate: "2026-11-15" },
        { titleId: "t", businessDate: "2026-09-01" },
        { titleId: null, businessDate: "2026-11-20" },
      ],
      "2026-11-21",
      2,
    );
    expect(w.get("t")).toEqual([1, 2]);
  });
});

describe("monthTable", () => {
  const machines = [
    { id: "m1", code: "BL-1", name: "Ett" },
    { id: "m2", code: "BL-2", name: "Två" },
    { id: "m3", code: "BL-3", name: "Ny utan data" },
  ];
  const table = monthTable(
    [
      {
        month: "2026-10",
        start: "2026-10-01",
        end: "2026-10-31",
        running: false,
        rows: [
          { machineId: "m1", profitOre: 31_000, activeDays: 31 },
          { machineId: "m2", profitOre: 20_000, activeDays: 10 },
        ],
      },
      {
        month: "2026-11",
        start: "2026-11-01",
        end: "2026-11-10",
        running: true,
        rows: [
          { machineId: "m1", profitOre: 5_000, activeDays: 10 },
          { machineId: "m2", profitOre: 0, activeDays: 0 },
        ],
      },
    ],
    machines,
  );

  it("delar vinsten med dagarna i tjänst och sorterar på senaste hela månaden", () => {
    expect(table.rows.map((r) => r.machineId)).toEqual(["m2", "m1"]);
    expect(table.rows[0]!.values).toEqual([2_000, null]);
    expect(table.rows[1]!.values).toEqual([1_000, 500]);
    expect(table.rows[1]!.averageOre).toBe(Math.round(36_000 / 41));
  });

  it("Alla har samma enhet som raderna: vinst per automat och dag i tjänst", () => {
    // Okt: (31 000 + 20 000) ÷ (31 + 10) dagar; nov: 5 000 ÷ 10 (m2 har 0 dagar, 0 kr).
    expect(table.totals).toEqual([Math.round(51_000 / 41), 500]);
    expect(table.totalAverageOre).toBe(Math.round(56_000 / 51));
    expect(table.maxOre).toBe(2_000);
  });

  it("Alla tar med automater utan dagar i tjänst (vinsten räknas, dagarna är 0)", () => {
    const t = monthTable(
      [
        {
          month: "2026-11",
          start: "2026-11-01",
          end: "2026-11-10",
          running: true,
          rows: [
            { machineId: "m1", profitOre: 5_000, activeDays: 10 },
            { machineId: "m2", profitOre: -1_000, activeDays: 0 },
          ],
        },
      ],
      machines,
    );
    expect(t.totals).toEqual([400]);
    expect(t.totalAverageOre).toBe(400);
    // m2 syns som rad (utan värde) så att "Alla" går att följa; m3 utan något alls syns inte.
    expect(t.rows.map((r) => r.machineId)).toEqual(["m1", "m2"]);
    expect(t.rows[1]!.values).toEqual([null]);
    expect(t.rows[1]!.averageOre).toBeNull();
  });

  it("CSV med semikolon, decimalkomma och BOM", () => {
    const csv = monthTableCsv(table);
    expect(csv.startsWith("﻿Kod;Automat;2026-10;2026-11;Snitt\r\n")).toBe(true);
    expect(csv).toContain("BL-2;Två;20,00;;20,00");
    expect(csv).toContain(";Alla;12,44;5,00;10,98");
  });

  it("CSV skyddar mot formler i automatens namn", () => {
    const evil = {
      ...table,
      rows: table.rows.map((r) => ({ ...r, name: '=HYPERLINK("http://example.invalid","x")' })),
    };
    const csv = monthTableCsv(evil);
    expect(csv).not.toContain(';"=HYPERLINK');
    expect(csv).toContain(`;"'=HYPERLINK(""http://example.invalid"",""x"")";`);
  });
});

describe("mål", () => {
  it("väljer organisationens vinstmål och räknar vad som saknas", () => {
    const goal = pickMoneyGoal([
      {
        id: "1",
        metric: "revenue",
        scopeName: null,
        unit: "ore",
        actual: 1,
        target: 2,
        forecast: 2,
      },
      {
        id: "2",
        metric: "profit",
        scopeName: "Butik",
        unit: "ore",
        actual: 1,
        target: 2,
        forecast: 2,
      },
      {
        id: "3",
        metric: "profit",
        scopeName: null,
        unit: "ore",
        actual: 5,
        target: 10,
        forecast: 8,
      },
    ]);
    expect(goal?.id).toBe("3");
    expect(goalShortOre(goal!)).toBe(2);
    expect(goalShortOre({ target: 10, forecast: 12 })).toBe(0);
    expect(pickMoneyGoal([])).toBeNull();
  });
});
