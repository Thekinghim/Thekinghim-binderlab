import { describe, expect, it } from "vitest";

import type { MasterData, SalesCountRow, StockRow } from "@/server/data/core/types";

import { businessDateAt } from "@/analytics/todos/time";
import { NBSP } from "@/lib/format";

import {
  codeText,
  daysLeftText,
  historyQuantity,
  relativeDay,
  statusTone,
  tenthsText,
} from "./display";
import {
  headlineOf,
  machineList,
  packListAside,
  visitsText,
  visitsToday,
  visitsTodayShort,
} from "./headline";
import { buildLagerModel, planNow, retiredPairs, salesAsOrders, warehouseStatus } from "./model";
import type { LagerView, PackList } from "./types";

const M1 = "00000000-0000-4000-8000-000000000001";
const M2 = "00000000-0000-4000-8000-000000000002";
const T1 = "00000000-0000-4000-8000-0000000000a1";
const T2 = "00000000-0000-4000-8000-0000000000a2";
const T3 = "00000000-0000-4000-8000-0000000000a3";
const T4 = "00000000-0000-4000-8000-0000000000a4";
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
    { id: T4, name: "Aldrig i lager", series: null, mergedIntoId: null, archived: false },
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
  row(M2, T3, 0, { lastEventAt: "2026-08-01T08:00:00.000Z" }), // tom sedan augusti → Kritisk
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

