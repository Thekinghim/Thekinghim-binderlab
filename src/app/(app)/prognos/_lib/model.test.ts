import { describe, expect, it } from "vitest";

import { forecastSales } from "@/analytics/forecast";
import { lostSales } from "@/analytics/lost-sales";
import type { StockEventRef } from "@/analytics/lost-sales/stock";
import { demandFromForecast, inventoryValuation, purchasePlan } from "@/analytics/purchasing";
import type { PurchasingInput } from "@/analytics/purchasing/types";
import { addDays, revenue, type IsoDate, type OrderLine } from "@/domain";
import type { PrognosData, PurchaseOrderRecord } from "@/server/purchasing/types";

import { evidenceView, figureText } from "./evidence";
import {
  buildPageModel,
  codesUnbroken,
  krRangeText,
  oneSentence,
  purchaseOrderNumber,
  tidy,
} from "./model";
import { oreToField, parseCount, parseKronor } from "./units";

const SETTINGS = { vatRateBp: 0, cardFeeBp: 0 };
const TODAY: IsoDate = "2026-11-02";
const AS_OF: IsoDate = "2026-11-01";
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const M1 = "00000000-0000-4000-8000-0000000000a1";
const LOC1 = "00000000-0000-4000-8000-0000000000b1";
const SUP = "00000000-0000-4000-8000-0000000000c1";

const titles = [
  { id: T1, name: "Pokémon 151" },
  { id: T2, name: "Surging Sparks" },
];
const machines = [{ id: M1, name: "Automat 1", code: "BL-001", activeFrom: null, activeTo: null }];

/**
 * 98 dagar: T1 säljer 2 pack/dag (lördag 4) utom 20–28 okt. då den är slutsåld enligt
 * lagret; T2 säljer 1 pack/dag.
 */
function fixture() {
  const orders: OrderLine[] = [];
  const events: StockEventRef[] = [];
  let n = 0;
  const start = addDays(AS_OF, -97);
  events.push({
    id: "e-count",
    locationId: LOC1,
    machineId: M1,
    titleId: T1,
    kind: "count",
    quantity: 1_000,
    businessDate: addDays(start, -1),
  });
  for (let i = 0; i < 98; i++) {
    const date = addDays(start, i);
    const out = date >= "2026-10-20" && date <= "2026-10-28";
    if (date === "2026-10-19") {
      // Sista packen säljs, saldot nollställs med en inventering på kvällen.
      events.push({
        id: `c${i}`,
        locationId: LOC1,
        machineId: M1,
        titleId: T1,
        kind: "count",
        quantity: 0,
        businessDate: date,
        occurredAt: `${date}T21:00:00Z`,
      });
    }
    if (date === "2026-10-29") {
      events.push({
        id: `r${i}`,
        locationId: LOC1,
        machineId: M1,
        titleId: T1,
        kind: "refill",
        quantity: 200,
        businessDate: date,
        occurredAt: `${date}T06:00:00Z`,
      });
    }
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const t1 = out ? 0 : weekday === 6 ? 4 : 2;
    for (let k = 0; k < t1; k++) {
      n += 1;
      orders.push({
        id: `o${n}`,
        externalId: String(n),
        titleId: T1,
        machineId: M1,
        businessDate: date,
        amountOre: 7_900,
      });
      events.push({
        id: `s${n}`,
        locationId: LOC1,
        machineId: M1,
        titleId: T1,
        kind: "sale",
        quantity: -1,
        businessDate: date,
        occurredAt: `${date}T12:00:00Z`,
      });
    }
    n += 1;
    orders.push({
      id: `o${n}`,
      externalId: String(n),
      titleId: T2,
      machineId: M1,
      businessDate: date,
      amountOre: 8_900,
    });
  }
  return { orders, events };
}

