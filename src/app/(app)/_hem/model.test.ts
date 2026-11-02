import { describe, expect, it } from "vitest";

import type { AnalyticsOrder, TodoItem } from "@/analytics/todos";
import { addDays, keyMetrics, type IsoDate, type Period } from "@/domain";

import { homeHeadline } from "./headline";
import { appHref, carriedParams } from "./links";
import {
  buildHomeModel,
  coverageOf,
  emptyRefillsInScope,
  homeLostSales,
  type HomeModelInput,
} from "./model";

const TODAY = "2026-11-02";
/** Hårda mellanslag (tusental, före enhet) som vanliga, för läsbara förväntningar. */
const plain = (text: string | null | undefined) => text?.replace(/[\u00a0\u202f]/g, " ");
const NOW = "2026-11-02T09:00:00Z";
const DATA_START = "2026-10-13";

let seq = 0;
function order(
  titleId: string,
  date: IsoDate,
  amountOre = 15_000,
  machineId = "m1",
): AnalyticsOrder {
  seq++;
  return {
    id: `o${seq}`,
    externalId: `e${seq}`,
    titleId,
    machineId,
    businessDate: date,
    amountOre,
    orderedAt: `${date}T12:00:00Z`,
  };
}

/** Två order per dag (t1 med pris, t2 utan) från 13 okt. t.o.m. 1 nov., tre extra t1 den 26 okt. */
function seedOrders(): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (let d: IsoDate = DATA_START; d <= "2026-11-01"; d = addDays(d, 1)) {
    out.push(order("t1", d), order("t2", d, 5_000));
  }
  out.push(order("t1", "2026-10-26"), order("t1", "2026-10-26"), order("t1", "2026-10-26"));
  return out;
}

const SOURCES = {
  prices: [{ titleId: "t1", unitCostOre: 6_000, validFrom: "2026-01-01" }],
  agreements: [
    {
      storeId: "s1",
      validFrom: "2026-10-01",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: null,
    },
  ],
  placements: [{ machineId: "m1", storeId: "s1", from: "2026-10-01", to: null }],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
};

function inputFor(
  period: Period,
  compare: Period | null,
  extra: Partial<HomeModelInput> = {},
): HomeModelInput {
  const all = seedOrders();
  const within = (p: Period) =>
    all.filter((o) => o.businessDate >= p.start && o.businessDate <= p.end);
  return {
    current: { ...SOURCES, orders: within(period), period },
    previous: compare ? { ...SOURCES, orders: within(compare), period: compare } : null,
    sources: SOURCES,
    titles: [
      { id: "t1", name: "30th Celebration" },
      { id: "t2", name: "White Flair" },
    ].map((t) => ({ ...t, series: null, mergedIntoId: null, archived: false })),
    machines: [{ id: "m1", name: "Automat 1" }].map((m) => ({
      ...m,
      code: "BL-001",
      serial: null,
      storeId: "s1",
      activeFrom: "2026-10-01",
      activeTo: null,
      isExample: false,
      archived: false,
    })),
    period,
    compare,
    dataStart: DATA_START,
    today: TODAY,
    now: NOW,
    timeZone: "Europe/Stockholm",
    scope: { storeId: null, machineId: null },
    todos: null,
    ...extra,
  };
}

const THIRTY: Period = { start: "2026-10-04", end: TODAY };
const THIRTY_BEFORE: Period = { start: "2026-09-04", end: "2026-10-03" };

describe("coverageOf", () => {
  it("börjar vid första ordern och slutar i går när dagen saknar order", () => {
    expect(coverageOf(THIRTY, DATA_START, TODAY, false)).toEqual({
      start: DATA_START,
      end: "2026-11-01",
    });
    expect(coverageOf(THIRTY, DATA_START, TODAY, true)).toEqual({ start: DATA_START, end: TODAY });
  });
  it("är null utan data eller när perioden ligger före datan", () => {
    expect(coverageOf(THIRTY, null, TODAY, false)).toBeNull();
    expect(coverageOf({ start: TODAY, end: TODAY }, DATA_START, TODAY, false)).toBeNull();
  });
});

