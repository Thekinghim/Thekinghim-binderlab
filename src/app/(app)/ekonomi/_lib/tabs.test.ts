import { describe, expect, it } from "vitest";

import { costLinesFrom } from "@/lib/cost-lines";

import { economyTabs, hasFixedCosts, showAddFixedLink } from "./tabs";

const labels = (fixed: boolean, view: Parameters<typeof economyTabs>[1]) =>
  economyTabs(fixed, view).map((t) => t.label);

describe("Ekonomis flikar", () => {
  it("Fasta kostnader bara med en fast kostnad som inte är arkiverad (som cost-lines)", () => {
    expect(hasFixedCosts([])).toBe(false);
    expect(hasFixedCosts([{ archived: true }])).toBe(false);
    expect(hasFixedCosts([{ archived: true }, { archived: false }])).toBe(true);
    // Samma regel som src/lib/cost-lines.ts.
    for (const n of [0, 1, 3]) {
      const costs = Array.from({ length: n }, () => ({ archived: false }));
      expect(hasFixedCosts(costs)).toBe(costLinesFrom([], n).fixed);
    }
  });

  it("utan fasta kostnader döljs fliken; med dem visas den", () => {
    expect(labels(false, "avstamning")).toEqual(["Avstämning", "Kassaflöde"]);
    expect(labels(false, "kassaflode")).toEqual(["Avstämning", "Kassaflöde"]);
    expect(labels(true, "avstamning")).toEqual(["Avstämning", "Kassaflöde", "Fasta kostnader"]);
  });

  it("fliken går att nå ändå: vald flik visas, och länken Lägg till fast kostnad", () => {
    expect(labels(false, "fasta")).toEqual(["Avstämning", "Kassaflöde", "Fasta kostnader"]);
    expect(showAddFixedLink(false, "avstamning", true)).toBe(true);
    expect(showAddFixedLink(false, "kassaflode", true)).toBe(true);
    // Inte för den som bara läser, inte när fliken redan visas eller är vald.
    expect(showAddFixedLink(false, "avstamning", false)).toBe(false);
    expect(showAddFixedLink(true, "avstamning", true)).toBe(false);
    expect(showAddFixedLink(false, "fasta", true)).toBe(false);
    expect(showAddFixedLink(false, "bokforing", true)).toBe(false);
  });
});
