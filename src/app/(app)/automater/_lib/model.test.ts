import { describe, expect, it } from "vitest";

import type { MachineHealth } from "@/analytics/health";
import type { AnalyticsOrder, TodoItem } from "@/analytics/todos";
import type { DomainInput, MasterData, StockSnapshot } from "@/server/data/core/types";

import {
  startedOn,
  buildOverview,
  coverageOf,
  heatThresholds,
  lifecycleOf,
  machineFigures,
  machineHeadline,
  machineNeeds,
  needsHeadline,
  machineDaysIn,
  machineHref,
  machineSignals,
  machineSpan,
  machineUnpriced,
  nextMachineCode,
  joinClauses,
  overviewHeadline,
  placementLines,
  salesHeatmap,
  sentence,
  spanOf,
  spreadText,
  statusOf,
  stockLines,
  titleShares,
} from "./model";
import type { MachineListRow } from "./types";

const TZ = "Europe/Stockholm";
/** Text utan hårda mellanslag, för läsbara förväntningar. */
const plain = (v: string | null | undefined) => (v ?? "").replace(/\u00a0/g, " ");
const plainObj = (o: object) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? plain(v) : (v as unknown)]),
  );
const settings = { vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1 };

let seq = 0;
function order(
  machineId: string | null,
  titleId: string,
  at: string,
  amountOre = 20_000,
): AnalyticsOrder {
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
  titles: [
    { id: "t1", name: "Black Bolt", series: null, mergedIntoId: null, archived: false },
    { id: "t2", name: "Mystery Pack", series: null, mergedIntoId: null, archived: false },
  ],
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
    {
      id: "m2",
      code: "BL-002",
      name: "Automat 2",
      serial: null,
      storeId: "s1",
      activeFrom: "2026-10-01",
      activeTo: null,
      isExample: false,
      archived: false,
    },
    {
      id: "m3",
      code: "BL-003",
      name: "Automat 3",
      serial: null,
      storeId: null,
      activeFrom: "2026-10-01",
      activeTo: "2026-10-20",
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
  placements: [
    { id: "p1", machineId: "m1", storeId: "s1", from: "2026-10-01", to: null },
    { id: "p2", machineId: "m2", storeId: "s1", from: "2026-10-01", to: null },
    { id: "p3", machineId: "m3", storeId: "s1", from: "2026-10-01", to: "2026-10-20" },
  ],
};

const prices = [
  { titleId: "t1", unitCostOre: 10_000, validFrom: "2026-01-01" },
  { titleId: "t2", unitCostOre: 5_000, validFrom: "2026-01-01" },
];
// 3 000 kr hyra i månaden: 30 000 öre per dag i oktober (31 dagar) ≈ 9 677 öre.
const agreements = [
  {
    storeId: "s1",
    validFrom: "2026-01-01",
    validTo: null,
    commissionBp: 1000,
    monthlyRentOre: 300_000,
  },
];

function domainInput(orders: AnalyticsOrder[], previous: AnalyticsOrder[] | null): DomainInput {
  const period = { start: "2026-10-13", end: "2026-10-26" };
  const compare = { start: "2026-09-29", end: "2026-10-12" };
  const sources = { prices, agreements, placements: master.placements, settings };
  return {
    ...master,
    period,
    compare: previous ? compare : null,
    scope: { storeId: null, machineId: null },
    current: { ...sources, orders, period },
    previous: previous ? { ...sources, orders: previous, period: compare } : null,
    sources,
    investments: [],
    settings,
    diagnostics: { ordersWithoutTitle: 0, ordersWithoutMachine: 0 },
  };
}

const stock: StockSnapshot = { rows: [], machineStock: [], warehouse: [] };

describe("små hjälpare", () => {
  it("machineHref använder koden i gemener och bär med query", () => {
    expect(machineHref("BL-001")).toBe("/automater/bl-001");
    expect(machineHref("BL-001", "?period=7d")).toBe("/automater/bl-001?period=7d");
  });

  it("lifecycleOf", () => {
    const m = { activeFrom: "2026-10-01", activeTo: null, archived: false };
    expect(lifecycleOf(m, "2026-11-02")).toBe("active");
    expect(lifecycleOf({ ...m, activeFrom: "2026-12-01" }, "2026-11-02")).toBe("planned");
    expect(lifecycleOf({ ...m, activeTo: "2026-11-01" }, "2026-11-02")).toBe("decommissioned");
    expect(lifecycleOf({ ...m, activeTo: "2026-11-02" }, "2026-11-02")).toBe("active");
    expect(lifecycleOf({ ...m, archived: true }, "2026-11-02")).toBe("decommissioned");
  });

  it("sentence lägger inte till en punkt efter förkortning", () => {
    expect(sentence("Står i Centrum sedan 1 okt.")).toBe("Står i Centrum sedan 1 okt.");
    expect(sentence("Står i Centrum sedan 1 maj")).toBe("Står i Centrum sedan 1 maj.");
  });

  it("nextMachineCode följer mönstret och hoppar över upptagna", () => {
    expect(nextMachineCode(["BL-001", "BL-002", "BL-010"])).toBe("BL-011");
    expect(nextMachineCode([])).toBe("BL-001");
    expect(nextMachineCode(["X9"])).toBe("X10");
  });
});

describe("salesHeatmap", () => {
  it("räknar köp per veckodag och timme i svensk tid, även över sommartidsskiftet", () => {
    // Mån 26 okt. 2026 08:30 UTC = 09:30 svensk vintertid; lör 24 okt. 12:10 UTC = 14:10 sommartid.
    const heat = salesHeatmap(
      [
        order("m1", "t1", "2026-10-26T08:30:00Z"),
        order("m1", "t1", "2026-10-26T08:59:00Z"),
        order("m1", "t1", "2026-10-24T12:10:00Z"),
      ],
      TZ,
    );
    expect(heat.total).toBe(3);
    expect(heat.firstHour).toBe(8);
    expect(heat.colLabels[0]).toBe("08");
    expect(heat.values[0]?.[9 - 8]).toBe(2); // måndag 09–10
    expect(heat.values[5]?.[14 - 8]).toBe(1); // lördag 14–15
    expect(heat.peak).toEqual({ weekday: 0, hour: 9, count: 2 });
  });

  it("utökar kolumnerna till timmar utanför 08–20 och klarar inga order", () => {
    const heat = salesHeatmap([order("m1", "t1", "2026-10-26T22:30:00Z")], TZ); // 23:30
    expect(heat.colLabels.at(-1)).toBe("23");
    const empty = salesHeatmap([], TZ);
    expect(empty.total).toBe(0);
    expect(empty.peak).toBeNull();
    expect(empty.colLabels).toHaveLength(13);
  });
});

describe("statusOf", () => {
  const base = {
    lifecycle: "active" as const,
    activeFrom: "2026-10-01",
    activeTo: null,
    today: "2026-11-02",
  };
  const health = (status: MachineHealth["status"]) =>
    ({ status, title: `Hälsa ${status}` }) as unknown as MachineHealth;
  const refill = (level: "now" | "soon", title = "Fyll på Black Bolt i Automat 1") =>
    ({ level, title }) as unknown as TodoItem;

  it("i drift utan signaler", () => {
    expect(statusOf({ ...base, health: health("ok"), refill: [] })).toMatchObject({
      status: "ok",
      label: "I drift",
      flagged: false,
    });
  });

  it("fyll på nu kräver åtgärd och nämner fler titlar i samma mening", () => {
    const s = statusOf({
      ...base,
      health: health("ok"),
      refill: [refill("now"), refill("now", "B")],
    });
    expect(s).toMatchObject({ status: "critical", label: "Fyll på nu", flagged: true });
    expect(plain(s.reason)).toBe("Fyll på Black Bolt i Automat 1 och 1 titel till.");
  });

  it("fel, tom och ur drift går före påfyllning och kräver åtgärd; misstänkt fel är grått", () => {
    expect(statusOf({ ...base, health: health("fault"), refill: [refill("now")] }).label).toBe(
      "Fel",
    );
    expect(statusOf({ ...base, health: health("empty"), refill: [] }).flagged).toBe(true);
    expect(statusOf({ ...base, health: health("offline"), refill: [refill("now")] })).toMatchObject(
      {
        status: "critical",
        label: "Ur drift",
        flagged: true,
      },
    );
    expect(statusOf({ ...base, health: health("suspected_fault"), refill: [] })).toMatchObject({
      status: "warning",
      flagged: false,
    });
    expect(statusOf({ ...base, health: health("ok"), refill: [refill("soon")] }).label).toBe(
      "Fyll på snart",
    );
  });

  it("avvecklad och planerad", () => {
    expect(
      plainObj(
        statusOf({
          ...base,
          lifecycle: "decommissioned",
          activeTo: "2026-10-20",
          health: undefined,
          refill: [],
        }),
      ),
    ).toMatchObject({ label: "Avvecklad", status: "offline", reason: "Sista dag 20 okt." });
    expect(
      statusOf({
        ...base,
        lifecycle: "planned",
        activeFrom: "2026-12-01",
        health: undefined,
        refill: [],
      }),
    ).toMatchObject({ label: "Planerad", status: "neutral" });
  });
});

describe("buildOverview och detaljvyns figurer", () => {
  const current = [
    order("m1", "t1", "2026-10-14T10:00:00Z", 20_000),
    order("m1", "t1", "2026-10-15T10:00:00Z", 20_000),
    order("m1", "t2", "2026-10-16T10:00:00Z", 15_000),
    order("m2", "t2", "2026-10-16T11:00:00Z", 15_000),
  ];
  const previous = [order("m1", "t1", "2026-10-05T10:00:00Z", 20_000)];
  const input = domainInput(current, previous);
  const overview = buildOverview({
    input,
    master,
    stock,
    signals: { refill: new Map(), health: new Map(), stake: new Map() },
    lastOrderAt: new Map([["m1", "2026-10-16T10:00:00.000Z"]]),
    today: "2026-11-02",
    scope: { storeId: null, machineId: null },
    coverage: { start: "2026-10-13", end: "2026-10-26" },
    pendingToday: false,
    query: "",
  });

  it("intäkt per automat från beräkningslagret, sorterat: i drift först, störst intäkt", () => {
    expect(overview.rows.map((r) => r.code)).toEqual(["BL-001", "BL-002", "BL-003"]);
    const [m1, m2, m3] = overview.rows;
    expect(m1?.revenueOre).toBe(55_000);
    expect(m1?.orders).toBe(3);
    expect(m1?.topTitle).toEqual({ name: "Black Bolt", orders: 2 });
    expect(m1?.storeName).toBe("Centrum");
    expect(m1?.lastOrderAt).toBe("2026-10-16T10:00:00.000Z");
    expect(m2?.revenueOre).toBe(15_000);
    expect(m3?.lifecycle).toBe("decommissioned");
    expect(overview.totals.revenueOre).toBe(70_000);
    expect(overview.totals.activeMachines).toBe(2);
    // Föregående period: 200 kr → 700 kr = +250 %.
    expect(overview.totals.revenueChange).toBeCloseTo(2.5, 4);
    expect(m1?.revenueChange).toBeCloseTo(1.75, 4);
  });

  it("raderna plus ej fördelad hyra summerar exakt till totalen", () => {
    // Mystery Pack saknar inköpspris: hyran på de orderna är ej fördelad.
    const partly = { ...input, current: { ...input.current, prices: prices.slice(0, 1) } };
    const o = buildOverview({
      input: partly,
      master,
      stock,
      signals: { refill: new Map(), health: new Map(), stake: new Map() },
      lastOrderAt: new Map(),
      today: "2026-11-02",
      scope: { storeId: null, machineId: null },
      coverage: { start: "2026-10-13", end: "2026-10-26" },
      pendingToday: false,
      query: "",
    });
    const sum = o.rows.reduce((s, r) => s + r.profitOre, 0);
    const other = o.others.reduce((s, r) => s + r.profitOre, 0);
    expect(o.others.map((x) => x.label)).toEqual(["Ej fördelad hyra"]);
    expect(other).toBeLessThan(0);
    expect(sum + other).toBe(o.totals.profitOre);
    expect(o.unpriced).toMatchObject({ orders: 2, titles: ["Mystery Pack"] });
    // Utan saknade priser finns ingen sådan rad, och raderna är totalen.
    expect(overview.others).toEqual([]);
    expect(overview.rows.reduce((s, r) => s + r.profitOre, 0)).toBe(overview.totals.profitOre);
    expect(machineFigures(input.current, "m1").profitOre).toBe(overview.rows[0]?.profitOre);
  });

  it("intäkt per automatdag räknas på dagarna i butik (BL-003 t.o.m. 20 okt.)", () => {
    // 14 + 14 + 8 automatdagar (13–26 okt., BL-003 13–20 okt.).
    expect(machineDaysIn(input.current, input.period, master.machines)).toBe(36);
    expect(overview.totals.revenuePerMachineDayOre).toBe(Math.round(70_000 / 36));
  });

  it("automatfiltret: summan är automatens rad på hela organisationens indata", () => {
    const focused = buildOverview({
      input,
      master,
      stock,
      signals: { refill: new Map(), health: new Map(), stake: new Map() },
      lastOrderAt: new Map(),
      today: "2026-11-02",
      scope: { storeId: null, machineId: "m2" },
      coverage: { start: "2026-10-13", end: "2026-10-26" },
      pendingToday: false,
      query: "",
    });
    expect(focused.rows.map((r) => r.code)).toEqual(["BL-002"]);
    expect(focused.others).toEqual([]);
    const fig = machineFigures(input.current, "m2");
    expect(focused.totals.profitOre).toBe(fig.profitOre);
    expect(focused.totals.profitOre).toBe(focused.rows[0]?.profitOre);
    expect(focused.totals.revenueOre).toBe(15_000);
    // BL-002 sålde inget i jämförelseperioden: ingen förändring.
    expect(focused.totals.revenueChange).toBeNull();
    expect(focused.totals.revenuePerMachineDayOre).toBe(Math.round(15_000 / 14));
  });

  it("order utan inköpspris: antal, andel, titlar och länk", () => {
    const unpricedInput = {
      ...input,
      current: { ...input.current, prices: prices.filter((p) => p.titleId === "t1") },
    };
    const u = machineUnpriced(unpricedInput.current, "m1", master);
    expect(u).toMatchObject({
      orders: 1,
      revenueOre: 15_000,
      titles: ["Mystery Pack"],
      href: "/inkopspriser?titel=t2",
    });
    expect(u?.shareBp).toBe(Math.round((15_000 * 10_000) / 55_000));
    expect(u?.rentOre).toBeGreaterThan(0);
    expect(overview.unpriced).toBeNull();
  });

  it("rubriken bär summan, antalet dagar och jämförelsen", () => {
    expect(plain(overview.headline.title)).toBe("700 kr på 14 dagar från 2 automater.");
    expect(plain(overview.headline.aside)).toMatch(/^250 % bättre än perioden innan\./);
  });

  it("titelandelar i automaten", () => {
    const t = titleShares(input.current, "m1", master);
    expect(t.map((x) => [x.name, x.orders, x.revenueOre])).toEqual([
      ["Black Bolt", 2, 40_000],
      ["Mystery Pack", 1, 15_000],
    ]);
    expect(t[0]?.share).toBeCloseTo(40 / 55, 6);
  });

  it("detaljrubriken", () => {
    const fig = machineFigures(input.current, "m1");
    const h = machineHeadline({
      code: "BL-001",
      lifecycle: "active",
      activeFrom: "2026-10-01",
      activeTo: null,
      figures: fig,
      previous: machineFigures(input.previous!, "m1"),
      span: spanOf({ start: "2026-10-13", end: "2026-10-26" }, "2026-11-02"),
      store: { name: "Centrum", since: "2026-10-01" },
      today: "2026-11-02",
    });
    expect(plain(h.title)).toBe("BL-001: 550 kr på 14 dagar.");
    expect(plain(h.aside)).toBe("175 % bättre än perioden innan, står i Centrum sedan 1 okt.");
  });
});

describe("overviewHeadline och spreadText", () => {
  const totals = {
    revenueOre: 0,
    profitOre: 0,
    marginBp: null,
    orders: 0,
    revenuePerMachineDayOre: null,
    revenueChange: null,
    profitChange: null,
    ordersChange: null,
    previousMarginBp: null,
    activeMachines: 2,
  };
  it("tomma lägen", () => {
    const span30 = spanOf({ start: "2026-10-04", end: "2026-11-02" }, "2026-11-02");
    const today = spanOf({ start: "2026-11-02", end: "2026-11-02" }, "2026-11-02");
    expect(overviewHeadline({ rows: [], totals, span: span30, flagged: 0, top: null }).title).toBe(
      "Inga automater ännu.",
    );
    const row = { lifecycle: "active" } as MachineListRow;
    expect(
      plain(overviewHeadline({ rows: [row], totals, span: span30, flagged: 0, top: null }).title),
    ).toBe("Ingen försäljning på 30 dagar.");
    expect(
      overviewHeadline({ rows: [row], totals, span: today, flagged: 0, top: null }).title,
    ).toBe("Ingen försäljning i dag.");
    expect(
      overviewHeadline({
        rows: [row],
        totals,
        span: today,
        pendingToday: true,
        flagged: 0,
        top: null,
      }).title,
    ).toBe("Inga order i dag ännu.");
    // Ur drift räknas inte som i drift, och står i antalet som kräver åtgärd.
    expect(
      plain(
        overviewHeadline({
          rows: [row],
          totals: { ...totals, offlineMachines: 1 },
          span: span30,
          flagged: 1,
          top: null,
        }).aside,
      ),
    ).toBe("1 av 2 automater i drift, 1 ur drift, 1 automat kräver åtgärd.");
    expect(joinClauses(["Vinst 8 kr.", "Står i Centrum sedan 1 okt."])).toBe(
      "Vinst 8 kr, står i Centrum sedan 1 okt.",
    );
    expect(joinClauses(["Samma som perioden innan.", "BL-001 står för 42 %."])).toBe(
      "Samma som perioden innan, BL-001 står för 42 %.",
    );
  });

  it("åtgärd före toppen", () => {
    const row = { lifecycle: "active" } as MachineListRow;
    const t = { ...totals, revenueOre: 100_000, orders: 5 };
    expect(
      plainObj(
        overviewHeadline({
          rows: [row],
          totals: t,
          span: spanOf({ start: "2026-11-01", end: "2026-11-01" }, "2026-11-02"),
          flagged: 1,
          top: { code: "BL-001", shareBp: 6000 },
        }),
      ),
    ).toEqual({ title: "1 000 kr i går från 2 automater.", aside: "1 automat kräver åtgärd." });
    expect(
      plain(
        overviewHeadline({
          rows: [row],
          totals: t,
          span: spanOf({ start: "2026-11-01", end: "2026-11-01" }, "2026-11-02"),
          flagged: 0,
          top: { code: "BL-001", shareBp: 6000 },
        }).aside,
      ),
    ).toBe("BL-001 står för 60 % av vinsten.");
  });

  it("spridningen mellan bäst och sämst", () => {
    const r = (code: string, revenueOre: number) =>
      ({ code, revenueOre, orders: 1, lifecycle: "active" }) as MachineListRow;
    expect(plain(spreadText([r("A-1", 300), r("A-2", 100)]))).toBe(
      "A-1 drar in 3,0 gånger så mycket som A-2.",
    );
    expect(plain(spreadText([r("A-1", 150), r("A-2", 100)]))).toBe("A-1 drar in 50 % mer än A-2.");
    expect(plain(spreadText([r("A-1", 105), r("A-2", 100)]))).toBe(
      "A-1 och A-2 drar in ungefär lika mycket.",
    );
    expect(plain(spreadText([]))).toBe("Ingen har sålt något i perioden.");
  });
});

describe("stockLines och placementLines", () => {
  it("takt över 14 hela dagar t.o.m. i går, nivå från regeln, mest brådskande först", () => {
    const recent: AnalyticsOrder[] = [];
    for (let d = 19; d <= 31; d++) recent.push(order("m1", "t1", `2026-10-${d}T10:00:00Z`));
    recent.push(order("m1", "t1", "2026-11-01T10:00:00Z"));
    const lines = stockLines({
      machine: { id: "m1", activeFrom: "2026-10-01" },
      rows: [
        {
          locationId: "l",
          locationName: "BL-001",
          locationKind: "machine",
          isCentral: false,
          machineId: "m1",
          titleId: "t2",
          onHand: 5,
          lastCountedAt: null,
          lastEventAt: null,
          lastRestockedAt: null,
        },
        {
          locationId: "l",
          locationName: "BL-001",
          locationKind: "machine",
          isCentral: false,
          machineId: "m1",
          titleId: "t1",
          onHand: 2,
          lastCountedAt: null,
          lastEventAt: null,
          lastRestockedAt: "2026-10-30T09:10:00Z",
        },
        {
          locationId: "w",
          locationName: "Lager",
          locationKind: "warehouse",
          isCentral: true,
          machineId: null,
          titleId: "t1",
          onHand: 99,
          lastCountedAt: null,
          lastEventAt: null,
          lastRestockedAt: null,
        },
      ],
      recentOrders: recent,
      refill: [{ level: "soon", evidence: { titleIds: ["t1"] } } as unknown as TodoItem],
      master,
      today: "2026-11-02",
    });
    expect(lines.map((l) => l.name)).toEqual(["Black Bolt", "Mystery Pack"]);
    expect(lines[0]).toMatchObject({
      onHand: 2,
      perDay: 1,
      daysLeft: 2,
      stockoutDate: "2026-11-03",
      level: "soon",
    });
    expect(lines[1]).toMatchObject({ perDay: null, daysLeft: null, level: null });
  });

  it("placeringar, senaste först, med dagar t.o.m. i dag", () => {
    const p = placementLines(master, "m1", "2026-11-02");
    expect(p).toEqual([
      {
        id: "p1",
        storeId: "s1",
        storeName: "Centrum",
        from: "2026-10-01",
        to: null,
        current: true,
        days: 33,
      },
    ]);
    expect(placementLines(master, "m3", "2026-11-02")[0]).toMatchObject({
      current: false,
      days: 20,
    });
  });
});

describe("dagar med data", () => {
  const today = "2026-11-02";
  const period = { start: "2026-10-04", end: "2026-11-02" };
  it("från första ordern, t.o.m. i går när dagens order inte kommit", () => {
    expect(coverageOf(period, "2026-10-13", today, false)).toEqual({
      start: "2026-10-13",
      end: "2026-11-01",
    });
    expect(coverageOf(period, "2026-10-13", today, true)).toEqual({
      start: "2026-10-13",
      end: "2026-11-02",
    });
    expect(coverageOf(period, null, today, false)).toBeNull();
    expect(coverageOf({ start: today, end: today }, "2026-10-13", today, false)).toBeNull();
    // En period som slutat påverkas inte av i dag.
    const past = { start: "2026-10-20", end: "2026-10-26" };
    expect(coverageOf(past, "2026-10-13", today, false)).toEqual(past);
  });

  it("automatens dagar: driftstart och sista dag", () => {
    const c = { start: "2026-10-13", end: "2026-11-01" };
    expect(machineSpan(c, "2026-10-15", null)).toEqual({ start: "2026-10-15", end: "2026-11-01" });
    expect(machineSpan(c, null, "2026-10-20")).toEqual({ start: "2026-10-13", end: "2026-10-20" });
    expect(machineSpan(c, "2026-11-05", null)).toBeNull();
    expect(machineSpan(null, null, null)).toBeNull();
  });

  it("rubrikens tidsangivelse", () => {
    const p = (v: { text: string; days: number }) => ({ ...v, text: plain(v.text) });
    expect(p(spanOf({ start: "2026-10-13", end: "2026-11-01" }, today))).toEqual({
      days: 20,
      text: "på 20 dagar",
    });
    expect(spanOf({ start: today, end: today }, today).text).toBe("i dag");
    expect(spanOf({ start: "2026-11-01", end: "2026-11-01" }, today).text).toBe("i går");
    expect(plain(spanOf({ start: "2026-10-31", end: "2026-10-31" }, today).text)).toBe(
      "den 31 okt.",
    );
  });
});

describe("heatThresholds", () => {
  it("heltalsgränser, högst fem steg och inga dubbletter", () => {
    expect(heatThresholds(6)).toEqual([3, 5]);
    expect(heatThresholds(4)).toEqual([2, 3, 4]);
    expect(heatThresholds(5)).toEqual([2, 3, 4, 5]);
    expect(heatThresholds(12)).toEqual([4, 7, 10]);
    expect(heatThresholds(40)).toEqual([9, 17, 25, 33]);
    expect(heatThresholds(1)).toEqual([2]);
    expect(heatThresholds(0)).toEqual([2]);
    for (const top of [2, 3, 7, 9, 23, 100]) {
      const t = heatThresholds(top);
      expect(t.every(Number.isInteger)).toBe(true);
      expect(new Set(t).size).toBe(t.length);
      expect(t.length).toBeLessThanOrEqual(4);
    }
  });

  it("värmekartan får gränserna för sin topp", () => {
    const orders = [1, 2, 3].map(() => order("m1", "t1", "2026-10-18T11:30:00Z"));
    expect(salesHeatmap(orders, TZ).thresholds).toEqual(heatThresholds(3));
  });
});

describe("machineSignals: samma status som Drift", () => {
  it("använder Drifts hälsa när den finns, i stället för att räkna om på orderna", () => {
    const fromDrift = [
      { machineId: "m1", status: "ok", title: "I drift" },
      { machineId: "m2", status: "offline", title: "Ur drift" },
    ] as unknown as MachineHealth[];
    const empty = {
      sources: {
        prices: [],
        agreements: [],
        placements: [],
        settings: { vatRateBp: 0, cardFeeBp: 0 },
      },
      current: { orders: [] },
    } as unknown as DomainInput;
    const signals = machineSignals({
      recent: empty,
      stock: { machineStock: [] } as unknown as StockSnapshot,
      master: { titles: [], machines: [], stores: [] } as unknown as MasterData,
      now: new Date("2026-11-02T10:00:00Z"),
      timeZone: "Europe/Stockholm",
      health: fromDrift,
    });
    expect([...signals.health.entries()].map(([id, h]) => [id, h.status])).toEqual([
      ["m1", "ok"],
      ["m2", "offline"],
    ]);
  });
});

describe("startedOn", () => {
  it("tar den tidigaste av driftstart, första placering och första order", () => {
    expect(startedOn("2026-11-03", "2026-11-03", "2026-10-14")).toBe("2026-10-14");
    expect(startedOn("2026-10-01", "2026-11-03", null)).toBe("2026-10-01");
    expect(startedOn(null, null, null)).toBeNull();
  });
});

describe("machineNeeds och needsHeadline", () => {
  const status = (s: string, label: string, flagged: boolean, health: string | null = null) =>
    ({ status: s, label, flagged, health, reason: `${label}.` }) as MachineListRow["status"];
  const row = (
    id: string,
    code: string,
    st: MachineListRow["status"],
    refillNow = 0,
    refillSoon = 0,
  ) =>
    ({
      id,
      code,
      name: `Automat ${code}`,
      href: `/automater/${code.toLowerCase()}`,
      lifecycle: "active",
      storeName: id === "a" ? "Sega gubben" : null,
      status: st,
      refillNow,
      refillSoon,
    }) as unknown as MachineListRow;

  it("värst först; påfyllning går till Fyll på, fel till automatens sida", () => {
    const needs = machineNeeds([
      row("ok", "BL-4", status("ok", "I drift", false)),
      row("s", "BL-3", status("warning", "Fyll på snart", false), 0, 2),
      row("f", "BL-2", status("critical", "Fel", true, "fault")),
      row("a", "BL-1", status("critical", "Fyll på nu", true), 1),
      {
        ...row("p", "BL-5", status("critical", "Tom", true)),
        lifecycle: "planned",
      } as MachineListRow,
    ]);
    expect(needs.map((n) => [n.code, n.place, n.action.label, n.action.href])).toEqual([
      ["BL-1", "Sega gubben", "Fyll på", "/fyll-pa/a"],
      ["BL-2", "Automat BL-2", "Öppna", "/automater/bl-2"],
      ["BL-3", "Automat BL-3", "Fyll på", "/fyll-pa/s"],
    ]);
    expect(plain(needsHeadline(needs, 4))).toBe("2 automater behöver dig nu.");
    expect(plain(needsHeadline(needs.slice(2), 4))).toBe("1 automat behöver dig snart.");
    expect(needsHeadline([], 4)).toBe("Alla automater rullar.");
    expect(needsHeadline([], 0)).toBe("Inga automater ännu.");
  });
});