describe("buildHomeModel", () => {
  it("räknar nyckeltalen på hela perioden och jämför inte med en period före datan", () => {
    const input = inputFor(THIRTY, THIRTY_BEFORE);
    const m = buildHomeModel(input);
    expect(m.period).toEqual(THIRTY);
    expect(m.coverage).toEqual({ start: DATA_START, end: "2026-11-01" });
    expect(m.todayPending).toBe(true);
    expect(m.comparable).toBe(false);
    expect(m.compare).toBeNull();
    const revenue = m.kpis.find((k) => k.id === "revenue");
    // 20 dagar × (150 + 50 kr) + 3 × 150 kr
    expect(revenue?.value).toBe(20 * 20_000 + 3 * 15_000);
    expect(revenue?.delta).toBeNull();
    expect(revenue?.trend).toHaveLength(20);
    expect(plain(m.headline.title)).toBe("4 450 kr sedan 13 okt.");
    expect(m.headline.aside).toMatch(
      /^Vinst .* före återbetalningar och fasta kostnader, .* marginal, men .* saknar inköpspris och ingår inte\.$/,
    );
  });

  it("tar vinsten för hela perioden, som Lönsamhet, inklusive hyra för dagar utan order", () => {
    const rent = {
      ...SOURCES,
      agreements: [{ ...SOURCES.agreements[0]!, monthlyRentOre: 310_000 }],
    };
    const base = inputFor(THIRTY, THIRTY_BEFORE);
    const input: HomeModelInput = {
      ...base,
      current: { ...base.current, ...rent },
      sources: rent,
    };
    const m = buildHomeModel(input);
    const full = keyMetrics(input.current);
    const covered = keyMetrics({
      ...input.current,
      period: { start: DATA_START, end: "2026-11-01" },
      orders: input.current.orders,
    });
    expect(m.kpis.find((k) => k.id === "profit")?.value).toBe(full.profitOre);
    expect(m.kpis.find((k) => k.id === "margin")?.value).toBe(full.marginBp);
    // Hyran för 4–12 okt. och 2 nov. ingår: vinsten är lägre än för dagarna med order.
    expect(full.profitOre).toBeLessThan(covered.profitOre);
  });

  it("säger hur stor andel som saknar inköpspris, med en decimal", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    expect(m.unpriced?.orders).toBe(20);
    expect(m.unpriced?.revenueOre).toBe(20 * 5_000);
    expect(m.unpriced?.href).toBe("/inkopspriser?titel=t2");
    expect(m.unpriced?.titles).toEqual([{ id: "t2", name: "White Flair" }]);
    expect(plain(m.kpis.find((k) => k.id === "profit")?.alertText)).toBe(
      "22,5 % av intäkten saknar inköpspris",
    );
    expect(m.topTitles.rows.map((r) => [r.id, r.unpriced])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
    expect(m.topTitles.rows.reduce((n, r) => n + r.shareBp, 0)).toBe(10_000);
  });

  it("visar ingen vinst när ingen order har inköpspris", () => {
    const base = inputFor(THIRTY, THIRTY_BEFORE);
    const noPrices = { ...SOURCES, prices: [] };
    const m = buildHomeModel({
      ...base,
      current: { ...base.current, ...noPrices },
      sources: noPrices,
    });
    expect(m.kpis.find((k) => k.id === "profit")?.value).toBeNull();
    expect(m.kpis.find((k) => k.id === "margin")?.value).toBeNull();
    expect(m.headline.aside).toBe("Vinsten går inte att räkna förrän orderna har inköpspris.");
  });

  it("markerar titlar utan inköpspris även när de slagits ihop till övriga", () => {
    const orders: AnalyticsOrder[] = [];
    for (let i = 0; i < 11; i++) {
      for (let n = 0; n < 11 - i; n++) orders.push(order(`p${i}`, "2026-10-20", 10_000));
    }
    const prices = Array.from({ length: 10 }, (_, i) => ({
      titleId: `p${i}`,
      unitCostOre: 5_000,
      validFrom: "2026-01-01",
    }));
    const base = inputFor(THIRTY, THIRTY_BEFORE);
    const m = buildHomeModel({
      ...base,
      current: { ...base.current, prices, orders },
      sources: { ...SOURCES, prices },
    });
    expect(m.topTitles.rows).toHaveLength(8);
    expect(m.topTitles.rest?.titles).toBe(3);
    expect(m.topTitles.rest?.unpricedTitles).toBe(1);
    const total =
      m.topTitles.rows.reduce((n, r) => n + r.shareBp, 0) + (m.topTitles.rest?.shareBp ?? 0);
    expect(Math.abs(total - 10_000)).toBeLessThanOrEqual(5);
  });

  it("markerar bästa dagen i dagserien", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    expect(m.daily?.dates[m.daily.peakIndex ?? -1]).toBe("2026-10-26");
    expect(m.daily?.compareOre).toBeNull();
  });

  it("jämför med skalets jämförelseperiod när den ligger inom datan", () => {
    const period = { start: "2026-10-23", end: "2026-11-01" };
    const compare = { start: "2026-10-13", end: "2026-10-22" };
    const m = buildHomeModel(inputFor(period, compare));
    expect(m.comparable).toBe(true);
    expect(m.compare).toEqual(compare);
    const revenue = m.kpis.find((k) => k.id === "revenue");
    // 10 × 200 kr + 450 kr mot 10 × 200 kr
    expect(revenue?.delta).toBeCloseTo(0.225, 4);
    expect(m.kpis.find((k) => k.id === "margin")?.deltaKind).toBe("absolute");
    expect(m.daily?.compareOre).toHaveLength(10);
    expect(plain(m.headline.title)).toBe("2 450 kr på 10 dagar.");
    expect(plain(m.headline.aside)).toBe("23 % bättre än perioden innan.");
    expect(m.headline.lead[0]).toMatch(/^Vinst /);
  });

  it("jämför hela perioderna som skalet, även när i dag saknar order", () => {
    const period = { start: "2026-10-27", end: TODAY };
    const compare = { start: "2026-10-20", end: "2026-10-26" };
    const m = buildHomeModel(inputFor(period, compare));
    expect(m.compare).toEqual(compare);
    expect(m.coverage).toEqual({ start: "2026-10-27", end: "2026-11-01" });
    expect(m.todayPending).toBe(true);
    // 6 dagar × 200 kr mot 7 dagar × 200 kr + 450 kr (26 okt.)
    expect(m.kpis.find((k) => k.id === "revenue")?.delta).toBeCloseTo(
      (6 * 20_000) / (7 * 20_000 + 45_000) - 1,
      4,
    );
    expect(m.daily?.dates).toHaveLength(6);
    expect(m.daily?.compareOre).toHaveLength(6);
    expect(plain(m.headline.title)).toBe("1 200 kr på 7 dagar.");
  });

  it("säger att det saknas order när datan saknas helt", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE, { dataStart: null }));
    expect(m.headline.state).toBe("no-data");
    expect(m.daily).toBeNull();
    expect(m.insights).toEqual([]);
  });

  it("ritar inget diagram för en period utan order", () => {
    const period = { start: "2026-10-04", end: "2026-10-10" };
    const m = buildHomeModel(inputFor(period, null));
    expect(m.headline.state).toBe("no-orders");
    expect(m.daily).toBeNull();
    expect(m.insights).toEqual([]);
  });

  it("ger iakttagelser med länkar inom appen och upprepar inte det som står på sidan", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    expect(m.insights.length).toBeLessThanOrEqual(4);
    for (const i of m.insights) {
      expect(i.href.startsWith("/")).toBe(true);
      expect(i.href).not.toMatch(/fran=|till=|\/forsaljning|\/titlar/);
      expect(i.key).not.toMatch(/^(period-summary|top-title|best-day)/);
    }
  });

  it("visar de tre viktigaste punkterna i Att göra, nu först, och räknar alla", () => {
    const todo = (key: string, level: TodoItem["level"], machineIds: string[]): TodoItem => ({
      key,
      fingerprint: key,
      kind: "refill",
      level,
      urgency: 0,
      atStakeOre: null,
      daysLeft: null,
      title: key,
      detail: "",
      evidence: {
        machineIds,
        titleIds: [],
        orderIds: [],
        storeIds: [],
      } as unknown as TodoItem["evidence"],
      link: "/lager?automat=m1",
    });
    const todos = [
      todo("a", "later", []),
      todo("b", "now", ["m1"]),
      todo("c", "soon", ["m2"]),
      todo("d", "now", ["m1"]),
    ];
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE, { todos }));
    expect(m.todos?.map((t) => t.key)).toEqual(["b", "d", "c"]);
    expect(m.todos?.some((t) => t.orgWide)).toBe(false);
    expect(m.todoCount).toBe(4);
    expect(m.todoNowCount).toBe(2);
    // Filter på automat m1: punkten för m2 faller bort, punkter utan automat står kvar
    // och märks som att de gäller hela organisationen.
    const scoped = buildHomeModel(
      inputFor(THIRTY, THIRTY_BEFORE, { todos, scope: { storeId: null, machineId: "m1" } }),
    );
    expect(scoped.todos?.map((t) => [t.key, t.orgWide])).toEqual([
      ["b", false],
      ["d", false],
      ["a", true],
    ]);
    expect(buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE)).todos).toBeNull();
  });
});

