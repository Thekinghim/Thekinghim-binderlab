import { describe, expect, it } from "vitest";

import { forecastSales } from "@/analytics/forecast";
import type { StockEventRef } from "@/analytics/lost-sales";
import { addDays, type IsoDate, type OrderLine } from "@/domain";

import { retiredSeries, seriesStartsFromStock } from "./series-start";

const NO_TAX = { vatRateBp: 0, cardFeeBp: 0 };
const AS_OF: IsoDate = "2026-11-01";

function ev(
  id: string,
  machineId: string,
  titleId: string,
  kind: StockEventRef["kind"],
  quantity: number,
  businessDate: IsoDate,
): StockEventRef {
  return { id, locationId: `loc-${machineId}`, machineId, titleId, kind, quantity, businessDate };
}

function ord(id: string, titleId: string, machineId: string, businessDate: IsoDate): OrderLine {
  return { id, externalId: id, titleId, machineId, businessDate, amountOre: 7_900 };
}

describe("seriesStartsFromStock", () => {
  it("börjar vid första kända saldo över 0 (inventering eller påfyllning)", () => {
    const starts = seriesStartsFromStock(
      [
        // Inventerad till 5 den 12 okt.
        ev("a1", "m-1", "t-wf", "count", 5, "2026-10-12"),
        ev("a2", "m-1", "t-wf", "sale", -1, "2026-10-31"),
        // Försäljning med okänt saldo först, påfylld den 20 okt.
        ev("b1", "m-2", "t-x", "sale", -1, "2026-10-01"),
        ev("b2", "m-2", "t-x", "refill", 10, "2026-10-20"),
        // Inventerad till 0, påfylld först den 25 okt.
        ev("c1", "m-3", "t-y", "count", 0, "2026-10-01"),
        ev("c2", "m-3", "t-y", "refill", 6, "2026-10-25"),
      ],
      AS_OF,
    );
    const by = new Map(starts.map((s) => [`${s.machineId}:${s.titleId}`, s.date]));
    expect(by.get("m-1:t-wf")).toBe("2026-10-12");
    expect(by.get("m-2:t-x")).toBe("2026-10-20");
    expect(by.get("m-3:t-y")).toBe("2026-10-25");
  });

  it("flyttar en start före första orderdatan fram till den", () => {
    const starts = seriesStartsFromStock(
      [ev("a1", "m-1", "t-wf", "count", 5, "2026-10-12")],
      AS_OF,
      "2026-10-13",
    );
    expect(starts).toEqual([{ machineId: "m-1", titleId: "t-wf", date: "2026-10-13" }]);
  });

  it("ger ingen start för centrallagret eller ett saldo som aldrig varit över 0", () => {
    const starts = seriesStartsFromStock(
      [
        { ...ev("w", "m-9", "t-z", "receipt", 24, "2026-10-01"), machineId: null },
        ev("z", "m-4", "t-z", "count", 0, "2026-10-01"),
      ],
      AS_OF,
    );
    expect(starts).toEqual([]);
  });
});