function data(
  purchaseOrders: PurchaseOrderRecord[] = [],
  opts: { noItems?: boolean; t2Stock?: number } = {},
): PrognosData {
  const { orders, events } = fixture();
  const range = { start: addDays(AS_OF, -97), end: AS_OF };
  const lostAll = lostSales({
    orders,
    stockEvents: events,
    period: range,
    settings: SETTINGS,
    titles,
    machines,
  });
  const forecast = forecastSales({
    orders,
    asOf: AS_OF,
    settings: SETTINGS,
    titles,
    machines,
    unavailable: lostAll.stockoutDays.map((d) => ({
      machineId: d.machineId,
      titleId: d.titleId,
      date: d.date,
    })),
  });
  const lost = lostSales({
    orders,
    stockEvents: events,
    period: { start: "2026-10-01", end: "2026-10-31" },
    settings: SETTINGS,
    prices: [{ titleId: T1, unitCostOre: 4_500, validFrom: "2026-01-01" }],
    titles,
    machines,
  });
  const supplierItems = (opts.noItems ? [] : [0]).map(() => ({
    id: "i1",
    supplierId: SUP,
    titleId: T1,
    packSize: 12,
    minOrderQty: 24,
    leadTimeDays: 7,
    unitCostOre: 4_500,
  }));
  const input: PurchasingInput = {
    today: TODAY,
    titles,
    suppliers: [{ id: SUP, name: "Grossisten", defaultLeadTimeDays: 5 }],
    supplierItems,
    warehouseStock: [{ titleId: T1, onHand: 10 }],
    machineStock: [
      { machineId: M1, titleId: T1, onHand: 5 },
      ...(opts.t2Stock ? [{ machineId: M1, titleId: T2, onHand: opts.t2Stock }] : []),
    ],
    openPurchaseOrders: purchaseOrders
      .filter((po) => po.status === "ordered" || po.status === "partially_received")
      .map((po) => ({ ...po, lines: po.lines.map((l) => ({ ...l })) })),
    prices: [{ titleId: T1, unitCostOre: 4_500, validFrom: "2026-01-01" }],
    demand: demandFromForecast(forecast, TODAY),
    options: { includeDraftOrders: false },
  };
  const history = Array.from({ length: 8 }, (_, k) => {
    const j = 7 - k;
    const period = { start: addDays(AS_OF, -6 - 7 * j), end: addDays(AS_OF, -7 * j) };
    const inWeek = orders.filter(
      (o) => o.businessDate >= period.start && o.businessDate <= period.end,
    );
    return { period, units: inWeek.length, revenueOre: revenue(inWeek, SETTINGS) };
  });
  return {
    today: TODAY,
    asOf: AS_OF,
    forecastHistory: { start: addDays(AS_OF, -55), end: AS_OF },
    demandBasis: [...new Set(forecast.series.map((x) => x.titleId))].map((titleId) => {
      const list = forecast.series.filter((x) => x.titleId === titleId);
      const low = list.filter((x) => x.status === "low-data");
      return {
        titleId,
        series: list.length,
        lowDataSeries: low.length,
        lowDataUnitsMilli: low.reduce((sum, x) => sum + x.total.unitsMilli, 0),
        unitsMilli: list.reduce((sum, x) => sum + x.total.unitsMilli, 0),
      };
    }),
    lostPeriod: lost.period,
    scope: { storeId: null, machineId: null },
    canEdit: true,
    titles,
    machines,
    lostSales: lost,
    forecast,
    history,
    plan: purchasePlan(input),
    valuation: inventoryValuation(input),
    suppliers: [
      {
        id: SUP,
        name: "Grossisten",
        contactName: null,
        email: null,
        phone: null,
        defaultLeadTimeDays: 5,
        archived: false,
      },
    ],
    supplierItems: supplierItems.map((i) => ({ ...i })),
    purchaseOrders,
    hasCentralWarehouse: true,
  };
}

