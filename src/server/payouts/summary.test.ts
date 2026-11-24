import { describe, expect, it } from "vitest";

import { acceptSummary, summaryFacts, templateSummary } from "./summary";

const facts = summaryFacts({
  amountOre: 4_821_000,
  periodText: "3–9 nov.",
  diffOre: -9000,
  lines: [
    { kind: "store", name: "Butik A", amountOre: 650_000, partner: null },
    { kind: "store_owner", name: "Bolag B AB", amountOre: 320_000, partner: null },
    {
      kind: "partner",
      name: "Partner X",
      amountOre: 2_965_500,
      partner: { reimbOre: 2_600_000, profitShareOre: 365_500 },
    },
    { kind: "vat_reserve", name: "Moms att spara", amountOre: 520_000, partner: null },
    { kind: "owner", name: "Kvar till dig", amountOre: 365_500, partner: null },
  ],
});

describe("sammanfattningen", () => {
  it("mallen säger belopp, period, största butiken och resten", () => {
    const t = templateSummary(facts);
    expect(t).toContain("Nayax betalade 48 210 kr för 3–9 nov.");
    expect(t).toContain("Butik A (6 500 kr)");
    expect(t).toContain("Partner X får 29 655 kr");
    expect(t).toContain("90 kr mindre");
  });
  it("godtar en AI-text med samma tal och nekar påhittade tal", () => {
    expect(
      acceptSummary("Nayax betalade 48 210 kr för 3–9 nov. Butik A fick 6 500 kr.", facts),
    ).toBe(true);
    expect(acceptSummary("Nayax betalade 48 300 kr för 3–9 nov.", facts)).toBe(false);
    expect(acceptSummary("Kort.", facts)).toBe(false);
  });
});
