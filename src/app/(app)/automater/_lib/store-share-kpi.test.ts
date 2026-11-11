/**
 * Automater med butikens andel dragen ska också visa andelen, som Lönsamhet: med vald butik
 * butikens namn och villkor ("Centrum 10 % av försäljningen + hyra 300 kr/mån"), med
 * vyknappen "Butikernas andel". Andelen + vår del = vår vinst före andelen. Utan andel
 * (standard) finns inget sådant nyckeltal.
 */

import { describe, expect, it } from "vitest";

import type { AnalyticsOrder } from "@/analytics/todos";
import type { DomainInput, MasterData, StockSnapshot } from "@/server/data/core/types";

import { buildOverview, machineFigures, machineKpis, overviewKpis } from "./model";

const plain = (v: string | undefined) => (v ?? "").replace(/[  ]/g, " ");

let seq = 0;
function order(machineId: string, titleId: string, at: string, amountOre: number): AnalyticsOrder {
  seq += 1;
  return {
    id: `o${seq}`,
    externalId: String(seq),
    titleId,
    machineId,
    businessDate: at.slice(0, 10),
    amountOre,
    orderedAt: at,
  };
}

const master: MasterData = {
  titles: [{ id: "t1", name: "Black Bolt", series: null, mergedIntoId: null, archived: false }],
  machines: [
    {
      id: "m1",
      code: "BL-001",
      name: "Automat 1",
      serial: null,
      storeId: "s1",
      activeFrom: "2026-10-01",
      activeTo: null,
      isExample: false,
      archived: false,
    },
  ],
  stores: [
    {
      id: "s1",
      name: "Centrum",
      address: null,
      contactName: null,
      email: null,
      phone: null,
      isExample: false,
      archived: false,
    },
  ],
  placements: [{ id: "p1", machineId: "m1", storeId: "s1", from: "2026-10-01", to: null }],
};

const prices = [{ titleId: "t1", unitCostOre: 10_000, validFrom: "2026-01-01" }];
const agreements = [
  {
    storeId: "s1",
    validFrom: "2026-01-01",
    validTo: null,
    commissionBp: 1000,
    monthlyRentOre: 30_000,
  },
];

function input(deductStoreShare: boolean, storeId: string | null): DomainInput {
  const settings = { vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1, deductStoreShare };
  const period = { start: "2026-10-13", end: "2026-10-26" };
  const orders = [
    order("m1", "t1", "2026-10-14T10:00:00Z", 20_000),
    order("m1", "t1", "2026-10-15T10:00:00Z", 20_000),
  ];
  const sources = { prices, agreements, placements: master.placements, settings };
  return {
    ...master,
    period,
    compare: null,
    scope: { storeId, machineId: null },
    current: { ...sources, orders, period },
    previous: null,
    sources,
    investments: [],
    settings,
    diagnostics: { ordersWithoutTitle: 0, ordersWithoutMachine: 0 },
  };
}

const stock: StockSnapshot = { rows: [], machineStock: [], warehouse: [] };

function overview(deduct: boolean, storeId: string | null) {
  return buildOverview({
    input: input(deduct, storeId),
    master,
    stock,
    signals: { refill: new Map(), health: new Map(), stake: new Map() },
    lastOrderAt: new Map(),
    today: "2026-11-02",
    scope: { storeId, machineId: null },
    coverage: { start: "2026-10-13", end: "2026-10-26" },
    pendingToday: false,
    query: "",
  });
}

describe("Automater: butikens andel som eget nyckeltal", () => {
  it("vald butik: andelen med butikens namn och villkor, andel + vår del = vinsten före", () => {
    const on = overview(true, "s1");
    const off = overview(false, null);
    const k = overviewKpis(on.totals);
    const share = k.find((x) => x.id === "store-share");
    expect(plain(share?.label)).toBe("Centrum 10 % av försäljningen + hyra 300 kr/mån");
    expect(k.find((x) => x.id === "profit")?.label).toBe("Vår del");
    expect(share!.value + on.totals.profitOre).toBe(off.totals.profitOre);
    expect(share!.value).toBeGreaterThan(0);
  });

  it("vyknappen utan vald butik: 'Butikernas andel'", () => {
    const k = overviewKpis(overview(true, null).totals);
    expect(k.find((x) => x.id === "store-share")?.label).toBe("Butikernas andel");
  });

  it("standard (av): inget andelsnyckeltal, Vår vinst", () => {
    const k = overviewKpis(overview(false, null).totals);
    expect(k.find((x) => x.id === "store-share")).toBeUndefined();
    expect(k.find((x) => x.id === "profit")?.label).toBe("Vår vinst");
  });

  it("automatens sida med knappen: andelen till automatens butik bredvid vår del", () => {
    const on = machineFigures(input(true, null).current, "m1");
    const off = machineFigures(input(false, null).current, "m1");
    const k = machineKpis(on, null, [], "Centrum 10 % av försäljningen");
    const share = k.find((x) => x.id === "store-share");
    expect(share?.label).toBe("Centrum 10 % av försäljningen");
    expect(share!.value + on.profitOre).toBe(off.profitOre);
    expect(machineKpis(off, null, []).find((x) => x.id === "store-share")).toBeUndefined();
  });
});