describe("integration: Att göra, avtal och förlorad försäljning på Hem", () => {
  const item = (
    key: string,
    kind: TodoItem["kind"],
    ev: { machineIds?: string[]; storeIds?: string[] },
    link: string,
  ): TodoItem => ({
    key,
    fingerprint: key,
    kind,
    level: "soon",
    urgency: 0,
    atStakeOre: null,
    daysLeft: 10,
    title: key,
    detail: "",
    evidence: {
      rule: "r",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: ev.machineIds ?? [],
      storeIds: ev.storeIds ?? [],
      recipientIds: [],
      figures: [],
    },
    link,
  });

  it("punkter om en butik (avtal, rapport) följer butiksfiltret och behåller ankaret", () => {
    const todos = [
      item("contract:c1:2027-01-31", "contract", { storeIds: ["s1"] }, "/avtal#avtal-c1"),
      item("contract:c2:2027-01-31", "contract", { storeIds: ["s2"] }, "/avtal#avtal-c2"),
      item("report-review:2026-10", "report-review", {}, "/rapporter?manad=2026-10#granska"),
    ];
    const all = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE, { todos }));
    expect(all.todos?.map((t) => t.href)).toEqual([
      "/avtal#avtal-c1",
      "/avtal#avtal-c2",
      "/rapporter?manad=2026-10#granska",
    ]);
    const scoped = buildHomeModel(
      inputFor(THIRTY, THIRTY_BEFORE, { todos, scope: { storeId: "s1", machineId: null } }),
    );
    expect(scoped.todos?.map((t) => [t.key, t.orgWide])).toEqual([
      ["contract:c1:2027-01-31", false],
      ["report-review:2026-10", true],
    ]);
  });

  it("appHref behåller ankaret för Avtal, Rapporter och Drift", () => {
    expect(appHref("/avtal#avtal-c1")).toBe("/avtal#avtal-c1");
    expect(appHref("/rapporter?manad=2026-10#granska")).toBe("/rapporter?manad=2026-10#granska");
    expect(appHref("/drift/automat/m1")).toBe("/drift/automat/m1");
  });

  it("homeLostSales visar texten bara när något förlorats", () => {
    const summary = {
      period: { start: "2026-10-01", end: "2026-10-31" },
      lostRevenueOre: 320_000,
      lostGrossProfitOre: 120_000,
      lostUnitsMilli: 65_000,
      stockoutDayWeightBp: 40_000,
      text: "Slutsålt kostade ca 3 200 kr i oktober.",
      months: [],
      series: [
        {
          key: "refill:m1:t1",
          machineId: "m1",
          titleId: "t1",
          lostRevenueOre: 200_000,
          lostUnitsMilli: 40_000,
          ongoing: true,
          since: "2026-10-28",
        },
        {
          key: "refill:m2:t1",
          machineId: "m2",
          titleId: "t1",
          lostRevenueOre: 120_000,
          lostUnitsMilli: 25_000,
          ongoing: false,
          since: "2026-10-03",
        },
      ],
      scope: { storeId: null, machineId: null },
      href: "/prognos?from=2026-10-01&to=2026-10-31#forlorad-forsaljning",
    } as const;
    // I dag 1 nov.: perioden slutar i går, så "slut just nu" gäller.
    expect(homeLostSales(summary, "2026-11-01")).toEqual({
      text: "Slutsålt kostade ca 3 200 kr i oktober.",
      href: "/prognos?from=2026-10-01&to=2026-10-31#forlorad-forsaljning",
      lostRevenueOre: 320_000,
      ongoing: 1,
    });
    expect(homeLostSales({ ...summary, lostRevenueOre: 0 }, "2026-11-01")).toBeNull();
    expect(homeLostSales(null, "2026-11-01")).toBeNull();
  });

  it("homeLostSales räknar bara titlar som är slut nu och har kostat något", () => {
    const base = {
      period: { start: "2026-10-01", end: "2026-11-01" },
      lostRevenueOre: 10_000,
      lostGrossProfitOre: 0,
      lostUnitsMilli: 1_000,
      stockoutDayWeightBp: 10_000,
      text: "Slutsålt kostade ca 100 kr.",
      months: [],
      series: [
        {
          key: "refill:m1:t1",
          machineId: "m1",
          titleId: "t1",
          lostRevenueOre: 10_000,
          lostUnitsMilli: 1_000,
          ongoing: true,
          since: "2026-10-30",
        },
        // Slut men säljer inte: kostar inget och räknas inte.
        {
          key: "refill:m1:t2",
          machineId: "m1",
          titleId: "t2",
          lostRevenueOre: 0,
          lostUnitsMilli: 0,
          ongoing: true,
          since: "2026-10-01",
        },
      ],
      scope: { storeId: null, machineId: null },
      href: "/prognos#forlorad-forsaljning",
    } as const;
    expect(homeLostSales(base, "2026-11-02")?.ongoing).toBe(1);
    // En äldre period (september): pågår vid periodens slut, men det är inte "just nu".
    const sep = { ...base, period: { start: "2026-09-01", end: "2026-09-30" } };
    expect(homeLostSales(sep, "2026-11-02")?.ongoing).toBe(0);
    // Med Att göra: antalet påfyllningspunkter med saldo 0 (samma som Att göra visar).
    expect(homeLostSales(base, "2026-11-02", 3)?.ongoing).toBe(3);
    expect(homeLostSales(sep, "2026-11-02", 3)?.ongoing).toBe(0);
  });

  it("emptyRefillsInScope räknar påfyllningspunkter med saldo 0 i filtret, som Att göra", () => {
    const refill = (key: string, machineId: string, onHand: number): TodoItem =>
      ({
        key,
        fingerprint: key,
        kind: "refill",
        level: "now",
        urgency: 0,
        atStakeOre: null,
        daysLeft: 0,
        title: key,
        detail: "",
        evidence: {
          machineIds: [machineId],
          storeIds: [],
          figures: [{ key: "onHand", label: "I lager", value: onHand, unit: "packs" }],
        },
        link: "/lager",
      }) as unknown as TodoItem;
    const machines = inputFor({ start: "2026-10-01", end: "2026-10-31" }, null).machines;
    const todos = [refill("a", "m1", 0), refill("b", "m1", 2), refill("c", "m2", 0)];
    expect(emptyRefillsInScope(todos, { storeId: null, machineId: null }, machines)).toBe(2);
    expect(emptyRefillsInScope(todos, { storeId: null, machineId: "m1" }, machines)).toBe(1);
    expect(emptyRefillsInScope(todos, { storeId: "s1", machineId: null }, machines)).toBe(1);
  });
});

