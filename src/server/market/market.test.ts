/**
 * Enhetstester för Marknad: tolkning av belopp och procent, val av källa för
 * marknadspriser, den lokala källan och modellens egna regler (vilka titlar som är släpp,
 * förifyllning av fack, rubriken).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AnalyticsOrder } from "@/analytics/todos";
import { addDays, eachDay } from "@/domain";

import { orderLinks } from "./display";
import {
  activeExperimentTitles,
  analysisPeriod,
  buildMarketModel,
  experimentPriceCheck,
  lastFullDay,
  pricesView,
  pricingView,
  historicalReleases,
  slotLinesOn,
  slotPrefill,
  slotsOn,
  suggestionDay,
} from "./model";
import { parseKronorToOre, parsePercentToBp } from "./schemas";
import {
  LocalMarketPriceSource,
  marketSourceStatus,
  normalizeTitle,
  parseLocalPrices,
} from "./sources";
import type { MarketData, PriceExperimentRow, ReleaseRow } from "./types";

const TODAY = "2026-11-02";

function release(over: Partial<ReleaseRow>): ReleaseRow {
  return {
    id: "r1",
    name: "Släpp",
    series: null,
    releaseDate: "2026-11-10",
    titleId: null,
    supplierId: null,
    scaleBp: 10_000,
    horizonDays: 28,
    boxSize: 1,
    minOrderQty: 0,
    source: "manual",
    note: null,
    planLockedAt: null,
    planLockedBy: null,
    planPurchaseUnits: null,
    planCurveBp: null,
    planText: null,
    ...over,
  };
}

function data(over: Partial<MarketData> = {}): MarketData {
  const orders: AnalyticsOrder[] = [];
  let n = 0;
  // Titel "old" säljer från första dagen med data; "new" har sitt första köp 1 mars.
  for (const date of eachDay("2026-01-05", TODAY)) {
    orders.push({
      id: `o${n++}`,
      externalId: "x",
      titleId: "old",
      machineId: "m1",
      businessDate: date,
      amountOre: 4900,
    });
    orders.push({
      id: `o${n++}`,
      externalId: "x",
      titleId: "old",
      machineId: "m1",
      businessDate: date,
      amountOre: 4900,
    });
  }
  for (let d = 0; d < 28; d++) {
    orders.push({
      id: `o${n++}`,
      externalId: "x",
      titleId: "new",
      machineId: "m2",
      businessDate: addDays("2026-03-01", d),
      amountOre: 6900,
    });
  }
  return {
    organizationId: "org",
    timeZone: "Europe/Stockholm",
    role: "owner",
    canEdit: true,
    today: TODAY,
    dataStart: "2026-01-05",
    historyStart: "2025-09-29",
    titles: [
      { id: "old", name: "Gammal", series: null, mergedIntoId: null, archived: false },
      { id: "new", name: "Ny", series: "SV", mergedIntoId: null, archived: false },
      { id: "merged", name: "Dubblett", series: null, mergedIntoId: "old", archived: true },
    ],
    machines: [
      {
        id: "m1",
        name: "Automat 1",
        code: "BL-001",
        activeFrom: "2025-01-01",
        activeTo: null,
        serial: null,
        storeId: null,
        isExample: false,
        archived: false,
      },
      {
        id: "m2",
        name: "Automat 2",
        code: "BL-002",
        activeFrom: "2025-01-01",
        activeTo: null,
        serial: null,
        storeId: null,
        isExample: false,
        archived: false,
      },
    ],
    stores: [],
    placements: [],
    orders,
    sources: {
      prices: [],
      agreements: [],
      placements: [],
      settings: { vatRateBp: 0, cardFeeBp: 0 },
    },
    settings: { vatRateBp: 0, cardFeeBp: 0, fiscalYearStartMonth: 1 },
    warehouseUnits: new Map(),
    suppliers: [],
    supplierItems: [],
    purchaseLines: [],
    releases: [],
    allocations: [],
    quotes: [],
    slots: [],
    assortmentChanges: [],
    experiments: [],
    ...over,
  } as MarketData;
}

describe("belopp och procent", () => {
  it("kronor tolkas exakt till öre", () => {
    expect(parseKronorToOre("54,90")).toBe(5490);
    expect(parseKronorToOre("54.9")).toBe(5490);
    expect(parseKronorToOre("54")).toBe(5400);
    expect(parseKronorToOre("1 254,90 kr")).toBe(125_490);
    expect(parseKronorToOre("0,1")).toBe(10);
    expect(parseKronorToOre("-5")).toBeNull();
    expect(parseKronorToOre("5,999")).toBeNull();
    expect(parseKronorToOre("")).toBeNull();
  });

  it("procent blir baspunkter", () => {
    expect(parsePercentToBp("100")).toBe(10_000);
    expect(parsePercentToBp("120,5")).toBe(12_050);
    expect(parsePercentToBp("95 %")).toBe(9_500);
    expect(parsePercentToBp("abc")).toBeNull();
  });
});

describe("källa för marknadspriser", () => {
  it("ingen källa som standard", () => {
    expect(marketSourceStatus({}).kind).toBe("not-configured");
    expect(marketSourceStatus({ MARKET_PRICE_SOURCE: "none" }).kind).toBe("not-configured");
  });

  it("kandidaterna är inte inkopplade", () => {
    for (const id of ["tcgplayer", "cardmarket", "pricecharting"]) {
      const s = marketSourceStatus({ MARKET_PRICE_SOURCE: id });
      expect(s.kind).toBe("unavailable");
      if (s.kind === "unavailable") expect(s.reason).toMatch(/inte inkopplad/);
    }
    expect(marketSourceStatus({ MARKET_PRICE_SOURCE: "ebay" }).kind).toBe("unavailable");
  });

  it("den lokala källan används inte i drift", () => {
    expect(marketSourceStatus({ MARKET_PRICE_SOURCE: "local", APP_ENV: "production" }).kind).toBe(
      "unavailable",
    );
    expect(marketSourceStatus({ MARKET_PRICE_SOURCE: "local" }).kind).toBe("ready");
  });

  it("den lokala källan läser filen och matchar titlar utan skiftläge", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "marknad-"));
    const file = path.join(dir, "priser.json");
    writeFileSync(
      file,
      JSON.stringify({
        prices: [
          {
            title: "surging  sparks",
            productName: "SS Booster",
            kind: "booster-pack",
            currency: "SEK",
            priceMinor: 5490,
            observedOn: "2026-11-01",
          },
          {
            title: "Surging Sparks",
            productName: "SS Booster",
            kind: "booster-pack",
            currency: "SEK",
            priceMinor: 5290,
            observedOn: "2026-10-01",
          },
        ],
      }),
    );
    const source = new LocalMarketPriceSource(file);
    const result = await source.fetchPrices([
      { titleId: "t1", titleName: "Surging Sparks" },
      { titleId: "t2", titleName: "Okänd" },
    ]);
    expect(result.get("t1")?.map((p) => p.priceMinor)).toEqual([5290, 5490]);
    expect(result.has("t2")).toBe(false);
    expect(normalizeTitle("  Surging   Sparks ")).toBe("surging sparks");
    const missing = await new LocalMarketPriceSource(path.join(dir, "saknas.json")).fetchPrices([
      { titleId: "t1", titleName: "Surging Sparks" },
    ]);
    expect(missing.size).toBe(0);
  });

  it("fel format ger ett svenskt fel", () => {
    expect(() => parseLocalPrices("{")).toThrow(/inte giltig JSON/);
    expect(() => parseLocalPrices(JSON.stringify({ prices: [{ title: "x" }] }))).toThrow(
      /fel format/,
    );
  });
});

describe("modellen", () => {
  it("titlar som sålts redan första veckan med data räknas inte som släpp", () => {
    const refs = historicalReleases(data());
    expect(refs.map((r) => r.titleId)).toEqual(["new"]);
    // Med registrerad släppdag räknas titeln alltid, och sammanslagna titlar aldrig.
    const withRelease = historicalReleases(
      data({ releases: [release({ titleId: "old", releaseDate: "2026-01-05", series: "X" })] }),
    );
    expect(withRelease.find((r) => r.titleId === "old")).toEqual({
      titleId: "old",
      series: "X",
      releaseDate: "2026-01-05",
    });
    expect(withRelease.some((r) => r.titleId === "merged")).toBe(false);
  });

  it("förslaget räknas per i går (sista hela dagen) före släppet och per dagen före efteråt", () => {
    expect(suggestionDay(release({ releaseDate: "2026-11-10" }), TODAY)).toBe("2026-11-01");
    expect(suggestionDay(release({ releaseDate: "2026-07-06" }), TODAY)).toBe("2026-07-05");
  });

  it("fackfördelning per dag och förifyllning från försäljningen", () => {
    const d = data({
      slots: [
        {
          id: "s1",
          machineId: "m1",
          titleId: "old",
          slots: 2,
          validFrom: "2026-01-01",
          validTo: "2026-10-31",
        },
        {
          id: "s2",
          machineId: "m1",
          titleId: "old",
          slots: 3,
          validFrom: "2026-11-01",
          validTo: null,
        },
        {
          id: "s3",
          machineId: "m1",
          titleId: "new",
          slots: 1,
          validFrom: "2026-11-01",
          validTo: null,
        },
      ],
    });
    expect(slotsOn(d, "2026-10-31").get("m1")).toBe(2);
    expect(slotsOn(d, TODAY).get("m1")).toBe(4);
    expect(slotLinesOn(d, "m1", TODAY)).toEqual([
      { titleId: "old", slots: 3 },
      { titleId: "new", slots: 1 },
    ]);
    expect(slotPrefill(d, "m2", { start: "2026-03-01", end: "2026-03-31" })).toEqual([
      { titleId: "new", slots: 1 },
    ]);
    expect(slotPrefill(d, "m2", { start: "2026-10-01", end: TODAY })).toEqual([]);
  });

  it("pågående och planerade pristester spärrar titeln", () => {
    const d = data({
      experiments: [
        {
          id: "e1",
          titleId: "old",
          proposalKey: "k",
          direction: "up",
          fromOre: 1,
          toOre: 2,
          startedOn: "2026-10-20",
          testDays: 28,
          stoppedOn: null,
          testMachineIds: ["m1"],
          controlMachineIds: ["m2"],
          text: null,
        },
        {
          id: "e2",
          titleId: "new",
          proposalKey: "k",
          direction: "up",
          fromOre: 1,
          toOre: 2,
          startedOn: "2026-10-20",
          testDays: 28,
          stoppedOn: "2026-10-25",
          testMachineIds: ["m1"],
          controlMachineIds: ["m2"],
          text: null,
        },
      ],
    });
    expect([...activeExperimentTitles(d)]).toEqual(["old"]);
  });

  it("rubriken svarar med nästa släpp och siffror ur beräkningarna", () => {
    const empty = buildMarketModel(data(), { start: "2026-10-04", end: TODAY });
    expect(empty.headline.title).toBe("Inget släpp inlagt.");
    expect(empty.headline.aside).toMatch(/Inga inköpspriser registrerade/);

    const base = data();
    const entered = buildMarketModel(
      data({
        sources: {
          ...base.sources,
          prices: [
            { titleId: "t1", unitCostOre: 5000, validFrom: "2026-01-01" },
            { titleId: "t1", unitCostOre: 6000, validFrom: "2026-10-01" },
            { titleId: "t2", unitCostOre: 7000, validFrom: "2099-01-01" },
          ],
        },
      }),
      { start: "2026-10-04", end: TODAY },
    );
    expect(entered.headline.aside).toMatch(/Inköpspris inlagt för 1 titel\./);
    expect(entered.prices.entered).toEqual([
      { titleId: "t1", unitCostOre: 6000, validFrom: "2026-10-01" },
    ]);

    const withRelease = buildMarketModel(
      data({ releases: [release({ name: "Nova", series: "SV", releaseDate: "2026-11-14" })] }),
      { start: "2026-10-04", end: TODAY },
    );
    expect(withRelease.headline.title).toBe("Nästa släpp: Nova 14\u00a0nov.");
    expect(withRelease.headline.aside).toMatch(/^Förslaget: köp \d+\u00a0pack till 2 automater\./);
    const view = withRelease.releases[0]!;
    expect(view.status).toBe("upcoming");
    expect(view.needsAction).toBe(true);
  });

  it("analysen räknar bara hela dagar med data", () => {
    const d = data({ dataStart: "2026-10-13" });
    expect(lastFullDay(d)).toBe("2026-11-01");
    // 30 dagar bakåt från i dag, men data först från 13 okt. och i dag är inte slut.
    expect(analysisPeriod(d, { start: "2026-10-04", end: TODAY })).toEqual({
      start: "2026-10-13",
      end: "2026-11-01",
    });
    // En period helt före första ordern blir en dag lång (för kort för sortimentet).
    expect(analysisPeriod(d, { start: "2026-09-01", end: "2026-09-30" })).toEqual({
      start: "2026-09-30",
      end: "2026-09-30",
    });
    const model = buildMarketModel(d, { start: "2026-10-04", end: TODAY });
    expect(model.assortment.period).toEqual({ start: "2026-10-13", end: "2026-11-01" });
  });

  it("pristestets resultat visas bara när testpriset syns i orderna", () => {
    const experiment = (over: Partial<PriceExperimentRow> = {}): PriceExperimentRow => ({
      id: "e1",
      titleId: "old",
      proposalKey: "price-test:old:up:2026-10-20",
      direction: "up",
      fromOre: 4900,
      toOre: 5400,
      startedOn: "2026-10-20",
      testDays: 28,
      stoppedOn: null,
      testMachineIds: ["m1"],
      controlMachineIds: ["m2"],
      text: null,
      ...over,
    });
    // "old" säljs för 49 kr i m1 hela tiden: testpriset 54 kr infördes aldrig.
    const d = data({ experiments: [experiment()] });
    const missing = experimentPriceCheck(d, d.experiments[0]!, "2026-11-01")!;
    expect(missing.status).toBe("missing");
    expect(missing.orders).toBe(26);
    expect(missing.atTestPrice).toBe(0);
    expect(missing.otherModalOre).toBe(4900);
    const view = pricingView(d, { start: "2026-10-04", end: TODAY }).experiments[0]!;
    expect(view.measuredTo).toBe("2026-11-01");
    expect(view.priceCheck?.status).toBe("missing");
    expect(view.evaluation).toBeNull();

    // Med testpriset i m1 från startdagen räknas effekten.
    const priced = data({ experiments: [experiment()] });
    const orders = priced.orders.map((o) =>
      o.titleId === "old" && o.machineId === "m1" && o.businessDate >= "2026-10-20"
        ? { ...o, amountOre: 5400 }
        : o,
    );
    const ok = data({ experiments: [experiment()], orders });
    expect(experimentPriceCheck(ok, ok.experiments[0]!, "2026-11-01")!.status).toBe("ok");
    const okView = pricingView(ok, { start: "2026-10-04", end: TODAY }).experiments[0]!;
    expect(okView.evaluation?.ok).toBe(true);

    // Ett test som börjar i dag har ingen hel dag att mäta.
    const fresh = data({ experiments: [experiment({ startedOn: TODAY })] });
    const freshView = pricingView(fresh, { start: "2026-10-04", end: TODAY }).experiments[0]!;
    expect(freshView.status).toBe("planned");
    expect(freshView.priceCheck).toBeNull();
    expect(freshView.evaluation).toBeNull();
  });

  it("bara faktiska inköp flaggas; utkast och marknadspriser är inte leverantörspriser", () => {
    const quote = (id: string, day: string, ore: number, kind: "quote" | "purchase") => ({
      id,
      supplierId: "s1",
      titleId: "old",
      quotedOn: day,
      validUntil: null,
      unitCostOre: ore,
      quantity: 10,
      kind,
      source: "manual" as const,
      note: null,
      createdBy: null,
    });
    const history = [0, 1, 2, 3, 4, 5].map((i) =>
      quote(`p${i}`, addDays("2026-05-01", i * 14), 2000 + (i % 2) * 20, "purchase"),
    );
    const d = data({
      suppliers: [{ id: "s1", name: "Grossisten", archived: false }],
      quotes: [
        ...history,
        quote("offer", "2026-10-20", 2600, "quote"),
        quote("bought", "2026-10-21", 2600, "purchase"),
        { ...quote("market", "2026-10-22", 9900, "purchase"), source: "market" as const },
      ],
      purchaseLines: [
        {
          id: "draft",
          purchaseOrderId: "po1",
          supplierId: "s1",
          titleId: "old",
          date: "2026-10-23",
          unitCostOre: 9900,
          quantity: 10,
          status: "draft",
        },
      ],
    });
    const view = pricesView(d, { start: "2026-10-04", end: TODAY });
    expect(view.purchases.map((p) => p.id)).not.toContain("market");
    expect(view.purchases.map((p) => p.id)).not.toContain("draft");
    expect(view.anomalies.ok && view.anomalies.value.map((a) => a.purchaseId)).toEqual(["bought"]);
    // Offerten syns i prisutvecklingen.
    expect(view.trends.ok && view.trends.value[0]!.purchases).toBe(8);
  });

  it("länken till underlaget avgränsas till titeln och automaten", () => {
    const name = (id: string) => (id === "t1" ? "Titel 1" : "Titel 2");
    const base = {
      period: { start: "2026-10-01", end: "2026-10-28" },
      orderIds: ["o1", "o2"],
      dates: [],
      machineIds: ["m1"],
    };
    expect(orderLinks({ ...base, titleIds: ["t1"] }, name)).toEqual([
      {
        href: "/order?from=2026-10-01&to=2026-10-28&automat=m1&titel=t1",
        label: "2\u00a0order i underlaget →",
      },
    ]);
    const many = orderLinks({ ...base, machineIds: [], titleIds: ["t1", "t2"] }, name);
    expect(many.map((l) => l.href)).toEqual([
      "/order?from=2026-10-01&to=2026-10-28&titel=t1",
      "/order?from=2026-10-01&to=2026-10-28&titel=t2",
    ]);
    expect(orderLinks({ ...base, orderIds: [], titleIds: ["t1"] }, name)).toEqual([]);
  });
});
