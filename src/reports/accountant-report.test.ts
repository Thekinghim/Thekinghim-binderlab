import { describe, expect, it } from "vitest";
import { profitability, storeCompensation } from "@/domain";
import { buildAccountantReport, findOrderNumberGaps, gapsText } from "./accountant-report";
import { NO_TAX, VAT_25, agreement, ord, placement, price, sources } from "./testing/fixtures";

const plain = (s: string) => s.replace(/ /g, " ");
const NOV = { start: "2026-11-01", end: "2026-11-30" };

function scenario(settings = NO_TAX) {
  return sources({
    settings,
    orders: [
      ord("2026-11-01", { externalId: "101" }),
      ord("2026-11-01", { externalId: "102", titleId: "t-b", amountOre: 5900 }),
      ord("2026-11-02", { externalId: "103", machineId: "m-2", amountOre: 12900 }),
      ord("2026-11-15", { externalId: "104", titleId: "t-c" }),
      ord("2026-11-30", { externalId: "105", machineId: null, amountOre: 1000 }),
      ord("2026-10-31", { externalId: "100" }),
    ],
    placements: [
      placement("m-1", "s-1", "2025-01-01", null),
      placement("m-2", "s-2", "2025-01-01", null),
    ],
    prices: [price("t-a", 2000, "2025-01-01"), price("t-b", 3000, "2025-01-01")],
    agreements: [
      agreement("s-1", "2025-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
      agreement("s-2", "2025-01-01", null, { commissionBp: 1500 }),
      agreement("s-3", "2025-01-01", null, { monthlyRentOre: 50_000 }),
    ],
  });
}

describe("bokföringsrapporten: summor", () => {
  it("ingen moms: inkl. = exkl. moms, alla order räknas (även utan inköpspris)", () => {
    const r = buildAccountantReport(scenario(), NOV);
    expect(r.totals.orders).toBe(5);
    expect(r.totals.grossOre).toBe(4900 + 5900 + 12900 + 4900 + 1000);
    expect(r.totals.vatOre).toBe(0);
    expect(r.totals.netOre).toBe(r.totals.grossOre);
    expect(r.totals.costOre).toBe(3 * 2000 + 3000);
    expect(r.totals.unpricedOrders).toBe(1); // t-c saknar inköpspris
    expect(r.totals.unpricedNetOre).toBe(4900);
  });

  it("moms 25 %: moms per order, exkl. moms = inkl. − moms", () => {
    const r = buildAccountantReport(scenario(VAT_25), NOV);
    expect(r.vatRateBp).toBe(2500);
    // 4900 → 980, 5900 → 1180, 12900 → 2580, 4900 → 980, 1000 → 200
    expect(r.totals.vatOre).toBe(980 + 1180 + 2580 + 980 + 200);
    expect(r.totals.netOre).toBe(r.totals.grossOre - r.totals.vatOre);
    const day1 = r.days.find((d) => d.date === "2026-11-01")!;
    expect(day1.grossOre).toBe(10_800);
    expect(day1.vatOre).toBe(2160);
    expect(day1.netOre).toBe(8640);
    expect(r.conclusion.text).toContain("inkl. moms");
  });

  it("per dag: alla dagar i perioden, summan = totalen", () => {
    const r = buildAccountantReport(scenario(), NOV);
    expect(r.days).toHaveLength(30);
    expect(r.days[0]!.date).toBe("2026-11-01");
    expect(r.days[29]!.date).toBe("2026-11-30");
    expect(r.days.reduce((s, d) => s + d.grossOre, 0)).toBe(r.totals.grossOre);
    expect(r.days.find((d) => d.date === "2026-11-03")!.orders).toBe(0);
    expect(r.days[0]!.evidence.scope).toEqual({
      period: { start: "2026-11-01", end: "2026-11-01" },
    });
  });

  it("per butik: provision på alla order, hyra även utan försäljning, samma som beräkningslagret", () => {
    const src = scenario();
    const r = buildAccountantReport(src, NOV);
    const byName = Object.fromEntries(r.stores.map((s) => [s.name, s]));
    expect(byName["Nordstan"]!.commissionOre).toBe(490 + 590 + 490);
    expect(byName["Nordstan"]!.rentOre).toBe(6200);
    expect(byName["Mobilia"]!.commissionOre).toBe(1935);
    expect(byName["Väla"]!.orders).toBe(0);
    expect(byName["Väla"]!.rentOre).toBe(50_000);
    expect(byName["Automat utan butik"]!.kind).toBe("no-store");
    const d = storeCompensation({ ...src, period: NOV });
    expect(r.totals.compensationOre).toBe(d.totalOre);
    for (const s of d.stores) {
      expect(r.stores.find((x) => x.storeId === s.storeId)!.compensationOre).toBe(s.totalOre);
    }
  });

  it("per automat: butiker och okopplad automat, summan = totalen", () => {
    const r = buildAccountantReport(scenario(), NOV);
    expect(r.machines.map((m) => m.name)).toEqual([
      "Mobilia plan 2 (BL-002)",
      "Nordstan entré (BL-001)",
      "Okopplad automat",
    ]);
    expect(r.machines[1]!.storeNames).toEqual(["Nordstan"]);
    expect(r.machines.reduce((s, m) => s + m.grossOre, 0)).toBe(r.totals.grossOre);
  });

  it("inköp och vinstgrund stämmer med lönsamheten", () => {
    const src = scenario();
    const r = buildAccountantReport(src, NOV);
    const p = profitability({ ...src, period: NOV }, "title");
    expect(r.totals.costOre).toBe(p.totals.costOre);
    expect(r.totals.rentOre).toBe(p.totals.rentOre);
    expect(r.unpricedTitles.map((t) => t.name)).toEqual(["Surging Sparks"]);
    expect(r.unpricedTitles[0]!.evidence.dates).toEqual(["2026-11-15"]);
  });
});

describe("avstämning mot källan", () => {
  it("komplett serie: inga luckor, alla kontroller OK", () => {
    const r = buildAccountantReport(scenario(), NOV);
    expect(r.reconciliation.numbers).toMatchObject({
      first: 101,
      last: 105,
      count: 5,
      span: 5,
      missing: 0,
    });
    expect(r.reconciliation.checks.every((c) => c.ok)).toBe(true);
    expect(r.reconciliation.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("luckor: nummer som saknas i källan; nummer med datum utanför perioden är ingen lucka", () => {
    const src = sources({
      orders: [
        ord("2026-11-01", { externalId: "101" }),
        ord("2026-11-02", { externalId: "102" }),
        ord("2026-11-03", { externalId: "104" }),
        ord("2026-12-01", { externalId: "105" }), // sent i källan, annan månad
        ord("2026-11-04", { externalId: "107" }),
        ord("2026-11-05", { externalId: "111" }),
      ],
      prices: [price("t-a", 2000, "2025-01-01")],
    });
    const r = buildAccountantReport(src, NOV);
    const n = r.reconciliation.numbers!;
    expect(n.first).toBe(101);
    expect(n.last).toBe(111);
    expect(n.gaps).toEqual([
      { from: 103, to: 103, count: 1 },
      { from: 106, to: 106, count: 1 },
      { from: 108, to: 110, count: 3 },
    ]);
    expect(n.missing).toBe(5);
    expect(n.outsidePeriod).toEqual(["105"]);
    // Awish numrerar över alla sina automater: luckor är normala och ingen avvikelse.
    expect(r.reconciliation.ok).toBe(true);
    expect(r.conclusion.ruleId).toBe("accountant.ok");
    expect(plain(r.conclusion.text)).toBe(
      "Försäljningen november 2026 var 245 kr (ingen moms) på 5 order, ordernummer 101–111.",
    );
    expect(r.conclusion.text).not.toContain("saknas");
    expect(r.reconciliation.evidence.externalIds).toEqual(["103", "106", "108", "109", "110"]);
  });

  it("dubbletter av ordernummer och ordernummer som inte är tal", () => {
    const src = sources({
      orders: [
        ord("2026-11-01", { externalId: "7", id: "a" }),
        ord("2026-11-01", { externalId: "7", id: "b" }),
        ord("2026-11-02", { externalId: "8" }),
        ord("2026-11-02", { externalId: "X-1" }),
      ],
      prices: [price("t-a", 2000, "2025-01-01")],
    });
    const r = buildAccountantReport(src, NOV);
    expect(r.reconciliation.duplicateExternalIds).toEqual(["7"]);
    expect(r.reconciliation.nonNumericIds).toEqual(["X-1"]);
    expect(r.reconciliation.numbers).toMatchObject({ first: 7, last: 8, missing: 0 });
    expect(r.conclusion.ruleId).toBe("accountant.duplicates");
  });

  it("inga order: ingen nummerserie; butiksersättningen ska ändå bokföras", () => {
    const r = buildAccountantReport(
      sources({ agreements: [agreement("s-1", "2025-01-01", null, { monthlyRentOre: 10_000 })] }),
      NOV,
    );
    expect(r.reconciliation.numbers).toBeNull();
    expect(r.conclusion.ruleId).toBe("accountant.no_sales");
    expect(plain(r.conclusion.text)).toBe(
      "Ingen försäljning under november 2026; butiksersättning 100 kr ska ändå bokföras.",
    );
  });

  it("order utan inköpspris nämns i slutsatsen", () => {
    const r = buildAccountantReport(scenario(), NOV);
    expect(r.conclusion.ruleId).toBe("accountant.unpriced");
    expect(plain(r.conclusion.text)).toContain(
      "ordernummer 101–105, men 1 order saknar inköpspris",
    );
  });

  it("allt i ordning", () => {
    const src = sources({
      orders: [ord("2026-11-01", { externalId: "1" }), ord("2026-11-02", { externalId: "2" })],
      prices: [price("t-a", 2000, "2025-01-01")],
    });
    const r = buildAccountantReport(src, { start: "2026-11-01", end: "2026-11-15" });
    expect(r.conclusion.ruleId).toBe("accountant.ok");
    expect(plain(r.conclusion.text)).toBe(
      "Försäljningen 1–15 nov. 2026 var 98 kr (ingen moms) på 2 order, ordernummer 1–2.",
    );
  });
});

describe("findOrderNumberGaps", () => {
  it("kantfall", () => {
    expect(findOrderNumberGaps([], [])).toEqual({ gaps: [], outsidePeriod: [] });
    expect(findOrderNumberGaps([5], [5])).toEqual({ gaps: [], outsidePeriod: [] });
    expect(findOrderNumberGaps([1, 2, 3], [1, 2, 3])).toEqual({ gaps: [], outsidePeriod: [] });
    expect(findOrderNumberGaps([1, 5], [1, 2, 3, 4, 5])).toEqual({
      gaps: [],
      outsidePeriod: [2, 3, 4],
    });
    expect(findOrderNumberGaps([1, 5], [0, 1, 3, 5, 9])).toEqual({
      gaps: [
        { from: 2, to: 2, count: 1 },
        { from: 4, to: 4, count: 1 },
      ],
      outsidePeriod: [3],
    });
  });

  it("stora hopp räknas utan att räkna upp varje nummer", () => {
    const r = findOrderNumberGaps([1, 1_000_000_001], [1, 1_000_000_001]);
    expect(r.gaps).toEqual([{ from: 2, to: 1_000_000_000, count: 999_999_999 }]);
    expect(gapsText(r.gaps)).toBe("2–1000000000");
  });
});