describe("homeHeadline", () => {
  const base = {
    revenueOre: 7_998_700,
    orders: 460,
    profitOre: 2_193_300,
    marginBp: 2_880,
    pricedOrders: 435,
    unpricedShareBp: 478,
    revenueChangeBp: 1_200,
    period: { start: "2026-10-13", end: "2026-11-01" },
    today: TODAY,
    dataStart: DATA_START,
  };
  it("skriver intäkten, dagarna och förändringen", () => {
    const h = homeHeadline(base);
    expect(h.title).toBe("79 987 kr på 20 dagar.");
    expect(h.aside).toBe("12 % bättre än perioden innan.");
    expect(h.lead).toEqual([
      "Vinst 21 933 kr före återbetalningar och fasta kostnader, 28,8 % marginal.",
    ]);
  });
  it("skriver förlust och sämre utan minustecken i ord", () => {
    const h = homeHeadline({ ...base, profitOre: -50_000, marginBp: -500, revenueChangeBp: -450 });
    expect(h.aside).toBe("4,5 % sämre än perioden innan.");
    expect(h.lead[0]).toMatch(/^Förlust 500 kr/);
  });
  it("säger i dag och i går för en enda dag", () => {
    expect(homeHeadline({ ...base, period: { start: TODAY, end: TODAY } }).title).toMatch(
      /i dag\.$/,
    );
    expect(
      homeHeadline({ ...base, period: { start: "2026-11-01", end: "2026-11-01" } }).title,
    ).toMatch(/i går\.$/);
  });
  it("säger sedan första ordern när datan börjar inne i perioden", () => {
    expect(plain(homeHeadline({ ...base, period: THIRTY, revenueChangeBp: null }).title)).toBe(
      "79 987 kr sedan 13 okt.",
    );
    expect(
      plain(homeHeadline({ ...base, period: { start: "2026-10-01", end: "2026-10-19" } }).title),
    ).toBe("79 987 kr 13–19 okt.");
  });
  it("säger att vinsten inte går att räkna utan inköpspris och nämner en stor andel utan", () => {
    const none = homeHeadline({
      ...base,
      pricedOrders: 0,
      profitOre: 0,
      marginBp: null,
      revenueChangeBp: null,
    });
    expect(none.aside).toBe("Vinsten går inte att räkna förrän orderna har inköpspris.");
    expect(none.aside).not.toMatch(/0 kr/);
    const many = homeHeadline({ ...base, unpricedShareBp: 3_500, revenueChangeBp: null });
    expect(plain(many.aside)).toBe(
      "Vinst 21 933 kr före återbetalningar och fasta kostnader, 28,8 % marginal, men 35,0 % av intäkten saknar inköpspris och ingår inte.",
    );
  });
  it("säger när perioden ligger före första ordern", () => {
    const h = homeHeadline({
      ...base,
      orders: 0,
      period: { start: "2026-09-01", end: "2026-09-30" },
    });
    expect(h.state).toBe("no-orders");
    expect(h.aside).toBe("Första ordern kom 13 okt.");
  });
});