describe("prognosen med seriens start ur lagret", () => {
  // White Flair i BL-003: inventerad till 5 den 12 okt, 0 sålda i 19 dagar, 2 sålda 31 okt.
  const orders = [ord("o1", "t-wf", "m-3", "2026-10-31"), ord("o2", "t-wf", "m-3", "2026-10-31")];
  const events = [ev("c", "m-3", "t-wf", "count", 5, "2026-10-12")];

  it("utan lagret räknas bara dagarna från första försäljningen: kraftig överskattning", () => {
    const f = forecastSales({ orders, asOf: AS_OF, settings: NO_TAX });
    const s = f.series[0]!;
    expect(s.startSource).toBe("first-sale");
    expect(s.total.unitsMilli).toBeGreaterThan(20_000);
  });

  it("med lagret räknas de osålda dagarna som efterfrågan 0", () => {
    const f = forecastSales({
      orders,
      asOf: AS_OF,
      settings: NO_TAX,
      seriesStarts: seriesStartsFromStock(events, AS_OF),
    });
    const s = f.series[0]!;
    expect(s.startSource).toBe("stock");
    expect(s.startDate).toBe("2026-10-12");
    // Veckorna 12–18 okt (vikt 6), 19–25 okt (vikt 7), 26 okt–1 nov (vikt 8, 2 sålda):
    // nivå = 8 × 2 / (6 × 7 + 7 × 7 + 8 × 7) = 16 / 147 ≈ 0,109 pack/dag → ca 3 pack på 28 dagar.
    expect(s.components.levelMilli).toBe(109);
    expect(s.total.unitsMilli).toBeGreaterThan(2_500);
    expect(s.total.unitsMilli).toBeLessThan(3_500);
    expect(s.components.availableDays).toBe(21);
    expect(s.evidence.figures.some((x) => x.key === "daysBeforeFirstSale")).toBe(true);
  });

  it("en start efter första försäljningen ignoreras", () => {
    const f = forecastSales({
      orders,
      asOf: AS_OF,
      settings: NO_TAX,
      seriesStarts: [{ machineId: "m-3", titleId: "t-wf", date: "2026-11-01" }],
    });
    expect(f.series[0]!.startSource).toBe("first-sale");
    expect(f.series[0]!.startDate).toBe("2026-10-31");
  });
});

describe("nivåns osäkerhet i intervallet", () => {
  const start = addDays(AS_OF, -97);
  const many: OrderLine[] = [];
  for (let d = 0; d < 98; d++) many.push(ord(`m${d}`, "t-a", "m-1", addDays(start, d)));
  const few: OrderLine[] = [
    ord("f1", "t-b", "m-1", addDays(AS_OF, -4)),
    ord("f2", "t-b", "m-1", addDays(AS_OF, -2)),
    ord("f3", "t-b", "m-1", AS_OF),
  ];

  it("vidgar intervallet, mest när nivån skattats på få dagar", () => {
    const off = forecastSales({ orders: [...many, ...few], asOf: AS_OF, settings: NO_TAX });
    const on = forecastSales({
      orders: [...many, ...few],
      asOf: AS_OF,
      settings: NO_TAX,
      options: { levelUncertainty: true },
    });
    const width = (r: typeof off, title: string) => {
      const s = r.series.find((x) => x.titleId === title)!;
      return s.total.unitsHighMilli - s.total.unitsLowMilli;
    };
    // Mittvärdet är detsamma; bara intervallet ändras.
    expect(on.total.total.unitsMilli).toBe(off.total.total.unitsMilli);
    expect(off.series.every((s) => s.levelVarianceMilli2 === 0)).toBe(true);
    const longRatio = width(on, "t-a") / width(off, "t-a");
    const shortRatio = width(on, "t-b") / width(off, "t-b");
    expect(longRatio).toBeGreaterThan(1);
    expect(shortRatio).toBeGreaterThan(longRatio);
    // 5 dagar med data och 28 dagars summa: varians × (1 + 28/5) ≈ 6,6 → bredd × ca 2,6.
    expect(shortRatio).toBeGreaterThan(2.3);
  });
});

describe("retiredSeries: titlar som gått ur automaten får ingen prognos", () => {
  it("bara par utan gällande period i dag", () => {
    const periods = [
      { machineId: "m1", titleId: "bolt", validFrom: "2026-10-14", validTo: "2026-11-02" },
      { machineId: "m1", titleId: "30th", validFrom: "2026-10-14", validTo: null },
      { machineId: "m1", titleId: "flair", validFrom: "2026-10-14", validTo: "2026-10-30" },
      { machineId: "m1", titleId: "flair", validFrom: "2026-11-10", validTo: null },
    ] as const;
    expect(retiredSeries(periods, "2026-11-04")).toEqual([{ machineId: "m1", titleId: "bolt" }]);
  });
});