describe("buildLagerModel: larmgräns", () => {
  const withAlerts = (alertAtUnits: number) =>
    buildLagerModel({
      now: NOW,
      timeZone: "Europe/Stockholm",
      today: TODAY,
      master,
      stock,
      sales,
      scope: { storeId: null, machineId: null },
      hasCentral: true,
      slotAlerts: [{ machineId: M2, titleId: T1, alertAtUnits }],
    });

  it("saldo högst gränsen gör en OK-cell Låg och räknas i rubriken", () => {
    const base = build();
    expect(cellOf(base, M2, T1)).toMatchObject({ status: "ok", alertAt: null });
    const model = withAlerts(30);
    expect(cellOf(model, M2, T1)).toMatchObject({ status: "low", alertAt: 30 });
    expect(model.counts.low).toBe(base.counts.low + 1);
    expect(model.counts.ok).toBe(base.counts.ok - 1);
  });

  it("över gränsen ändrar ingenting utom alertAt", () => {
    const model = withAlerts(29);
    expect(cellOf(model, M2, T1)).toMatchObject({ status: "ok", alertAt: 29 });
    expect(model.counts).toEqual(build().counts);
  });
});

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

  it("sätter Kritisk för tom plats, Låg under 2,5 dagar och OK annars", () => {
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
    expect(model.counts).toEqual({ critical: 2, low: 1, ok: 1 });
  });

  it("räknar en plats som varit tom länge som lagerförd och Kritisk", () => {
    // Saldoraden finns (0 pack), ingen försäljning i fönstret och senaste händelsen i augusti.
    const cell = cellOf(build(), M2, T3);
    expect(cell).toMatchObject({ stocked: true, onHand: 0, status: "critical", daysLeft: null });
    expect(daysLeftText(cell!)).toBe("slut");
  });

  it("visar inte titlar som varken finns i automaterna eller säljer", () => {
    const model = build();
    expect(model.titles.map((t) => t.id)).not.toContain(T4);
    expect(cellOf(model, M2, T2)).toMatchObject({ stocked: false });
    // Värst först: de kritiska (Black Bolt, Gammal titel) före Surging Sparks (låg).
    expect(model.titles.map((t) => t.name)).toEqual([
      "Black Bolt",
      "Gammal titel",
      "Surging Sparks",
    ]);
  });

  it("ger en påfyllningslista per automat ur besöksplanen, begränsad av centrallagret", () => {
    const model = build();
    const list = model.packLists.find((p) => p.machineId === M1)!;
    // Takten är densamma som i matrisen: 28 pack på 14 dagar t.o.m. i går → mål tak(28 × 7 / 14) = 14.
    // Black Bolt: 0 i automaten, 10 i centrallagret → 10 med, 4 saknas.
    expect(list.lines).toEqual([
      expect.objectContaining({ titleId: T1, target: 14, quantity: 10, shortBy: 4 }),
    ]);
    // Surging Sparks finns inte i centrallagret: ingen rad med 0, i stället under missing.
    expect(list.missing).toEqual([
      expect.objectContaining({ titleId: T2, onHand: 4, target: 14, shortBy: 10 }),
    ]);
    expect(list.totalPacks).toBe(10);
    expect(list.shortBy).toBe(14);
    expect(list.needBy).not.toBeNull();
    expect(list.dueToday).toBe(true);
    expect(cellOf(model, M1, T1)?.suggested).toBe(10);
    expect(cellOf(model, M1, T2)?.suggested).toBe(0);
  });

  it("ger orsaker med samma takt och slutdatum som matrisen, utan centrallagrets summering", () => {
    const list = build().packLists.find((p) => p.machineId === M1)!;
    // Matrisen: Surging Sparks 4 kvar, 2,0 pack/dag, slut 3 nov.
    expect(list.reasons).toContain(
      `Surging Sparks tar slut tis 3${NBSP}nov. (4 kvar, 2,0 pack/dag)`,
    );
    expect(list.reasons).toContain("Black Bolt är slut (2,0 pack/dag)");
    expect(list.reasons.some((r) => r.startsWith("Centrallagret"))).toBe(false);
  });

  it("räknar BL-002 som inte aktuell i dag när inget tar slut den närmaste veckan", () => {
    const list = build().packLists.find((p) => p.machineId === M2)!;
    expect(list.dueToday).toBe(false);
    expect(list.plannedDay).toBeNull();
  });

  it("markerar centrallagret när veckans besök inte kan fyllas", () => {
    const model = build();
    const sparks = model.warehouse.find((w) => w.titleId === T2);
    expect(sparks).toMatchObject({ onHand: 0, status: "critical" });
    expect(sparks!.shortBy).toBeGreaterThan(0);
    const bolt = model.warehouse.find((w) => w.titleId === T1);
    expect(bolt).toMatchObject({ onHand: 10, status: "low", perDayTenths: 30, daysLeft: 3 });
  });

  it("sätter centrallagrets status efter slut, underskott och dagar kvar", () => {
    expect(warehouseStatus(0, null, { need: 4, short: 4 })).toBe("critical");
    expect(warehouseStatus(0, null, { need: 0, short: 0 })).toBe("ok");
    expect(warehouseStatus(5, 20, { need: 8, short: 3 })).toBe("low");
    // Räcker till veckans besök men bara 2 dagar vid alla automaters takt.
    expect(warehouseStatus(12, 2, { need: 6, short: 0 })).toBe("low");
    expect(warehouseStatus(40, 16, { need: 6, short: 0 })).toBe("ok");
  });

  it("räknar besöksplanen från i går i organisationens tidszon", () => {
    for (const tz of ["Europe/Stockholm", "America/Los_Angeles", "Pacific/Auckland"]) {
      expect(businessDateAt(planNow("2026-11-01", tz, NOW), tz)).toBe("2026-11-01");
    }
    // Sommartid → vintertid i Stockholm (25 okt.).
    expect(businessDateAt(planNow("2026-10-25", "Europe/Stockholm", NOW), "Europe/Stockholm")).toBe(
      "2026-10-25",
    );
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

function viewOf(model: ReturnType<typeof build>): LagerView {
  return {
    ...model,
    today: TODAY,
    now: NOW.toISOString(),
    timeZone: "Europe/Stockholm",
    history: [],
    historyTotal: 0,
    canRegister: true,
    canSetAlert: true,
    packListFirst: false,
  };
}

function packList(machineId: string, extra: Partial<PackList>): PackList {
  return {
    machineId,
    lines: [],
    missing: [],
    totalPacks: 0,
    shortBy: 0,
    needBy: null,
    plannedDay: null,
    dueToday: false,
    reasons: [],
    ...extra,
  };
}

describe("utgångna titlar (sortimentet)", () => {
  // Gammal titel (T3) gick ur sortimentet i BL-002 den 31 juli; Black Bolt (T1) gäller i BL-001.
  const periods = [
    { machineId: M2, titleId: T3, validFrom: "2026-02-01", validTo: "2026-07-31" },
    { machineId: M1, titleId: T1, validFrom: "2026-02-01", validTo: null },
    { machineId: M1, titleId: T2, validFrom: "2026-02-01", validTo: "2026-05-31" },
    { machineId: M1, titleId: T2, validFrom: "2026-12-01", validTo: null },
  ];
  const withSlots = (extraStock: StockRow[] = []) =>
    buildLagerModel({
      now: NOW,
      timeZone: "Europe/Stockholm",
      today: TODAY,
      master,
      stock: [...stock, ...extraStock],
      sales,
      scope: { storeId: null, machineId: null },
      hasCentral: true,
      slotPeriods: periods,
    });

  it("räknar ett par som utgånget bara när ingen period gäller i dag eller senare", () => {
    const r = retiredPairs(periods, TODAY);
    expect(r.size).toBe(1);
    expect([...r][0]).toContain(T3);
    // Sista dagen räknas fortfarande som i sortimentet.
    expect(retiredPairs([{ ...periods[0]!, validTo: TODAY }], TODAY).size).toBe(0);
  });

  it("visar inte en titel som gått ur sortimentet överallt och inte finns kvar", () => {
    const model = withSlots();
    expect(model.titles.map((t) => t.id)).not.toContain(T3);
    expect(model.retiredTitles).toEqual([{ id: T3, name: "Gammal titel" }]);
    // Den tomma platsen för Gammal titel räknas inte som Kritisk längre.
    expect(model.counts).toEqual({ critical: 1, low: 1, ok: 1 });
    const h = headlineOf(viewOf(model));
    expect(h.title).toBe("1 plats kritisk, 1 låg.");
  });

  it("visar en utgången titel med pack kvar, men utan status och påfyllning", () => {
    const model = withSlots([row(M1, T3, 3)]);
    const cell = cellOf(model, M2, T3);
    expect(cell).toMatchObject({ retired: true, status: "ok", suggested: 0 });
    expect(cellOf(model, M1, T3)).toMatchObject({ retired: false });
    expect(model.retiredTitles).toEqual([]);
  });
});

describe("headlineOf", () => {
  it("svarar med antal kritiska och låga, det mest brådskande och dagens besök", () => {
    const h = headlineOf(viewOf(build()));
    expect(h.title).toBe("2 platser kritiska, 1 låg.");
    // Högst två meningar: dagens besök står i sidhuvudets fakta (visitsToday).
    // Automatens namn i meningen (som Att göra och Prognos); koden står i tabellen.
    expect(h.aside).toBe("Black Bolt i Automat 1 är slut.");
    expect(visitsToday(viewOf(build()))).toBe(`10${NBSP}pack till ${codeText("BL-001")}`);
  });

  it("räknar bara automater som ska besökas i dag, och nämner nästa besöksdag", () => {
    const M3 = "00000000-0000-4000-8000-000000000003";
    const view = {
      today: TODAY,
      machines: [
        { id: M1, code: "BL-001", name: "", storeName: null },
        { id: M2, code: "BL-002", name: "", storeName: null },
        { id: M3, code: "BL-003", name: "", storeName: null },
      ],
      packLists: [
        packList(M1, { totalPacks: 20, plannedDay: "2026-11-03", needBy: "2026-11-03" }),
        packList(M2, { totalPacks: 21, plannedDay: "2026-11-03", needBy: "2026-11-04" }),
        packList(M3, { totalPacks: 16, plannedDay: TODAY, needBy: "2026-11-01", dueToday: true }),
      ],
    };
    expect(visitsText(view)).toBe(
      `16${NBSP}pack till ${codeText("BL-003")} i dag, ${codeText("BL-001")} och ${codeText("BL-002")} i morgon.`,
    );
    const none = {
      ...view,
      packLists: view.packLists.map((p) => ({ ...p, dueToday: false, plannedDay: "2026-11-05" })),
    };
    expect(visitsText(none)).toBe(
      `Inget besök behövs i dag, nästa besök ${codeText("BL-001")}, ${codeText("BL-002")} och ${codeText("BL-003")} den 5${NBSP}nov.`,
    );
    expect(machineList(["A", "B", "C", "D"])).toBe("4 automater");
    // Kort form i sidhuvudets fakta: antal automater när fler än en ska besökas.
    const two = {
      ...view,
      packLists: view.packLists.map((p) => ({ ...p, dueToday: true })),
    };
    expect(visitsTodayShort(two)).toBe(`57${NBSP}pack till 3 automater`);
    expect(visitsTodayShort(view)).toBe(`16${NBSP}pack till ${codeText("BL-003")}`);
  });
});

describe("packListAside", () => {
  it("ger aldrig dubbel punkt efter en förkortning", () => {
    expect(packListAside({ needBy: "2026-11-06", plannedDay: null }, TODAY)).toBe(
      `Besök senast 6${NBSP}nov.`,
    );
    expect(packListAside({ needBy: "2026-11-06", plannedDay: "2026-11-03" }, TODAY)).toBe(
      `Besök senast 6${NBSP}nov., planerat i morgon.`,
    );
    expect(packListAside({ needBy: TODAY, plannedDay: TODAY }, TODAY)).toBe("Besök senast i dag.");
    expect(packListAside({ needBy: null, plannedDay: null }, TODAY)).toMatch(/^Ingen titel/);
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

  it("använder signalen bara för en tom plats", () => {
    expect(statusTone("critical", 0)).toBe("critical");
    expect(statusTone("critical", 1)).toBe("warning");
    expect(statusTone("low", 3)).toBe("warning");
    expect(statusTone("ok", 30)).toBe("ok");
  });
});
