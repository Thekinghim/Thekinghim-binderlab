import { describe, expect, it } from "vitest";

import type { MasterData, SalesCountRow, StockRow } from "@/server/data/core/types";

import { codeText, daysLeftText, historyQuantity, relativeDay, tenthsText } from "./display";
import { headlineOf } from "./headline";
import { buildLagerModel, salesAsOrders } from "./model";
import type { LagerView } from "./types";

const M1 = "00000000-0000-4000-8000-000000000001";
const M2 = "00000000-0000-4000-8000-000000000002";
const T1 = "00000000-0000-4000-8000-0000000000a1";
const T2 = "00000000-0000-4000-8000-0000000000a2";
const T3 = "00000000-0000-4000-8000-0000000000a3";
const S1 = "00000000-0000-4000-8000-0000000000b1";
const S2 = "00000000-0000-4000-8000-0000000000b2";

// Måndag 2 nov. 2026, 10:00 svensk tid. Fönstret är 19 okt.–1 nov. (14 dagar).
const NOW = new Date("2026-11-02T09:00:00Z");
const TODAY = "2026-11-02";

const master: MasterData = {
  titles: [
    { id: T1, name: "Black Bolt", series: null, mergedIntoId: null, archived: false },
    { id: T2, name: "Surging Sparks", series: null, mergedIntoId: null, archived: false },
    { id: T3, name: "Gammal titel", series: null, mergedIntoId: null, archived: false },
  ],
  machines: [
    {
      id: M1,
      name: "Automat 1",
      code: "BL-001",
      serial: null,
      storeId: S1,
      isExample: false,
      archived: false,
      activeFrom: "2026-10-01",
      activeTo: null,
    },
    {
      id: M2,
      name: "Automat 2",
      code: "BL-002",
      serial: null,
      storeId: S2,
      isExample: false,
      archived: false,
      activeFrom: "2026-10-01",
      activeTo: null,
    },
  ],
  stores: [
    {
      id: S1,
      name: "Butik 1",
      address: null,
      contactName: null,
      email: null,
      phone: null,
      isExample: false,
      archived: false,
    },
    {
      id: S2,
      name: "Butik 2",
      address: null,
      contactName: null,
      email: null,
      phone: null,
      isExample: false,
      archived: false,
    },
  ],
  placements: [
    { id: "p1", machineId: M1, storeId: S1, from: "2026-10-01", to: null },
    { id: "p2", machineId: M2, storeId: S2, from: "2026-10-01", to: null },
  ],
};

function row(
  machineId: string | null,
  titleId: string,
  onHand: number,
  extra: Partial<StockRow> = {},
): StockRow {
  return {
    locationId: machineId ? `loc-${machineId}` : "loc-central",
    locationName: machineId ? "Automat" : "Centrallager",
    locationKind: machineId ? "machine" : "warehouse",
    isCentral: machineId === null,
    machineId,
    titleId,
    onHand,
    lastCountedAt: null,
    lastEventAt: "2026-10-30T08:00:00.000Z",
    lastRestockedAt: "2026-10-30T08:00:00.000Z",
    ...extra,
  };
}

/** `perDay` pack varje dag i fönstret (19 okt.–1 nov.). */
function daily(machineId: string, titleId: string, perDay: number): SalesCountRow[] {
  const out: SalesCountRow[] = [];
  for (let d = 19; d <= 31; d++)
    out.push({ date: `2026-10-${d}`, titleId, machineId, units: perDay });
  out.push({ date: "2026-11-01", titleId, machineId, units: perDay });
  return out;
}

const stock: StockRow[] = [
  row(M1, T1, 0), // slut, säljer 2/dag → Kritisk
  row(M1, T2, 4), // 4 kvar, 2/dag → räcker 2 dagar → Låg
  row(M2, T1, 30), // 30 kvar, 1/dag → OK
  row(M2, T3, 0, { lastEventAt: "2026-08-01T08:00:00.000Z" }), // gammal rad, ingen försäljning
  row(null, T1, 10),
  row(null, T2, 0),
];
const sales: SalesCountRow[] = [...daily(M1, T1, 2), ...daily(M1, T2, 2), ...daily(M2, T1, 1)];

function build(scope = { storeId: null as string | null, machineId: null as string | null }) {
  return buildLagerModel({
    now: NOW,
    timeZone: "Europe/Stockholm",
    today: TODAY,
    master,
    stock,
    sales,
    scope,
    hasCentral: true,
  });
}

function cellOf(model: ReturnType<typeof build>, machineId: string, titleId: string) {
  const i = model.titles.findIndex((t) => t.id === titleId);
  const j = model.machines.findIndex((m) => m.id === machineId);
  return model.cells[i]?.[j];
}

describe("salesAsOrders", () => {
  it("gör en order per sålt pack, utan belopp", () => {
    const orders = salesAsOrders([{ date: "2026-11-01", titleId: T1, machineId: M1, units: 3 }]);
    expect(orders).toHaveLength(3);
    expect(new Set(orders.map((o) => o.id)).size).toBe(3);
    expect(orders.every((o) => o.amountOre === 0)).toBe(true);
  });
});