describe("appHref", () => {
  it("översätter analysens länkar till panelens rutter och parametrar", () => {
    expect(appHref("/forsaljning?fran=2026-10-26&till=2026-10-26")).toBe(
      "/lonsamhet?from=2026-10-26&to=2026-10-26&grupp=dag",
    );
    expect(appHref("/forsaljning?fran=2026-10-13&till=2026-11-01&vy=veckodag")).toBe(
      "/lonsamhet?from=2026-10-13&to=2026-11-01&grupp=veckodag",
    );
    expect(
      appHref("/titlar/t1?fran=2026-10-13&till=2026-11-01", { storeId: "s1", machineId: null }),
    ).toBe("/lonsamhet?from=2026-10-13&to=2026-11-01&grupp=titel&titel=t1&butik=s1");
    expect(appHref("/automater/m1?fran=2026-10-13&till=2026-11-01")).toBe(
      "/automater/m1?from=2026-10-13&to=2026-11-01",
    );
  });
  it("lägger till titeln på länkar till Lönsamhet", () => {
    expect(
      appHref("/lonsamhet?grupp=titel&fran=2026-10-13&till=2026-11-01", null, { titel: "t1" }),
    ).toBe("/lonsamhet?grupp=titel&from=2026-10-13&to=2026-11-01&titel=t1");
  });
  it("skickar sammanslagning av titlar till Att göra", () => {
    expect(appHref("/titlar?slaihop=a&med=b")).toBe("/att-gora");
  });
  it("leder aldrig ut ur appen", () => {
    expect(appHref("https://evil.example/x")).toBe("/");
    expect(appHref("//evil.example/x")).toBe("/");
  });
  it("för vidare period och filter", () => {
    expect(carriedParams({ period: "7d", butik: "s1", annat: "x" }, { grupp: "dag" })).toBe(
      "?period=7d&butik=s1&grupp=dag",
    );
    expect(carriedParams({})).toBe("");
    expect(carriedParams({ period: "7d", automat: "m1" }, {}, false)).toBe("?period=7d");
  });
});