describe("figureText", () => {
  it("skriver varje enhet med svensk formatering", () => {
    expect(figureText({ value: 4_950, unit: "ore" })).toBe("49,50 kr");
    expect(figureText({ value: 1_240, unit: "bp" })).toBe("12,4 %");
    expect(figureText({ value: 1_450, unit: "milli" })).toBe("1,5 pack");
    expect(figureText({ value: 3, unit: "packs" })).toBe("3 pack");
    expect(figureText({ value: 1, unit: "days" })).toBe("1 dag");
    expect(figureText({ value: 9, unit: "days" })).toBe("9 dagar");
    expect(figureText({ value: 14, unit: "tenths" })).toBe("1,4");
    expect(figureText({ value: 12_480, unit: "count" })).toBe("12 480");
  });
});

describe("evidenceView", () => {
  const names = { title: (id: string) => `T:${id}`, machine: (id: string) => `M:${id}` };
  const base = {
    rule: "Regel.",
    storeIds: [] as string[],
    recipientIds: [] as string[],
    figures: [],
  };
  it("länkar till en enda order", () => {
    const v = evidenceView(
      {
        ...base,
        period: null,
        orderIds: ["abc"],
        dates: [] as string[],
        titleIds: [] as string[],
        machineIds: [] as string[],
      },
      names,
    );
    expect(v.links).toEqual([{ label: "Visa ordern", href: "/order?order=abc" }]);
  });
  it("länkar till orderlistan med period, automat och titel, och till lagret", () => {
    const v = evidenceView(
      {
        ...base,
        period: { start: "2026-10-01", end: "2026-10-31" },
        orderIds: ["a", "b"],
        dates: ["2026-10-03", "2026-10-02"],
        titleIds: [T1],
        machineIds: [M1],
      },
      names,
    );
    expect(v.links[0]).toEqual({
      label: "Visa 2 order",
      href: `/order?from=2026-10-01&to=2026-10-31&automat=${M1}&titel=${T1}`,
    });
    expect(v.links[1]?.href).toBe(`/lager?automat=${M1}`);
    expect(v.dates).toHaveLength(2);
    expect(v.titles).toEqual([`T:${T1}`]);
  });
});

describe("evidenceView för en prognos", () => {
  it("länkar inte till order i en period som inte har hänt", () => {
    const v = evidenceView(
      {
        rule: "Summa.",
        period: { start: "2026-11-02", end: "2026-11-29" },
        orderIds: [],
        dates: [],
        titleIds: [T1],
        machineIds: [M1, T2],
        storeIds: [],
        recipientIds: [],
        figures: [],
      },
      { title: (id) => id, machine: (id) => id, asOf: AS_OF },
    );
    expect(v.links).toEqual([]);
  });
});

describe("units", () => {
  it("tolkar kronor och antal från fält", () => {
    expect(parseKronor("45,50")).toBe(4_550);
    expect(parseKronor("45.5")).toBe(4_550);
    expect(parseKronor("1 200 kr")).toBe(120_000);
    expect(parseKronor("12,345")).toBeNull();
    expect(parseKronor("-3")).toBeNull();
    expect(parseCount("24")).toBe(24);
    expect(parseCount("2,5")).toBeNull();
    expect(oreToField(4_505)).toBe("45,05");
  });
  it("bryter aldrig automatkoder, inte heller i texterna från analysen", () => {
    expect(codesUnbroken("Förlorat i NA-05 och BL-001.")).toBe(
      "Förlorat i NA\u201105 och BL\u2011001.",
    );
    expect(codesUnbroken("2026-11-02, 4-veckor")).toBe("2026-11-02, 4-veckor");
    expect(tidy("Slutsålt i NA-05 sedan 1 nov..")).toBe("Slutsålt i NA\u201105 sedan 1 nov.");
  });
  it("skriver rubrikens andra del som en mening", () => {
    expect(
      oneSentence(["Slutsålt kostade ca 4 100 kr 4 okt. – 1 nov.", "1 titel bör beställas."]),
    ).toBe("Slutsålt kostade ca 4 100 kr 4 okt. – 1 nov., 1 titel bör beställas.");
    expect(oneSentence(["Slutsålt kostade ca 4 100 kr.", "Titlar behöver en leverantör."])).toBe(
      "Slutsålt kostade ca 4 100 kr, titlar behöver en leverantör.",
    );
  });
  it("skriver intervall och ordernummer", () => {
    expect(krRangeText(1_690_000, 1_990_000)).toBe("16 900–19 900 kr");
    expect(purchaseOrderNumber("abcdef12-0000")).toBe("IO‑ABCDEF");
  });
});