describe("buildLagerModel", () => {
  it("räknar fönstret t.o.m. i går och gränsen för Låg som Att göra", () => {
    const model = build();
    expect(model.window).toEqual({ start: "2026-10-19", end: "2026-11-01", days: 14 });
    expect(model.lowThresholdTenths).toBe(25);
  });

  it("sätter Kritisk för tomt fack, Låg under 2,5 dagar och OK annars", () => {
    const model = build();
    expect(cellOf(model, M1, T1)).toMatchObject({
      stocked: true,
      onHand: 0,
      status: "critical",
      daysLeft: 0,
      perDayTenths: 20,
    });
    expect(cellOf(model, M1, T2)).toMatchObject({
      onHand: 4,
      status: "low",
      daysLeft: 2,
      stockoutDate: "2026-11-03",
    });
    expect(cellOf(model, M2, T1)).toMatchObject({ onHand: 30, status: "ok", daysLeft: 30 });
    expect(model.counts).toEqual({ critical: 1, low: 1, ok: 1 });
  });

  it("visar inte titlar som varken finns i automaterna eller säljer", () => {
    const model = build();
    expect(model.titles.map((t) => t.id)).not.toContain(T3);
    expect(cellOf(model, M2, T2)).toMatchObject({ stocked: false });
    // Värst först: Black Bolt (kritisk) före Surging Sparks (låg).
    expect(model.titles.map((t) => t.name)).toEqual(["Black Bolt", "Surging Sparks"]);
  });

  it("ger en påfyllningslista per automat ur besöksplanen, begränsad av centrallagret", () => {
    const model = build();
    const list = model.packLists.find((p) => p.machineId === M1);
    // Mål = 7 dagars försäljning, takten över 14 dagar t.o.m. i dag (26 pack → tak(26 × 7 / 14) = 13).
    // Black Bolt: 0 i automaten, 10 i centrallagret → 10 med, 3 saknas.
    const bolt = list?.lines.find((l) => l.titleId === T1);
    expect(bolt).toMatchObject({ target: 13, quantity: 10, shortBy: 3 });
    // Surging Sparks: centrallagret är tomt.
    const sparks = list?.lines.find((l) => l.titleId === T2);
    expect(sparks).toMatchObject({ quantity: 0, shortBy: sparks!.target - sparks!.onHand });
    expect(list?.totalPacks).toBe(10);
    expect(list?.needBy).not.toBeNull();
    expect(cellOf(model, M1, T1)?.suggested).toBe(10);
  });

  it("markerar centrallagret när veckans besök inte kan fyllas", () => {
    const model = build();
    const sparks = model.warehouse.find((w) => w.titleId === T2);
    expect(sparks).toMatchObject({ onHand: 0, status: "critical" });
    expect(sparks!.shortBy).toBeGreaterThan(0);
    const bolt = model.warehouse.find((w) => w.titleId === T1);
    expect(bolt).toMatchObject({ onHand: 10, status: "low", perDayTenths: 30 });
  });

  it("filtrerar automaterna på butik och automat", () => {
    expect(build({ storeId: S2, machineId: null }).machines.map((m) => m.code)).toEqual(["BL-002"]);
    expect(build({ storeId: null, machineId: M1 }).machines.map((m) => m.code)).toEqual(["BL-001"]);
  });

  it("innehåller inga belopp", () => {
    const json = JSON.stringify(build());
    expect(json).not.toMatch(/[a-z]Ore"|amount|price|\bkr\b|revenue|profit/i);
  });
});

describe("headlineOf", () => {
  it("svarar med antal kritiska och låga och det mest brådskande", () => {
    const model = build();
    const view: LagerView = {
      ...model,
      today: TODAY,
      now: NOW.toISOString(),
      timeZone: "Europe/Stockholm",
      history: [],
      historyTotal: 0,
      canRegister: true,
    };
    const h = headlineOf(view);
    expect(h.title).toBe("1 fack kritiskt, 1 lågt.");
    expect(h.aside).toContain(`Black Bolt i ${codeText("BL-001")} är slut.`);
    expect(h.aside).toContain("10 pack ut till 1 automat i dag.");
  });
});

describe("display", () => {
  it("formaterar dagar kvar, antal och tiondelar", () => {
    expect(daysLeftText({ onHand: 0, daysLeft: 0 })).toBe("slut");
    expect(daysLeftText({ onHand: 2, daysLeft: 0 })).toBe("< 1 d");
    expect(daysLeftText({ onHand: 2, daysLeft: null })).toBe("–");
    expect(daysLeftText({ onHand: 9, daysLeft: 4 })).toBe("4 d");
    expect(historyQuantity("refill", 12)).toBe("+12 st");
    expect(historyQuantity("adjustment", -3)).toBe("−3 st");
    expect(historyQuantity("count", 17)).toBe("17 st");
    expect(tenthsText(25)).toBe("2,5");
    expect(codeText("BL-002")).toBe("BL‑002");
    expect(relativeDay("2026-11-02", "2026-11-02")).toBe("i dag");
    expect(relativeDay("2026-11-03", "2026-11-02")).toBe("i morgon");
  });
});
