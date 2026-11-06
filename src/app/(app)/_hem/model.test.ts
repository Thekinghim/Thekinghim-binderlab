import { describe, expect, it } from "vitest";

import type { AnalyticsOrder, TodoItem } from "@/analytics/todos";
import {
  addDays,
  buildLedger,
  keyMetrics,
  profitability,
  type IsoDate,
  type Period,
} from "@/domain";

import { homeExtraTodos } from "./extras";
import { homeHeadline } from "./headline";
import { appHref, carriedParams } from "./links";
import { kr } from "./text";
import {
  buildHomeModel,
  coverageOf,
  emptyRefillsInScope,
  homeLostSales,
  homeStaleImport,
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
  // Som laddaren utan vyknappen: vår vinst före butikernas andel.
  settings: { vatRateBp: 0, cardFeeBp: 0, deductStoreShare: false },
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
  it("börjar vid första ordern och slutar i går när perioden går fram till i dag", () => {
    expect(coverageOf(THIRTY, DATA_START, TODAY, false)).toEqual({
      start: DATA_START,
      end: "2026-11-01",
    });
    // Dagen pågår: den ritas inte som en hel dag fast den har order.
    expect(coverageOf(THIRTY, DATA_START, TODAY, true)).toEqual({
      start: DATA_START,
      end: "2026-11-01",
    });
  });
  it("visar dagen när perioden är just i dag och har order", () => {
    expect(coverageOf({ start: TODAY, end: TODAY }, DATA_START, TODAY, true)).toEqual({
      start: TODAY,
      end: TODAY,
    });
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
    // Vår vinst som stort tal (samma betydelse som Lönsamhet), intäkten bredvid. Butikens
    // andel (10 % provision) står inte som eget tal utan vyknappen.
    // Före butikens andel (10 % provision): 1 725 kr + 345 kr provision.
    expect(plain(m.headline.title)).toBe("Vår vinst 2 070 kr sedan 13 okt.");
    expect(plain(m.headline.aside)).toBe("Intäkt 4 450 kr.");
    expect(m.headline.split).toEqual([]);
    expect(m.hasStoreShare).toBe(true);
    expect(m.showStoreShare).toBe(false);
    expect(m.kpis.find((k) => k.id === "profit")?.parts).toEqual([]);
    // Samma period i ord som rubriken, för topplistan och slutsålt-raden.
    expect(plain(m.spanText)).toBe("sedan 13 okt.");
    expect(plain(m.headline.lead.join(" "))).toBe(
      "Före butikernas andel och fasta kostnader. 22,5 % saknar inköpspris.",
    );
  });

  it("utan fasta kostnader: ingen rad 'Före fasta kostnader' och nyckeltalet heter alltid Vår vinst", () => {
    const input = inputFor(THIRTY, THIRTY_BEFORE);
    const withCosts = buildHomeModel({ ...input, costLines: { rent: false, fixed: true } });
    const without = buildHomeModel({ ...input, costLines: { rent: false, fixed: false } });
    expect(plain(without.headline.lead.join(" "))).toBe(
      "Före butikernas andel. 22,5 % saknar inköpspris.",
    );
    expect(without.kpis.find((k) => k.id === "profit")?.label).toBe("Vår vinst");
    expect(withCosts.kpis.find((k) => k.id === "profit")?.label).toBe("Vår vinst");
    // Bara texten ändras: talen är desamma.
    expect(without.kpis.map((k) => k.value)).toEqual(withCosts.kpis.map((k) => k.value));
    expect(without.headline.title).toBe(withCosts.headline.title);
  });

  it("tar vinsten för hela perioden, som Lönsamhet, inklusive hyra för dagar utan order", () => {
    // Med vyknappen "Visa butikernas andel": hyran är en del av andelen och dras.
    const rent = {
      ...SOURCES,
      agreements: [{ ...SOURCES.agreements[0]!, monthlyRentOre: 310_000 }],
      settings: { ...SOURCES.settings, deductStoreShare: true },
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
    // Vår vinst som Lönsamhet, både i nyckeltalet och i delningen (butikens hyra och
    // provision är dragna).
    expect(m.profitSplit?.ourOre).toBe(full.profitOre);
    const totals = profitability(input.current, "title").totals;
    expect(m.kpis.find((k) => k.id === "profit")?.value).toBe(full.profitOre);
    expect(m.kpis.find((k) => k.id === "profit")?.label).toBe("Vår del");
    expect(m.profitSplit?.totalOre).toBe(full.profitOre + totals.compensationOre);
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
    expect(m.headline.aside).toBe("Lägg in inköpspris för vinsten.");
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
    expect(plain(m.headline.title)).toMatch(/^Vår vinst .* på 10 dagar\.$/);
    expect(plain(m.headline.aside)).toMatch(/(\+23 %|butikerna)/);
  });

  it("ritar inte dagen som pågår, men räknar den i nyckeltalen", () => {
    const input = inputFor(THIRTY, null);
    const withToday = {
      ...input,
      current: { ...input.current, orders: [...input.current.orders, order("t1", TODAY)] },
    };
    const m = buildHomeModel(withToday);
    expect(m.todayPartial).toBe(true);
    expect(m.todayPending).toBe(false);
    expect(m.coverage).toEqual({ start: DATA_START, end: "2026-11-01" });
    expect(m.daily?.dates.at(-1)).toBe("2026-11-01");
    // Snittet per dag räknas på hela dagar: dagens order ingår inte.
    const fullDays = buildHomeModel(input);
    expect(m.daily?.averageOre).toBe(fullDays.daily?.averageOre);
    expect(m.kpis.find((k) => k.id === "orders")?.value).toBe(
      (fullDays.kpis.find((k) => k.id === "orders")?.value ?? 0) + 1,
    );
  });

  it("säger att marginalen gäller order med inköpspris när några saknar pris", () => {
    const m = buildHomeModel(inputFor(THIRTY, null));
    expect(m.kpis.find((k) => k.id === "margin")?.note).toBe("på order med inköpspris");
    expect(m.kpis.find((k) => k.id === "revenue")?.note).toBeNull();
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
    // Samma dagar som diagrammet och övriga sidor: i dag räknas inte utan order.
    expect(plain(m.headline.title)).toMatch(/^Vår vinst .* på 6 dagar\.$/);
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
  it("skriver vinsten som det stora talet, med intäkten och förändringen bredvid", () => {
    const h = homeHeadline(base);
    expect(plain(h.title)).toBe("Vår vinst 21 933 kr på 20 dagar.");
    expect(h.figure).toMatchObject({ label: "Vår vinst", valueOre: 2_193_300, tone: "good" });
    expect(plain(h.aside)).toBe("Intäkt 79 987 kr, +12 %.");
    expect(h.lead).toEqual(["Före fasta kostnader."]);
    expect(h.split).toEqual([]);
  });
  it("utan fasta kostnader: ingen rad under rubriken", () => {
    expect(homeHeadline({ ...base, fixedCosts: false }).lead).toEqual([]);
  });
  it("rubriken är högst åtta ord", () => {
    const h = homeHeadline({ ...base, storesProfitOre: 693_300, showStoreShare: true });
    expect((plain(h.title) ?? "").split(" ").length).toBeLessThanOrEqual(8);
  });
  it("butikernas andel bara på begäran: vår vinst är talet, totalen och andelen under", () => {
    // Utan vyknappen: vår vinst och intäkten, ingen delning.
    const off = homeHeadline({ ...base, storesProfitOre: 693_300 });
    expect(plain(off.title)).toBe("Vår vinst 21 933 kr på 20 dagar.");
    expect(plain(off.aside)).toBe("Intäkt 79 987 kr, +12 %.");
    expect(off.split).toEqual([]);
    // Med vyknappen: vår del (efter andelen), totalen före andelen och andelen.
    const on = homeHeadline({ ...base, storesProfitOre: 693_300, showStoreShare: true });
    expect(plain(on.title)).toBe("Vår del 21 933 kr på 20 dagar.");
    expect(plain(on.aside)).toBe(
      "Totalt före butikernas andel 28 866 kr · butikernas andel 6 933 kr.",
    );
    expect(on.split).toEqual([
      { label: "Totalt före butikernas andel", valueOre: 2_886_600 },
      { label: "butikernas andel", valueOre: 693_300 },
    ]);
    // Vald butik: andelen dras alltid (modellen säger showStoreShare), för just den butiken.
    const store = homeHeadline({
      ...base,
      storesProfitOre: 693_300,
      filtered: true,
      showStoreShare: true,
    });
    expect(plain(store.aside)).toBe(
      "Totalt före butikens andel 28 866 kr · butikens andel 6 933 kr.",
    );
  });
  it("skriver förlust i rött och sämre med minustecken", () => {
    const h = homeHeadline({ ...base, profitOre: -50_000, marginBp: -500, revenueChangeBp: -450 });
    expect(plain(h.title)).toBe("Förlust 500 kr på 20 dagar.");
    expect(h.figure).toMatchObject({ valueOre: 50_000, tone: "bad" });
    expect(plain(h.aside)).toBe("Intäkt 79 987 kr, \u22124,5 %.");
  });
  it("räknar dagarna som övriga sidor: i dag bara med order i dag", () => {
    const week = { start: "2026-10-27", end: TODAY };
    expect(plain(homeHeadline({ ...base, period: week }).title)).toBe(
      "Vår vinst 21 933 kr på 6 dagar.",
    );
    expect(plain(homeHeadline({ ...base, period: week, hasOrdersToday: true }).title)).toBe(
      "Vår vinst 21 933 kr på 7 dagar.",
    );
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
      "Vår vinst 21 933 kr sedan 13 okt.",
    );
    expect(
      plain(homeHeadline({ ...base, period: { start: "2026-10-01", end: "2026-10-19" } }).title),
    ).toBe("Vår vinst 21 933 kr 13–\u206019 okt.");
  });
  it("visar intäkten när vinsten inte går att räkna, och nämner en stor andel utan pris", () => {
    const none = homeHeadline({
      ...base,
      pricedOrders: 0,
      profitOre: 0,
      marginBp: null,
      revenueChangeBp: null,
    });
    expect(plain(none.title)).toBe("Intäkt 79 987 kr på 20 dagar.");
    expect(none.figure?.tone).toBe("neutral");
    expect(none.aside).toBe("Lägg in inköpspris för vinsten.");
    expect(none.lead).toEqual([]);
    const many = homeHeadline({ ...base, unpricedShareBp: 3_500, revenueChangeBp: null });
    expect(plain(many.aside)).toBe("Intäkt 79 987 kr.");
    expect(plain(many.lead.join(" "))).toBe("Före fasta kostnader. 35,0 % saknar inköpspris.");
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
      "/lonsamhet?from=2026-10-26&to=2026-10-26&per=dag",
    );
    expect(appHref("/forsaljning?fran=2026-10-13&till=2026-11-01&vy=veckodag")).toBe(
      "/lonsamhet?from=2026-10-13&to=2026-11-01&per=dag",
    );
    expect(
      appHref("/titlar/t1?fran=2026-10-13&till=2026-11-01", { storeId: "s1", machineId: null }),
    ).toBe("/lonsamhet?from=2026-10-13&to=2026-11-01&titel=t1&butik=s1&vy=titel");
    expect(appHref("/automater/m1?fran=2026-10-13&till=2026-11-01")).toBe(
      "/automater/m1?from=2026-10-13&to=2026-11-01",
    );
  });
  it("lägger till titeln på länkar till Lönsamhet", () => {
    expect(
      appHref("/lonsamhet?grupp=titel&fran=2026-10-13&till=2026-11-01", null, { titel: "t1" }),
    ).toBe("/lonsamhet?from=2026-10-13&to=2026-11-01&titel=t1&vy=titel");
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

describe("homeStaleImport", () => {
  const sync = (syncedAt: string | null) => ({ syncedAt, state: "ok" as const, sources: 1 });
  const TZ = "Europe/Stockholm";

  it("är null utan import eller utan synkinfo", () => {
    expect(homeStaleImport(null, TODAY, NOW, TZ)).toBeNull();
    expect(homeStaleImport(sync(null), TODAY, NOW, TZ)).toBeNull();
  });

  it("är null när senaste importen är färsk (inom 26 h)", () => {
    expect(homeStaleImport(sync("2026-11-01T08:00:00Z"), TODAY, NOW, TZ)).toBeNull();
  });

  it("ger affärsdagen för en gammal import", () => {
    // 23:30 UTC 28 okt. är 29 okt. i Stockholm (CET).
    expect(homeStaleImport(sync("2026-10-28T23:30:00Z"), TODAY, NOW, TZ)).toEqual({
      date: "2026-10-29",
    });
  });

  it("är null när perioden slutade före importen (perioden är komplett)", () => {
    expect(homeStaleImport(sync("2026-10-28T10:00:00Z"), "2026-10-27", NOW, TZ)).toBeNull();
    expect(homeStaleImport(sync("2026-10-28T10:00:00Z"), "2026-10-28", NOW, TZ)).toEqual({
      date: "2026-10-28",
    });
  });
});

describe("hela vinsten på Hem", () => {
  // Två butiker: s1 vinstdelning 50 % (VMB dras före delningen), s2 provision 10 % + hyra.
  const PERIOD: Period = { start: "2026-10-01", end: "2026-10-31" };
  const agreements = [
    {
      storeId: "s1",
      validFrom: "2026-10-01",
      validTo: null,
      commissionBp: 5_000,
      monthlyRentOre: null,
      commissionBase: "profit_after_costs" as const,
      lossTreatment: "zero" as const,
      vmbBeforeSplit: true,
    },
    {
      storeId: "s2",
      validFrom: "2026-10-01",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: 50_000,
    },
  ];
  const placements = [
    { machineId: "m1", storeId: "s1", from: "2026-10-01", to: null },
    { machineId: "m2", storeId: "s2", from: "2026-10-01", to: null },
  ];
  const orders: AnalyticsOrder[] = [];
  for (let d: IsoDate = "2026-10-13"; d <= "2026-10-31"; d = addDays(d, 1)) {
    orders.push(order("t1", d, 15_000, "m1"), order("t1", d, 15_000, "m2"));
    orders.push(order("t2", d, 9_900, "m1"));
  }
  const machines = [
    { id: "m1", storeId: "s1" },
    { id: "m2", storeId: "s2" },
  ].map((m) => ({
    ...m,
    name: m.id,
    code: m.id.toUpperCase(),
    serial: null,
    activeFrom: "2026-10-01",
    activeTo: null,
    isExample: false,
    archived: false,
  }));
  const prices = [
    { titleId: "t1", unitCostOre: 6_000, validFrom: "2026-01-01" },
    { titleId: "t2", unitCostOre: 4_000, validFrom: "2026-01-01" },
  ];

  /** Indata som loadDomainInputFor bygger den: urval på butiken, VMB-momsen organisationens. */
  function inputs(vmb: boolean, storeId: string | null, share = false) {
    // Som laddaren: andelen dras med vyknappen eller vald butik.
    const settings = {
      vatRateBp: 0,
      cardFeeBp: 150,
      vmb,
      deductStoreShare: share || storeId !== null,
    };
    const org = { prices, agreements, placements, settings, orders, period: PERIOD };
    if (!storeId) return { org, scoped: org };
    const vmbByOrder = new Map(
      buildLedger(org)
        .entries.filter((e) => e.vmbVatOre !== 0)
        .map((e) => [e.order.id, e.vmbVatOre] as const),
    );
    const mine = new Set(placements.filter((p) => p.storeId === storeId).map((p) => p.machineId));
    const scoped = {
      ...org,
      agreements: agreements.filter((a) => a.storeId === storeId),
      placements: placements.filter((p) => p.storeId === storeId),
      orders: orders.filter((o) => o.machineId !== null && mine.has(o.machineId)),
      ...(vmb ? { vmbByOrder } : {}),
    };
    return { org, scoped };
  }

  function home(vmb: boolean, storeId: string | null, showStoreShare = false) {
    const { org, scoped } = inputs(vmb, storeId, showStoreShare);
    const sources = {
      prices: scoped.prices,
      agreements: scoped.agreements,
      placements: scoped.placements,
      settings: scoped.settings,
    };
    const m = buildHomeModel({
      ...inputFor(PERIOD, null),
      current: scoped,
      previous: null,
      sources,
      machines,
      period: PERIOD,
      dataStart: "2026-10-13",
      scope: { storeId, machineId: null },
      ...(storeId ? { storeName: `Butik ${storeId}` } : {}),
    });
    return { m, org };
  }

  for (const vmb of [false, true]) {
    it(`alla butiker${vmb ? ", med VMB" : ""}: vår vinst före butikernas andel, vår del med vyknappen`, () => {
      const { m, org } = home(vmb, null);
      const lons = profitability(org, "store");
      const t = lons.totals;
      const profit = m.kpis.find((k) => k.id === "profit")!;
      // Standard: vår vinst = vinsten före butikernas andel (som Lönsamhet utan vyknappen).
      expect(m.showStoreShare).toBe(false);
      expect(m.profitSplit).toEqual({
        totalOre: t.profitBeforeShareOre,
        ourOre: t.profitBeforeShareOre,
        storesOre: t.compensationOre,
      });
      expect(profit).toMatchObject({ label: "Vår vinst", value: t.profitBeforeShareOre });
      expect(profit.parts).toEqual([]);
      expect(m.kpis.find((k) => k.id === "margin")).toMatchObject({
        label: "Vår marginal",
        value: t.marginBeforeShareBp,
      });
      // Med vyknappen: vår del efter butikernas andel, totalen och andelen under talet.
      const on = home(vmb, null, true).m;
      expect(on.showStoreShare).toBe(true);
      expect(on.kpis.find((k) => k.id === "profit")).toMatchObject({
        label: "Vår del",
        value: t.profitAfterShareOre,
        parts: [
          { id: "total", label: "Totalt före andel", value: t.profitBeforeShareOre },
          { id: "stores", label: "Butikernas andel", value: t.compensationOre },
        ],
      });
      expect(on.kpis.find((k) => k.id === "margin")?.value).toBe(t.marginAfterShareBp);
      // Butiker: raderna summerar till samma delar.
      const rows = lons.rows.filter((r) => r.kind === "item");
      expect(rows.reduce((n, r) => n + r.profitBeforeShareOre, 0)).toBe(t.profitBeforeShareOre);
      expect(t.profitAfterShareOre).toBe(t.profitBeforeShareOre - t.compensationOre);
      expect(t.vmbVatOre > 0).toBe(vmb);
    });

    for (const storeId of ["s1", "s2"]) {
      it(`butik ${storeId}${vmb ? ", med VMB" : ""}: vald butik drar sin andel, som butikens rad`, () => {
        const { m, org } = home(vmb, storeId);
        const row = profitability(org, "store").rows.find((r) => r.key === storeId)!;
        expect(row.compensationOre).toBeGreaterThan(0);
        expect(m.profitSplit).toEqual({
          totalOre: row.profitBeforeShareOre,
          ourOre: row.profitAfterShareOre,
          storesOre: row.compensationOre,
        });
        // Vald butik: andelen dras utan vyknappen, med butikens namn och villkor.
        const profit = m.kpis.find((k) => k.id === "profit")!;
        expect(profit).toMatchObject({ label: "Vår del", value: row.profitAfterShareOre });
        expect(profit.parts?.[0]).toEqual({
          id: "total",
          label: "Totalt före andel",
          value: row.profitBeforeShareOre,
        });
        expect(profit.parts?.[1]).toMatchObject({ id: "stores", value: row.compensationOre });
        expect(profit.parts?.[1]?.label).toMatch(new RegExp(`^Butik ${storeId} `));
      });
    }
  }

  it("med VMB dras VMB-momsen från hela vinsten (avtalet avgör vems del som bär den)", () => {
    const off = home(false, null).m.profitSplit!;
    const on = home(true, null);
    const vmb = profitability(on.org, "title").totals.vmbVatOre;
    expect(vmb).toBeGreaterThan(0);
    expect(on.m.profitSplit!.totalOre).toBe(off.totalOre - vmb);
    // s1 drar VMB före delningen i båda lägena: butikens del ändras inte av vyknappen.
    expect(on.m.profitSplit!.storesOre).toBe(off.storesOre);
    expect(on.m.kpis.find((k) => k.id === "profit")?.note).toBe("efter VMB-moms");
  });

  it("rubriken säger vår vinst före andelen; vår del, totalen och andelen med vyknappen", () => {
    const { m } = home(false, null);
    const s = m.profitSplit!;
    expect(plain(m.headline.title)).toMatch(new RegExp(`^Vår vinst ${plain(kr(s.ourOre))} `));
    expect(s.ourOre).toBe(s.totalOre);
    expect(plain(m.headline.aside)).not.toMatch(/andel/);
    // Raden under: vinsten är före butikernas andel.
    expect(m.headline.lead.join(" ")).toMatch(/Före butikernas andel/);
    const on = home(false, null, true).m;
    const so = on.profitSplit!;
    expect(so.ourOre).toBe(so.totalOre - so.storesOre);
    expect(plain(on.headline.title)).toMatch(new RegExp(`^Vår del ${plain(kr(so.ourOre))} `));
    expect(plain(on.headline.aside)).toBe(
      plain(
        `Totalt före butikernas andel ${kr(so.totalOre)} · Butikernas andel ${kr(so.storesOre)}.`,
      ),
    );
  });

  it("automatfilter med vyknappen: andelen heter butikens (en butik), som på Lönsamhet", () => {
    // Skalet lägger till automatens butik (?automat=m1&butik=s1); det är inget val av butik,
    // så andelen dras bara med vyknappen, men det är EN butiks andel.
    const { scoped } = inputs(false, "s1", true);
    const m = buildHomeModel({
      ...inputFor(PERIOD, null),
      current: scoped,
      previous: null,
      sources: {
        prices: scoped.prices,
        agreements: scoped.agreements,
        placements: scoped.placements,
        settings: scoped.settings,
      },
      machines,
      period: PERIOD,
      dataStart: "2026-10-13",
      scope: { storeId: "s1", machineId: "m1" },
    });
    expect(m.showStoreShare).toBe(true);
    const profit = m.kpis.find((k) => k.id === "profit")!;
    expect(profit.parts?.[1]?.label).toBe("Butikens andel");
    expect(plain(m.headline.aside)).toMatch(/^Totalt före butikens andel .* · Butikens andel /);
  });
});

describe("Hem: en källa för Att göra och samma period i alla rutor", () => {
  const rule = (key: string, level: TodoItem["level"]): TodoItem =>
    ({
      key,
      fingerprint: key,
      kind: "contract",
      level,
      urgency: 0,
      atStakeOre: null,
      daysLeft: null,
      title: key,
      detail: "",
      evidence: { machineIds: [], titleIds: [], orderIds: [], storeIds: [] },
      link: "/avtal",
    }) as unknown as TodoItem;

  it("räknar bokföringen och nya automater som menyn och Att göra, och visar dem", () => {
    const todos = [rule("contract:c1", "soon"), rule("payout:s1", "later")];
    const extraTodos = homeExtraTodos({ bokforingMonth: "2026-10", newMachines: 0 });
    expect(extraTodos).toEqual([
      {
        key: "bokforing",
        level: "soon",
        title: "Ladda ner bokföringen för oktober 2026",
        href: "/ekonomi?vy=bokforing",
      },
    ]);
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE, { todos, extraTodos }));
    // Menyn: 2 punkter + bokföringen = 3; Hem säger samma.
    expect(m.todoCount).toBe(3);
    expect(m.todos?.map((t) => t.key)).toEqual(["bokforing", "contract:c1", "payout:s1"]);
    expect(m.todos?.[0]?.href).toBe("/ekonomi?vy=bokforing");
    // Ny automat gäller nu och står först.
    const found = buildHomeModel(
      inputFor(THIRTY, THIRTY_BEFORE, {
        todos,
        extraTodos: homeExtraTodos({ bokforingMonth: "2026-10", newMachines: 2 }),
      }),
    );
    expect(found.todoCount).toBe(4);
    expect(found.todoNowCount).toBe(1);
    expect(found.todos?.[0]).toMatchObject({
      key: "new-machines",
      level: "now",
      href: "/att-gora",
    });
  });

  it("slutsålt-raden och topplistan säger samma period som rubriken", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    // Perioden börjar 4 okt. men datan 13 okt.: rubriken säger "sedan 13 okt.".
    expect(plain(m.headline.title)).toMatch(/sedan 13 okt\.$/);
    const lost = homeLostSales(
      {
        period: THIRTY,
        lostRevenueOre: 290_000,
        lostGrossProfitOre: 0,
        lostUnitsMilli: 0,
        stockoutDayWeightBp: 0,
        text: "Slutsålt kostade ca 2 900 kr 4 okt. – 1 nov.",
        months: [],
        series: [],
        scope: { storeId: null, machineId: null },
        href: "/prognos",
      },
      TODAY,
      null,
      m.spanText,
    );
    expect(plain(lost?.text)).toBe("Slutsålt kostade ca 2 900 kr sedan 13 okt.");
  });
});
