import { describe, expect, it } from "vitest";

import type { OrderLine, ProfitabilityInput } from "@/domain";
import type { MachineRecord, StoreRecord, TitleRecord } from "@/server/data/core/types";

import { lonsamhetHeadline, sentence, shareOfProfitText, trendTitle, viewTitle } from "./headline";
import { buildLonsamhetModel, priceHref, type LonsamhetInput } from "./model";
import {
  canonicalLonsamhetQuery,
  parseTitleParam,
  parseTrendParam,
  parseViewParam,
} from "./params";

const NBSP = " ";

function title(id: string, name: string): TitleRecord {
  return { id, name, series: null, mergedIntoId: null, archived: false };
}
function machine(id: string, code: string, name: string, storeId: string): MachineRecord {
  return {
    id,
    code,
    name,
    serial: null,
    storeId,
    isExample: false,
    archived: false,
    activeFrom: null,
    activeTo: null,
  };
}
function store(id: string, name: string): StoreRecord {
  return {
    id,
    name,
    address: null,
    contactName: null,
    email: null,
    phone: null,
    isExample: false,
    archived: false,
  };
}

let seq = 0;
function orders(
  n: number,
  o: { titleId: string; machineId: string | null; date: string; amountOre: number },
): OrderLine[] {
  return Array.from({ length: n }, () => {
    seq += 1;
    return { id: `o${seq}`, externalId: String(seq), businessDate: o.date, ...o };
  });
}

const SCOPE = { storeId: null, machineId: null };

/** docs/berakningar.md avsnitt 5: titel B och C saknar pris, 61,0 % av intäkten. */
function docExample(): LonsamhetInput {
  const current: ProfitabilityInput = {
    period: { start: "2026-11-01", end: "2026-11-30" },
    orders: [
      ...orders(4, { titleId: "A", machineId: "m1", date: "2026-11-05", amountOre: 4900 }),
      ...orders(3, { titleId: "B", machineId: "m1", date: "2026-11-06", amountOre: 5900 }),
      ...orders(1, { titleId: "C", machineId: "m1", date: "2026-11-07", amountOre: 12900 }),
    ],
    prices: [{ titleId: "A", unitCostOre: 2000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 1000,
        monthlyRentOre: 10000,
      },
    ],
    placements: [{ machineId: "m1", storeId: "s1", from: "2026-01-01", to: null }],
    settings: { vatRateBp: 0, cardFeeBp: 0 },
  };
  return {
    current,
    previous: null,
    titles: [title("A", "Titel A"), title("B", "Titel B"), title("C", "Titel C")],
    machines: [machine("m1", "BL-001", "Automat 1", "s1")],
    stores: [store("s1", "Butik 1")],
    scope: SCOPE,
  };
}