describe("buildPageModel", () => {
  const now = new Date("2026-11-02T09:00:00Z");

  it("visar slutsålt med kostnad och underlag", () => {
    const m = buildPageModel(data(), now);
    expect(m.lost.rows).toHaveLength(1);
    const row = m.lost.rows[0]!;
    expect(row.title).toBe("Pokémon 151");
    // Automatens namn, som i Att göra och på Lager.
    expect(row.machine).toBe("Automat 1");
    expect(row.lostRevenueOre).toBeGreaterThan(0);
    expect(m.lost.totalRevenueOre).toBe(row.lostRevenueOre);
    expect(m.lost.heading.title).toMatch(/^Slutsålt kostade ca/);
    expect(m.lost.heading.aside).toContain("Störst: Pokémon 151 i Automat 1");
    // Pågående slutsålt räknas i titlar och böjs i ental.
    expect(m.lost.heading.aside).not.toMatch(/1\u00a0titel är slutsålda/);
    // Sidhuvudet: periodtexten kan sluta på en förkortning ("okt."), aldrig "..".
    expect(m.heading.aside).toMatch(/Slutsålt kostade ca/);
    expect(m.heading.aside).not.toMatch(/(?<!\.)\.\.(?!\.)/);
    expect(row.evidence.rule).toMatch(/Slutsåld/);
    expect(row.evidence.links.some((l) => l.href.startsWith("/lager?automat="))).toBe(true);
  });

  it("bygger prognosen per titel, automat och serie med samma totalsumma", () => {
    const m = buildPageModel(data(), now);
    const f = m.forecast;
    expect(f.weeks).toHaveLength(4);
    expect(f.bySeries).toHaveLength(2);
    const sum = (rows: typeof f.byTitle) => rows.reduce((s, r) => s + r.total.revenueOre, 0);
    expect(sum(f.byTitle)).toBe(f.total.revenueOre);
    expect(sum(f.byMachine)).toBe(f.total.revenueOre);
    expect(f.weekdays.reduce((s, d) => s + d.revenueOre, 0)).toBe(f.total.revenueOre);
    expect(f.total.revenueLowOre).toBeLessThanOrEqual(f.total.revenueOre);
    expect(f.total.revenueHighOre).toBeGreaterThanOrEqual(f.total.revenueOre);
    expect(m.heading.title).toMatch(/^Ca\s.* kommande 4 veckor\.$/);
    expect(f.bySeries[0]?.explanation).toMatch(/Nivå/);
    // "80 %" bryts aldrig mellan talet och procenttecknet (hårt mellanslag, design.md §4).
    expect(f.coverage).toBe("80\u00a0%");
    expect(f.heading.aside).toContain("80\u00a0%-intervall");
  });

  it("lägger backtestens veckor på samma veckor som historiken", () => {
    const m = buildPageModel(data(), now);
    const withBacktest = m.forecast.history.filter((h) => h.backtestMilli !== null);
    expect(withBacktest.length).toBe(m.accuracy.origins.length);
    expect(withBacktest.length).toBeGreaterThan(0);
    // Sista historikveckan slutar i går och är backtestens sista vecka.
    expect(m.forecast.history.at(-1)?.end).toBe(AS_OF);
    expect(m.accuracy.origins.at(-1)?.period.end).toBe(AS_OF);
    expect(m.accuracy.heading.title).toMatch(/^Prognosen missade i snitt .* per dag\.$/);
  });

  it("föreslår inköp i hela boxar och visar leverantören", () => {
    const m = buildPageModel(data(), now);
    expect(m.plan.counts.order).toBe(1);
    expect(m.plan.proposals).toHaveLength(1);
    const line = m.plan.proposals[0]!.lines[0]!;
    expect(line.title).toBe("Pokémon 151");
    expect(line.supplierName).toBe("Grossisten");
    expect(line.orderQty % 12).toBe(0);
    expect(line.orderQty).toBeGreaterThanOrEqual(24);
    // T2 säljer men saknar leverantör.
    expect(m.plan.counts["no-supplier"]).toBe(1);
    expect(m.plan.heading.title).toMatch(/^1 titel att beställa/);
    expect(m.suppliers.heading.aside).toMatch(/saknar leverantör/);
  });

  it("markerar försenade inköpsorder och delar öppna från avslutade", () => {
    const po = (id: string, status: PurchaseOrderRecord["status"], expectedOn: IsoDate | null) => ({
      id,
      supplierId: SUP,
      status,
      orderedOn: "2026-10-20",
      expectedOn,
      receivedOn: status === "received" ? "2026-10-27" : null,
      note: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      lines: [
        {
          id: `${id}-l`,
          titleId: T1,
          quantity: 24,
          unitCostOre: 4_500,
          receivedQuantity: status === "received" ? 24 : 0,
        },
      ],
    });
    const m = buildPageModel(
      data([
        po("p1", "ordered", "2026-10-30"),
        po("p2", "received", "2026-10-27"),
        po("p3", "draft", null),
      ]),
      now,
    );
    expect(m.orders.open.map((o) => o.id).sort()).toEqual(["p1", "p3"]);
    expect(m.orders.closed.map((o) => o.id)).toEqual(["p2"]);
    const late = m.orders.open.find((o) => o.id === "p1")!;
    expect(late.overdue).toBe(true);
    expect(late.statusLabel).toBe("Försenad");
    expect(late.totalOre).toBe(24 * 4_500);
    expect(m.orders.heading.aside).toMatch(/försenad/);
  });

  it("räknar lagervärdet ur inköpspriset", () => {
    const m = buildPageModel(data(), now);
    const t1 = m.valuation.rows.find((r) => r.titleId === T1)!;
    expect(t1.onHand).toBe(15);
    expect(t1.valueOre).toBe(15 * 4_500);
    expect(m.valuation.heading.title).toMatch(/^Kapitalbindning/);
  });

  it("visar utkast på förslagets rader utan att räkna dem som beställda", () => {
    const draft: PurchaseOrderRecord = {
      id: "dddddd00-0000",
      supplierId: SUP,
      status: "draft",
      orderedOn: null,
      expectedOn: null,
      receivedOn: null,
      note: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      lines: [{ id: "dl", titleId: T1, quantity: 24, unitCostOre: 4_500, receivedQuantity: 0 }],
    };
    const m = buildPageModel(data([draft]), now);
    // Förslaget finns kvar (utkastet räknas inte), med utkastet utpekat.
    expect(m.plan.counts.order).toBe(1);
    const p = m.plan.proposals[0]!;
    expect(p.drafts).toEqual([{ id: draft.id, number: "IO‑DDDDDD", packs: 24 }]);
    expect(p.lines[0]!.drafts).toEqual([{ number: "IO‑DDDDDD", quantity: 24 }]);
    expect(p.lines[0]!.evidence.figures.some((f) => f.key === "draftPacks")).toBe(true);
    expect(m.plan.heading.aside).toMatch(/redan i ett utkast/);
    // Utkastet är äldre än 7 dagar.
    const o = m.orders.open.find((x) => x.id === draft.id)!;
    expect(o.staleDraft).toBe(true);
    expect(o.statusLabel).toBe("Gammalt utkast");
  });

  it("länkar planens underlag till centrallagret, historiken och inköpsordern", () => {
    const po: PurchaseOrderRecord = {
      id: "eeeeee00-0000",
      supplierId: SUP,
      status: "ordered",
      orderedOn: "2026-11-01",
      expectedOn: "2026-11-20",
      receivedOn: null,
      note: null,
      createdAt: "2026-11-01T10:00:00.000Z",
      lines: [{ id: "el", titleId: T1, quantity: 12, unitCostOre: 4_500, receivedQuantity: 0 }],
    };
    const m = buildPageModel(data([po]), now);
    const line = m.plan.lines.find((l) => l.titleId === T1)!;
    const hrefs = line.evidence.links.map((l) => l.href);
    expect(hrefs).toContain("/vart-lager");
    expect(hrefs).toContain("#inkopsorder");
    expect(hrefs).toContain(`/order?from=2026-09-07&to=2026-11-01&titel=${T1}`);
    // Prognos per titel och per automat länkar till historiken de bygger på.
    const byTitle = m.forecast.byTitle.find((r) => r.key === T1)!;
    expect(byTitle.evidence.links[0]).toEqual({
      label: "Visa orderna som prognosen bygger på",
      href: `/order?from=2026-09-07&to=2026-11-01&automat=${M1}&titel=${T1}`,
    });
    const byMachine = m.forecast.byMachine[0]!;
    expect(byMachine.evidence.links[0]?.href).toBe(
      `/order?from=2026-09-07&to=2026-11-01&automat=${M1}`,
    );
  });

  it("säger hur många titlar som saknar leverantör i stället för 'Inget'", () => {
    const m = buildPageModel(data([], { noItems: true }), now);
    expect(m.plan.counts.order).toBe(0);
    expect(m.plan.counts["no-supplier"]).toBe(2);
    const meta = m.meta.find((x) => x.label === "Att beställa")!;
    expect(meta.value.replace(/\u00a0/g, " ")).toBe("2 titlar utan leverantör");
  });

  it("märker lagervärdet som ofullständigt när inköpspris saknas", () => {
    const m = buildPageModel(data([], { t2Stock: 7 }), now);
    const t2 = m.valuation.rows.find((r) => r.titleId === T2)!;
    expect(t2.unitCostOre).toBeNull();
    expect(m.valuation.incomplete).toBe(true);
    expect(m.valuation.heading.title).toMatch(/^Kapitalbindning minst/);
    expect(m.meta.find((x) => x.label === "Kapitalbindning")?.value).toMatch(/^minst /);
  });

  it("visar en order som avslutats med restorder", () => {
    const po: PurchaseOrderRecord = {
      id: "ffffff00-0000",
      supplierId: SUP,
      status: "received",
      orderedOn: "2026-10-20",
      expectedOn: "2026-10-27",
      receivedOn: "2026-11-01",
      note: "Avslutad 2026-11-01 med restorder: 6 pack kom aldrig.",
      createdAt: "2026-10-20T10:00:00.000Z",
      lines: [{ id: "fl", titleId: T1, quantity: 24, unitCostOre: 4_500, receivedQuantity: 18 }],
    };
    const m = buildPageModel(data([po]), now);
    const o = m.orders.closed.find((x) => x.id === po.id)!;
    expect(o.closedShort).toBe(true);
    expect(o.statusLabel).toBe("Avslutad med restorder");
  });

  it("flaggar förslag som bygger på automater med lite data", () => {
    const d = data();
    const withLow: PrognosData = {
      ...d,
      demandBasis: d.demandBasis.map((b) =>
        b.titleId === T1
          ? { ...b, series: 2, lowDataSeries: 1, lowDataUnitsMilli: Math.round(b.unitsMilli / 2) }
          : b,
      ),
    };
    const m = buildPageModel(withLow, now);
    const line = m.plan.lines.find((l) => l.titleId === T1)!;
    expect(line.lowData?.lowDataSeries).toBe(1);
    expect(line.lowData?.series).toBe(2);
    expect(Math.abs((line.lowData?.shareBp ?? 0) - 5_000)).toBeLessThanOrEqual(1);
    expect(m.plan.heading.aside).toMatch(/lite data/);
  });
});
