import { describe, expect, it } from "vitest";

import type { AnalyticsOrder, TodoItem } from "@/analytics/todos";
import { addDays, keyMetrics, type IsoDate, type Period } from "@/domain";

import { homeHeadline } from "./headline";
import { appHref, carriedParams } from "./links";
import { alignedCompare, buildHomeModel, coverageOf, type HomeModelInput } from "./model";

const TODAY = "2026-11-02";
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

describe("alignedCompare", () => {
  it("tar samma dagar i jämförelseperioden som täckningen har i perioden", () => {
    expect(
      alignedCompare(
        { start: "2026-10-27", end: TODAY },
        { start: "2026-10-20", end: "2026-10-26" },
        { start: "2026-10-27", end: "2026-11-01" },
      ),
    ).toEqual({ start: "2026-10-20", end: "2026-10-25" });
  });
});

describe("buildHomeModel", () => {
  it("räknar på dagarna med data och jämför inte med en period före datan", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    expect(m.coverage).toEqual({ start: DATA_START, end: "2026-11-01" });
    expect(m.comparable).toBe(false);
    expect(m.compare).toBeNull();
    const revenue = m.kpis.find((k) => k.id === "revenue");
    // 20 dagar × (150 + 50 kr) + 3 × 150 kr
    expect(revenue?.value).toBe(20 * 20_000 + 3 * 15_000);
    expect(revenue?.delta).toBeNull();
    expect(revenue?.trend).toHaveLength(20);
    expect(m.headline.title).toBe("4 450 kr på 20 dagar.");
    expect(m.headline.aside).toMatch(/^Vinst .* efter alla kostnader, .* marginal\.$/);
  });

  it("tar vinsten från beräkningslagret och säger hur stor andel som saknar inköpspris", () => {
    const input = inputFor(THIRTY, THIRTY_BEFORE);
    const m = buildHomeModel(input);
    const km = keyMetrics({ ...input.current, period: m.coverage as Period });
    expect(m.kpis.find((k) => k.id === "profit")?.value).toBe(km.profitOre);
    expect(m.unpriced?.orders).toBe(20);
    expect(m.unpriced?.revenueOre).toBe(20 * 5_000);
    expect(m.unpriced?.href).toBe("/inkopspriser?titel=t2");
    expect(m.unpriced?.titles).toEqual([{ id: "t2", name: "White Flair" }]);
    expect(m.kpis.find((k) => k.id === "profit")?.alertText).toBe("Utan 22 % av intäkten");
    expect(m.topTitles.rows.map((r) => [r.id, r.unpriced])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
    expect(m.topTitles.rows.reduce((n, r) => n + r.shareBp, 0)).toBe(10_000);
  });

  it("markerar bästa dagen i dagserien", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    expect(m.daily?.dates[m.daily.peakIndex ?? -1]).toBe("2026-10-26");
    expect(m.daily?.compareOre).toBeNull();
  });

  it("jämför med lika många dagar före när de ligger inom datan", () => {
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
    expect(m.headline.aside).toBe("23 % bättre än perioden innan.");
    expect(m.headline.lead[0]).toMatch(/^Vinst /);
  });

  it("jämför en påbörjad dag utan order som om perioden slutade i går", () => {
    const period = { start: "2026-10-27", end: TODAY };
    const compare = { start: "2026-10-20", end: "2026-10-26" };
    const m = buildHomeModel(inputFor(period, compare));
    expect(m.coverage).toEqual({ start: "2026-10-27", end: "2026-11-01" });
    expect(m.compare).toEqual({ start: "2026-10-20", end: "2026-10-25" });
  });

  it("säger att det saknas order när datan saknas helt", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE, { dataStart: null }));
    expect(m.headline.state).toBe("no-data");
    expect(m.daily).toBeNull();
    expect(m.insights).toEqual([]);
  });

  it("ger iakttagelser med länkar inom appen, utan intäktssammanfattningen", () => {
    const m = buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE));
    expect(m.insights.length).toBeGreaterThan(0);
    expect(m.insights.length).toBeLessThanOrEqual(4);
    for (const i of m.insights) {
      expect(i.href.startsWith("/")).toBe(true);
      expect(i.href).not.toMatch(/fran=|till=|\/forsaljning|\/titlar/);
      expect(i.key.startsWith("period-summary")).toBe(false);
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
      evidence: { machineIds, titleIds: [], orderIds: [] } as unknown as TodoItem["evidence"],
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
    expect(m.todoCount).toBe(4);
    expect(m.todoNowCount).toBe(2);
    // Filter på automat m1: punkten för m2 faller bort, punkter utan automat står kvar.
    const scoped = buildHomeModel(
      inputFor(THIRTY, THIRTY_BEFORE, { todos, scope: { storeId: null, machineId: "m1" } }),
    );
    expect(scoped.todos?.map((t) => t.key)).toEqual(["b", "d", "a"]);
    expect(buildHomeModel(inputFor(THIRTY, THIRTY_BEFORE)).todos).toBeNull();
  });
});

describe("homeHeadline", () => {
  const base = {
    revenueOre: 7_998_700,
    orders: 460,
    profitOre: 2_193_300,
    marginBp: 2_880,
    unpricedShareBp: 478,
    revenueChangeBp: 1_200,
    coverage: { start: DATA_START, end: "2026-11-01" },
    period: THIRTY,
    today: TODAY,
    dataStart: DATA_START,
  };
  it("skriver intäkten, dagarna och förändringen", () => {
    const h = homeHeadline(base);
    expect(h.title).toBe("79 987 kr på 20 dagar.");
    expect(h.aside).toBe("12 % bättre än perioden innan.");
    expect(h.lead).toEqual(["Vinst 21 933 kr efter alla kostnader, 28,8 % marginal."]);
  });
  it("skriver förlust och sämre utan minustecken i ord", () => {
    const h = homeHeadline({ ...base, profitOre: -50_000, marginBp: -500, revenueChangeBp: -450 });
    expect(h.aside).toBe("4,5 % sämre än perioden innan.");
    expect(h.lead[0]).toMatch(/^Förlust 500 kr/);
  });
  it("säger i dag och i går för en enda dag", () => {
    expect(homeHeadline({ ...base, coverage: { start: TODAY, end: TODAY } }).title).toMatch(
      /i dag\.$/,
    );
    expect(
      homeHeadline({ ...base, coverage: { start: "2026-11-01", end: "2026-11-01" } }).title,
    ).toMatch(/i går\.$/);
  });
  it("säger när perioden ligger före första ordern", () => {
    const h = homeHeadline({
      ...base,
      orders: 0,
      coverage: null,
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
  });
});
