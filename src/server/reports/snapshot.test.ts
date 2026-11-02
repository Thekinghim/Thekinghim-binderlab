import { describe, expect, it } from "vitest";

import { octoberExample } from "@/reports/testing/fixtures";

import { asSnapshot, buildSnapshot, fiscalYearOf, stockAtMonthEnd } from "./snapshot";

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
