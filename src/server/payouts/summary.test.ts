import { describe, expect, it } from "vitest";

import { acceptSummary, anonymize, restoreNames, summaryFacts, templateSummary } from "./summary";

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
    expect(t).toContain("Mest får Butik A (6 500 kr).");
    expect(t).toContain("Partner X får 29 655 kr");
    // Skillnaden mot försäljningen står i en egen ruta, inte här.
    expect(t).not.toContain("mindre");
  });
  it("skickar inga namn till modellen och sätter tillbaka dem", () => {
    const a = anonymize(facts);
    const sent = JSON.stringify(a.facts);
    expect(sent).not.toContain("Butik A");
    expect(sent).not.toContain("Partner X");
    expect(sent).not.toContain("Bolag B AB");
    expect(
      restoreNames("Mest får Butik 1. Partnern får 29 655 kr. Butik 2 får 3 200 kr.", a.names),
    ).toBe("Mest får Butik A. Partner X får 29 655 kr. Bolag B AB får 3 200 kr.");
  });
  it("godtar en AI-text med samma tal och nekar påhittade tal", () => {
    expect(
      acceptSummary("Nayax betalade 48 210 kr för 3–9 nov. Butik A fick 6 500 kr.", facts),
    ).toBe(true);
    expect(acceptSummary("Nayax betalade 48 300 kr för 3–9 nov.", facts)).toBe(false);
    expect(acceptSummary("Kort.", facts)).toBe(false);
  });
});
