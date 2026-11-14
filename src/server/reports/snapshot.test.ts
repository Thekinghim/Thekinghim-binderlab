import { describe, expect, it } from "vitest";

import { octoberExample } from "@/reports/testing/fixtures";

import {
  asSnapshot,
  buildSnapshot,
  fiscalYearOf,
  headlineOreOf,
  requestOf,
  sameReport,
  stockAtMonthEnd,
  withStoreDetails,
  type StoreSnapshot,
} from "./snapshot";

const ORG = { id: "org", name: "Binderlab AB", orgNumber: null, timeZone: "Europe/Stockholm" };

describe("fiscalYearOf", () => {
  it("kalenderår och brutet räkenskapsår", () => {
    expect(fiscalYearOf("2026-10", 1)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(fiscalYearOf("2026-03", 5)).toEqual({ start: "2025-05-01", end: "2026-04-30" });
    expect(fiscalYearOf("2026-05", 5)).toEqual({ start: "2026-05-01", end: "2027-04-30" });
    expect(() => fiscalYearOf("2026-05", 13)).toThrow();
  });
});

describe("stockAtMonthEnd", () => {
  it("summerar kända positiva saldon per titel och räknar okända", () => {
    const ev = (
      id: string,
      loc: string,
      kind: "refill" | "count" | "sale",
      quantity: number,
      date: string,
      titleId = "t-a",
    ) => ({
      id,
      locationId: loc,
      machineId: loc === "central" ? null : loc,
      titleId,
      kind,
      quantity,
      businessDate: date,
    });
    const result = stockAtMonthEnd(
      [
        ev("1", "m-1", "refill", 10, "2026-10-02"),
        ev("2", "m-1", "sale", -3, "2026-10-05"),
        ev("3", "central", "count", 40, "2026-10-01"),
        ev("4", "m-2", "sale", -1, "2026-10-03", "t-b"),
        ev("5", "m-1", "refill", 5, "2026-11-02"),
      ],
      "2026-10",
    );
    expect(result).toEqual({ stock: [{ titleId: "t-a", quantity: 47 }], unknown: 1 });
  });
});

describe("buildSnapshot", () => {
  it("butiksrapport med hälsning, service och beräkningsversion", () => {
    const snap = buildSnapshot({
      type: "butik",
      month: "2026-10",
      organization: ORG,
      sources: octoberExample(),
      generatedAt: "2026-11-01T05:00:00.000Z",
      storeId: "s-1",
      greeting: "  Tack för oktober!  ",
    });
    if (snap.type !== "butik") throw new Error("fel typ");
    expect(snap.report.greeting).toBe("Tack för oktober!");
    expect(snap.report.compensation.totalOre).toBe(3040 + 6200);
    expect(snap.service).toEqual({
      refills: { count: 0, last: null },
      busiest: null,
      busiestOrders: 0,
    });
    expect(asSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it("bokföringsunderlaget listar konton som saknas för SIE", () => {
    const snap = buildSnapshot({
      type: "bokforing",
      month: "2026-10",
      organization: ORG,
      sources: octoberExample(),
      generatedAt: "2026-11-01T05:00:00.000Z",
      ledgerAccounts: [{ key: "sales", account: "3004", name: "Försäljning" }],
    });
    if (snap.type !== "bokforing") throw new Error("fel typ");
    expect(snap.missingAccounts).toEqual(["settlement"]);
    expect(snap.sie.fiscalYear).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("delägarrapporten utan ägarandelar har ingen vinstfördelning", () => {
    const snap = buildSnapshot({
      type: "delagare",
      month: "2026-10",
      organization: ORG,
      sources: octoberExample(),
      generatedAt: "2026-11-01T05:00:00.000Z",
      comment: "",
    });
    if (snap.type !== "delagare") throw new Error("fel typ");
    expect(snap.report.profitSplit).toBeNull();
    expect(snap.comment).toBeNull();
    expect(snap.report.result.profitOre).toBe(7660);
  });

  it("avvisar okänt format", () => {
    expect(() => asSnapshot({ version: 99 })).toThrow();
  });
});

describe("sameReport (inaktuellt utkast)", () => {
  const make = (generatedAt: string, sources = octoberExample()) =>
    buildSnapshot({
      type: "butik",
      month: "2026-10",
      organization: ORG,
      sources,
      generatedAt,
      storeId: "s-1",
      greeting: "Tack!",
    });

  it("samma underlag = samma rapport, även med nycklarna i annan ordning (jsonb)", () => {
    const a = make("2026-11-01T05:00:00.000Z");
    const fromDb = JSON.parse(
      JSON.stringify(a, (_k, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse())
          : v,
      ),
    ) as typeof a;
    expect(sameReport(fromDb, make("2026-11-04T09:00:00.000Z"))).toBe(true);
    expect(requestOf(a)).toMatchObject({ type: "butik", storeId: "s-1", greeting: "Tack!" });
  });

  it("en order mindre ger en annan rapport och ett annat belopp", () => {
    const sources = octoberExample();
    const fewer = { ...sources, orders: sources.orders.slice(1) };
    const a = make("2026-11-01T05:00:00.000Z");
    const b = make("2026-11-01T05:00:00.000Z", fewer);
    expect(sameReport(a, b)).toBe(false);
    expect(headlineOreOf(a)).not.toBe(headlineOreOf(b));
  });
});

describe("Visa detaljer i rapporten: valet sparas i ögonblicksbilden", () => {
  const make = (storeDetails: boolean | undefined, generatedAt = "2026-11-01T05:00:00.000Z") => {
    const snap = buildSnapshot({
      type: "butik",
      month: "2026-10",
      organization: ORG,
      sources: octoberExample(),
      generatedAt,
      storeId: "s-1",
      ...(storeDetails === undefined ? {} : { storeDetails }),
    });
    if (snap.type !== "butik") throw new Error("fel typ");
    return snap;
  };
  /** En rapport från före valet fanns: titlarna finns i underlaget, valet är inte sparat. */
  const legacy = (): StoreSnapshot => {
    const full = make(true);
    const { details: _details, ...report } = full.report;
    void _details;
    return { ...full, report };
  };

  it("standard är av: rapporten sparas utan titlar", () => {
    const snap = make(undefined);
    expect(snap.report.details).toBe(false);
    expect(snap.report.topTitles).toEqual([]);
    expect(make(false).report).toEqual(snap.report);
  });

  it("på: titlarna sparas", () => {
    const snap = make(true);
    expect(snap.report.details).toBe(true);
    expect(snap.report.topTitles.length).toBeGreaterThan(0);
  });

  it("en sparad rapport ändras inte av regeln, vad butiken än har valt sedan dess", () => {
    for (const snap of [make(true), make(false)]) {
      expect(withStoreDetails(snap, true)).toBe(snap);
      expect(withStoreDetails(snap, false)).toBe(snap);
    }
  });

  it("äldre rapport: godkänd eller skickad visas med detaljer, utkast utan", () => {
    const old = legacy();
    expect(old.report.details).toBeUndefined();
    expect(withStoreDetails(old, true).report.details).toBe(true);
    expect(withStoreDetails(old, false).report.details).toBe(false);
    // Underlaget rörs inte: bara valet läggs till.
    expect(withStoreDetails(old, true).report.topTitles).toEqual(old.report.topTitles);
    expect(old.report.details).toBeUndefined();
  });

  it("andra rapporttyper berörs inte", () => {
    const partner = buildSnapshot({
      type: "delagare",
      month: "2026-10",
      organization: ORG,
      sources: octoberExample(),
      generatedAt: "2026-11-01T05:00:00.000Z",
    });
    expect(withStoreDetails(partner, true)).toBe(partner);
    expect(withStoreDetails(partner, false)).toBe(partner);
  });

  it("ett utkast blir inaktuellt när valet ändras (det som granskas är det som skickas)", () => {
    expect(sameReport(make(false), make(false, "2026-11-04T09:00:00.000Z"))).toBe(true);
    expect(sameReport(make(true), make(true, "2026-11-04T09:00:00.000Z"))).toBe(true);
    expect(sameReport(make(false), make(true))).toBe(false);
    expect(sameReport(make(true), make(false))).toBe(false);
    // Samma belopp: det är innehållet som skiljer, inte siffrorna.
    expect(headlineOreOf(make(false))).toBe(headlineOreOf(make(true)));
  });

  it("ett äldre utkast är inaktuellt mot en ny uträkning, av eller på", () => {
    const draft = withStoreDetails(legacy(), false);
    expect(sameReport(draft, make(false))).toBe(false);
    expect(sameReport(draft, make(true))).toBe(false);
  });
});
