import { describe, expect, it } from "vitest";

import { octoberExample } from "@/reports/testing/fixtures";

import { reportFileName } from "./files";
import { allowsRange, defaultRange, isCustomRange, MAX_RANGE_DAYS, rangeError } from "./range";
import { buildSnapshot } from "./snapshot";

const ORG = { id: "org", name: "Binderlab AB", orgNumber: null, timeZone: "Europe/Stockholm" };
const TODAY = "2026-11-03";

describe("eget datum: kontroll", () => {
  it("godtar från ≤ till, till högst i dag och högst ett år", () => {
    expect(rangeError("2026-10-15", "2026-10-31", TODAY)).toBeNull();
    expect(rangeError("2026-11-03", "2026-11-03", TODAY)).toBeNull();
    expect(rangeError("2025-11-03", "2026-11-03", TODAY)).toBeNull(); // 366 dagar
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it("säger vad som är fel", () => {
    expect(rangeError("2026-10-31", "2026-10-15", TODAY)).toBe(
      "Från-datumet måste vara före till-datumet.",
    );
    expect(rangeError("2026-10-15", "2026-11-04", TODAY)).toBe(
      "Till-datumet kan inte vara efter i dag.",
    );
    expect(rangeError("2025-11-02", "2026-11-03", TODAY)).toBe("Perioden får vara högst ett år.");
    expect(rangeError("2026-02-30", "2026-03-01", TODAY)).toBe("Skriv datum som ÅÅÅÅ-MM-DD.");
    expect(rangeError("", "2026-03-01", TODAY)).toBe("Skriv datum som ÅÅÅÅ-MM-DD.");
  });

  it("förval, hel månad och vilka rapporter som kan ha eget datum", () => {
    expect(defaultRange("2026-10", TODAY)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(defaultRange("2026-11", TODAY)).toEqual({ start: "2026-11-01", end: "2026-11-03" });
    expect(isCustomRange({ start: "2026-10-01", end: "2026-10-31" })).toBe(false);
    expect(isCustomRange({ start: "2026-10-15", end: "2026-10-31" })).toBe(true);
    expect(isCustomRange({ start: "2026-02-01", end: "2026-02-28" })).toBe(false);
    expect(allowsRange("butik")).toBe(true);
    expect(allowsRange("bokforing")).toBe(true);
    expect(allowsRange("delagare")).toBe(true);
  });
});

describe("ögonblicksbild med eget datum", () => {
  const input = {
    month: "2026-10" as const,
    period: { start: "2026-10-15", end: "2026-10-31" },
    organization: ORG,
    sources: octoberExample(),
    generatedAt: "2026-11-03T10:00:00.000Z",
  };

  it("butiksrapport: perioden, siffrorna och filnamnet följer intervallet", () => {
    const s = buildSnapshot({ ...input, type: "butik", storeId: "s-1" });
    expect(s.period).toEqual({ start: "2026-10-15", end: "2026-10-31" });
    if (s.type !== "butik") throw new Error("fel typ");
    expect(s.report.sales.orders).toBe(4);
    expect(reportFileName(s, "pdf")).toBe("binderlab-butik-nordstan-2026-10-15--2026-10-31.pdf");
  });

  it("bokföring räknas på intervallet; hela månaden behåller det vanliga filnamnet", () => {
    const s = buildSnapshot({ ...input, type: "bokforing" });
    if (s.type !== "bokforing") throw new Error("fel typ");
    expect(s.report.totals.orders).toBe(4);
    expect(s.report.period).toEqual({ start: "2026-10-15", end: "2026-10-31" });
    const month = buildSnapshot({ ...input, period: null, type: "bokforing" });
    expect(reportFileName(month, "sie")).toBe("binderlab-bokforing-2026-10.se");
  });

  it("delägarrapport: perioden, siffrorna, lagret och filnamnet följer intervallet", () => {
    const s = buildSnapshot({
      ...input,
      type: "delagare",
      owners: [
        { id: "a", name: "Anna", shareBp: 6000 },
        { id: "b", name: "Bo", shareBp: 4000 },
      ],
      stockEvents: [],
    });
    if (s.type !== "delagare") throw new Error("fel typ");
    expect(s.period).toEqual({ start: "2026-10-15", end: "2026-10-31" });
    expect(s.report.period).toEqual({ start: "2026-10-15", end: "2026-10-31" });
    expect(s.report.result.orders).toBe(4);
    expect(s.report.profitSplit!.owners.reduce((n, o) => n + o.amountOre, 0)).toBe(
      s.report.result.profitOre,
    );
    expect(s.report.inventory!.asOf).toBe("2026-10-31");
    expect(reportFileName(s, "pdf")).toBe("binderlab-delagare-2026-10-15--2026-10-31.pdf");
    const month = buildSnapshot({ ...input, period: null, type: "delagare" });
    expect(month.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(reportFileName(month, "pdf")).toBe("binderlab-delagare-2026-10.pdf");
  });

  it("intervall utanför månaden stoppas", () => {
    expect(() =>
      buildSnapshot({ ...input, month: "2026-09", type: "butik", storeId: "s-1" }),
    ).toThrow(/börja i rapportens månad/);
  });
});