/** Två automater i två butiker utan hyra: 12 respektive 13 order à 49 kr, inköp 20 kr. */
function twoMachines(previous = false): LonsamhetInput {
  const base = {
    prices: [{ titleId: "A", unitCostOre: 2000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 1000,
        monthlyRentOre: null,
      },
      {
        storeId: "s2",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 1000,
        monthlyRentOre: null,
      },
    ],
    placements: [
      { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
      { machineId: "m2", storeId: "s2", from: "2026-01-01", to: null },
    ],
    settings: { vatRateBp: 0, cardFeeBp: 0 },
  };
  const current: ProfitabilityInput = {
    ...base,
    period: { start: "2026-10-13", end: "2026-11-01" },
    orders: [
      ...orders(12, { titleId: "A", machineId: "m1", date: "2026-10-20", amountOre: 4900 }),
      ...orders(13, { titleId: "A", machineId: "m2", date: "2026-10-28", amountOre: 4900 }),
    ],
  };
  const prev: ProfitabilityInput = {
    ...base,
    period: { start: "2026-09-23", end: "2026-10-12" },
    orders: orders(20, { titleId: "A", machineId: "m1", date: "2026-10-01", amountOre: 4900 }),
  };
  return {
    current,
    previous: previous ? prev : null,
    titles: [title("A", "Titel A")],
    machines: [
      machine("m1", "BL-001", "Automat 1", "s1"),
      machine("m2", "BL-002", "Automat 2", "s2"),
    ],
    stores: [store("s1", "Butik 1"), store("s2", "Butik 2")],
    scope: SCOPE,
  };
}

describe("shareOfProfitText", () => {
  it("skriver bråk i ord när andelen ligger nära", () => {
    expect(shareOfProfitText(5000)).toBe("hälften av vinsten");
    expect(shareOfProfitText(4800)).toBe("nästan hälften av vinsten");
    expect(shareOfProfitText(5400)).toBe("drygt hälften av vinsten");
    expect(shareOfProfitText(3300)).toBe("en tredjedel av vinsten");
    expect(shareOfProfitText(7400)).toBe("tre fjärdedelar av vinsten");
    expect(shareOfProfitText(9600)).toBe("nästan hela vinsten");
    expect(shareOfProfitText(10_000)).toBe("hela vinsten");
    expect(shareOfProfitText(12_000)).toBe("mer än hela vinsten");
  });

  it("skriver procent när inget bråk ligger nära", () => {
    expect(shareOfProfitText(4200)).toBe(`42${NBSP}% av vinsten`);
    expect(shareOfProfitText(1200)).toBe(`12${NBSP}% av vinsten`);
  });
});

describe("lonsamhetHeadline", () => {
  const base = {
    days: 30,
    orders: 10,
    pricedOrders: 10,
    profitOre: 31_400,
    marginBp: 3140,
    revenueOre: 100_000,
    costOre: 40_000,
    feesOre: 0,
    compensationOre: 28_600,
    unpricedShareBp: 0,
    top: { name: "Automat 1", profitOre: 15_000, shareOfProfitBp: 4777 },
    previous: null,
  };

  it("svarar med andel kvar och största bidragsgivaren", () => {
    expect(lonsamhetHeadline(base)).toEqual({
      kind: "profit",
      title: `Ni behöll 31,4${NBSP}% av intäkten.`,
      aside: "Automat 1 står för nästan hälften av vinsten.",
    });
  });

  it("säger 'med inköpspris' när en del av intäkten saknar pris", () => {
    expect(lonsamhetHeadline({ ...base, unpricedShareBp: 480 }).title).toBe(
      `Ni behöll 31,4${NBSP}% av intäkten med inköpspris.`,
    );
  });

  it("jämför med perioden innan när ingen bidragsgivare finns", () => {
    const h = lonsamhetHeadline({
      ...base,
      top: null,
      previous: { profitOre: 28_000, marginBp: 3000 },
    });
    expect(h.aside).toBe(`Vinsten är 12${NBSP}% högre än perioden innan.`);
  });

  it("namnger förlusten och den största kostnaden", () => {
    const h = lonsamhetHeadline({ ...base, profitOre: -12_000, marginBp: -1200, top: null });
    expect(h.kind).toBe("loss");
    expect(h.title).toBe(`Förlust 120${NBSP}kr på 30${NBSP}dagar.`);
    expect(h.aside).toBe(`Inköpen tog 40,0${NBSP}% av intäkten.`);
  });

  it("utan order och utan priser", () => {
    expect(lonsamhetHeadline({ ...base, orders: 0, pricedOrders: 0 }).kind).toBe("empty");
    const np = lonsamhetHeadline({ ...base, pricedOrders: 0 });
    expect(np.title).toBe("Vinsten går inte att räkna.");
    expect(np.aside).toBe(`Ingen av de 10${NBSP}orderna har inköpspris.`);
  });
});

describe("sentence", () => {
  it("lägger inte till punkt efter en förkortning", () => {
    expect(sentence("Inga order under 1–30 nov.")).toBe("Inga order under 1–30 nov.");
    expect(sentence("Inga order för BL-001")).toBe("Inga order för BL-001.");
  });
});

describe("viewTitle och trendTitle", () => {
  it("namnger den bästa posten och antalet med förlust", () => {
    const t = viewTitle({
      noun: "titel",
      plural: "titlar",
      definite: "titeln",
      items: 5,
      top: { name: "Black Bolt", profitOre: 771_900, marginBp: 2920 },
      losses: 2,
    });
    expect(t.title).toBe("Black Bolt gav mest vinst.");
    expect(t.aside).toBe(`7${NBSP}719${NBSP}kr, 29,2${NBSP}% marginal. 2 titlar gick med förlust.`);
  });

  it("ger bästa och senaste hela veckan, utan snitt", () => {
    const t = trendTitle({
      unit: "vecka",
      buckets: 3,
      best: { name: "vecka 44", profitOre: 949_500 },
      latestFull: { profitOre: 710_000 },
      losses: 1,
    });
    expect(t.aside).toBe(
      `Bäst var vecka 44 med 9${NBSP}495${NBSP}kr. Senaste hela veckan gav 7${NBSP}100${NBSP}kr. 1 vecka med förlust.`,
    );
    const m = trendTitle({
      unit: "månad",
      buckets: 2,
      best: { name: "oktober", profitOre: 100_000 },
      latestFull: null,
      losses: 2,
    });
    expect(m.aside).toBe(`Bäst var oktober med 1${NBSP}000${NBSP}kr. 2 månader med förlust.`);
  });
});

describe("buildLonsamhetModel", () => {
  it("räknar exemplet i docs/berakningar.md: förlust och 61,0 % utan pris", () => {
    const m = buildLonsamhetModel(docExample(), { today: "2026-11-30", carry: "period=manad" });
    expect(m.totals.profitOre).toBe(-360);
    expect(m.unpriced.shareBp).toBe(6096);
    expect(m.headline.kind).toBe("loss");
    expect(m.headline.title).toBe(`Förlust 4${NBSP}kr på 30${NBSP}dagar.`);
    expect(m.kpis[0]).toMatchObject({ id: "profit", label: "Förlust", value: -360, delta: null });

    // Vattenfallet summerar till vinsten.
    const b = m.bridge;
    expect(b.revenueOre - b.costOre - b.feesOre - b.compensationOre).toBe(b.profitOre);
    expect(b.unpricedRevenueOre).toBe(30_600);

    // Titlar utan pris har länk till inköpspriset med periodens parametrar.
    expect(m.unpriced.titles.map((t) => t.name)).toEqual(["Titel B", "Titel C"]);
    expect(m.unpriced.titles[0]?.href).toBe("/inkopspriser?titel=B&period=manad#titel");
    const rowB = m.views.title.find((r) => r.key === "B");
    expect(rowB?.priceHref).toBe("/inkopspriser?titel=B&period=manad#titel");
    expect(m.views.title.find((r) => r.key === "A")?.priceHref).toBeNull();

    // Raderna summerar till totalen i varje vy, även med ej fördelad hyra.
    for (const view of ["title", "machine", "store"] as const) {
      const sum = m.views[view].reduce((s, r) => s + r.profitOre, 0);
      expect(sum).toBe(m.totals.profitOre);
    }
    const unallocated = m.views.title.find((r) => r.kind === "unallocated");
    expect(unallocated).toMatchObject({ name: "Ej fördelad hyra", profitOre: -6096 });
  });

  it("svarar 'Automat 1 står för nästan hälften av vinsten' med två automater", () => {
    const m = buildLonsamhetModel(twoMachines(true), { today: "2026-11-02" });
    expect(m.headline).toEqual({
      kind: "profit",
      title: `Ni behöll 49,2${NBSP}% av intäkten.`,
      aside: "Automat 2 står för drygt hälften av vinsten.",
    });
    expect(m.viewTitles.machine.title).toBe("Automat 2 gav mest vinst.");
    expect(m.comparisonLabel).toBe(`Jämfört med 23${NBSP}sep.${NBSP}–\u2060${NBSP}12${NBSP}okt.`);
    // 25 order nu mot 20 före: +25 %.
    expect(m.kpis.find((k) => k.id === "orders")?.delta).toBeCloseTo(0.25);
    expect(m.kpis.find((k) => k.id === "margin")?.delta).toBe(0);
    expect(m.periodLabel).toBe(`13${NBSP}okt.${NBSP}–\u2060${NBSP}1${NBSP}nov.`);
    expect(m.days).toBe(20);
  });

  it("delar perioden i veckor och månader som summerar till vinsten", () => {
    const m = buildLonsamhetModel(twoMachines(), { today: "2026-11-02" });
    const weeks = m.trend.week.buckets;
    expect(weeks.map((w) => w.axis)).toEqual(["V42", "V43", "V44"]);
    expect(weeks[0]).toMatchObject({ partial: true, start: "2026-10-13", end: "2026-10-18" });
    expect(weeks[0]?.name).toBe(`Vecka 42 · 13–\u206018${NBSP}okt.`);
    const weekSum = weeks.reduce((s, w) => s + w.profitOre, 0) + m.trend.week.unallocatedProfitOre;
    expect(weekSum).toBe(m.totals.profitOre);
    const months = m.trend.month.buckets;
    expect(months.map((b) => b.shortName)).toEqual(["oktober", "november"]);
    expect(months.reduce((s, b) => s + b.profitOre, 0)).toBe(m.totals.profitOre);
    expect(m.defaultTrend).toBe("week");
    expect(m.trend.week.heading.title).toBe("Vinst och marginal per vecka.");
    // Ingen "Snitt": delvisa veckor skulle dra ned det.
    expect(m.trend.week.heading.aside).not.toMatch(/Snitt/);
    expect(m.trend.week.heading.aside).toMatch(/^Bäst var vecka \d+ med /);

    // Per dag: en stapel per dag i perioden, och summan går ihop med ej fördelad hyra.
    const days = m.trend.day.buckets;
    expect(days).toHaveLength(20);
    expect(days.every((d) => !d.partial)).toBe(true);
    const daySum = days.reduce((s, d) => s + d.profitOre, 0) + m.trend.day.unallocatedProfitOre;
    expect(daySum).toBe(m.totals.profitOre);
  });

  it("utan order", () => {
    const input = twoMachines();
    const m = buildLonsamhetModel(
      { ...input, current: { ...input.current, orders: [] } },
      { today: "2026-11-02" },
    );
    expect(m.orders).toBe(0);
    expect(m.headline.kind).toBe("empty");
    expect(m.views.title).toEqual([]);

    // Rubriken säger ett faktum: när den senaste ordern kom.
    const one = buildLonsamhetModel(
      {
        ...input,
        current: {
          ...input.current,
          period: { start: "2026-11-02", end: "2026-11-02" },
          orders: [],
        },
      },
      { today: "2026-11-02", lastOrderDate: "2026-11-01" },
    );
    expect(one.headline.title).toBe(`Inga order 2${NBSP}nov.`);
    expect(one.headline.aside).toBe(`Senaste ordern kom 1${NBSP}nov.`);
  });
});

describe("parametrar och länkar", () => {
  it("tolkar ?vy= och ?per=", () => {
    expect(parseViewParam("automat")).toBe("machine");
    expect(parseViewParam(["butik"])).toBe("store");
    expect(parseViewParam("x")).toBeNull();
    expect(parseTrendParam("manad")).toBe("month");
    expect(parseTrendParam("dag")).toBe("day");
    expect(parseTrendParam(undefined)).toBeNull();
    expect(parseTitleParam("3F2A-b9")).toBe("3f2a-b9");
    expect(parseTitleParam("a b")).toBeNull();
  });

  it("skriver om äldre länkar (?grupp=, ?fran=, ?till=) till ?vy=, ?per=, ?from=, ?to=", () => {
    expect(canonicalLonsamhetQuery({ vy: "butik", period: "7d" })).toBeNull();
    expect(
      canonicalLonsamhetQuery({ grupp: "titel", fran: "2026-10-26", till: "2026-11-01" }),
    ).toBe("?from=2026-10-26&to=2026-11-01&vy=titel");
    expect(canonicalLonsamhetQuery({ grupp: "dag", from: "2026-10-26", to: "2026-10-26" })).toBe(
      "?from=2026-10-26&to=2026-10-26&per=dag",
    );
    expect(canonicalLonsamhetQuery({ grupp: "veckodag" })).toBe("?per=dag");
    expect(canonicalLonsamhetQuery({ butik: "s1", grupp: "automat" })).toBe("?butik=s1&vy=automat");
    expect(canonicalLonsamhetQuery({ grupp: "titel", titel: "t1", vy: "automat" })).toBe(
      "?titel=t1&vy=automat",
    );
    expect(canonicalLonsamhetQuery({ grupp: "okänd" })).toBe("");
  });

  it("bygger länken till inköpspriset utan att tappa filtret", () => {
    expect(priceHref("abc", "period=30d&butik=s1")).toBe(
      "/inkopspriser?titel=abc&period=30d&butik=s1#titel",
    );
    expect(priceHref("a b")).toBe("/inkopspriser?titel=a%20b#titel");
  });
});

describe("VMB-moms i Lönsamhet", () => {
  function withVmb(): LonsamhetInput {
    const base = docExample();
    return {
      ...base,
      current: { ...base.current, settings: { vatRateBp: 0, cardFeeBp: 0, vmb: true } },
    };
  }

  it("dras som eget steg: 4 × (49 − 20) kr = 116 kr marginal ger 23,20 kr VMB-moms", () => {
    const m = buildLonsamhetModel(withVmb(), { today: "2026-12-01" });
    expect(m.bridge.vmbVatOre).toBe(2_320);
    expect(m.bridge.vmbPreliminary).toBe(false);
    // −3,60 kr utan VMB (avsnitt 5) − 23,20 kr.
    expect(m.bridge.profitOre).toBe(-2_680);
    expect(m.totals.vmbVatOre).toBe(2_320);
    expect(m.kpis.find((k) => k.id === "profit")?.value).toBe(-2_680);
    expect(
      m.bridge.revenueOre -
        m.bridge.vmbVatOre! -
        m.bridge.costOre -
        m.bridge.feesOre -
        m.bridge.compensationOre,
    ).toBe(m.bridge.profitOre);
  });

  it("preliminär när månaden inte är slut; inget steg utan VMB", () => {
    expect(buildLonsamhetModel(withVmb(), { today: "2026-11-30" }).bridge.vmbPreliminary).toBe(
      true,
    );
    const plain = buildLonsamhetModel(docExample(), { today: "2026-11-30" });
    expect(plain.bridge.vmbVatOre).toBeNull();
    expect(plain.bridge.vmbPreliminary).toBe(false);
  });
});
