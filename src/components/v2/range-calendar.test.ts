import { describe, expect, it } from "vitest";

import { monthGrid } from "./range-calendar";

describe("monthGrid", () => {
  it("har alltid sex veckor, oavsett månad", () => {
    // Februari 2027 börjar på en måndag och har fyra veckor; mars 2025 börjar på en lördag.
    for (const month of [new Date(2027, 1, 1), new Date(2025, 2, 1), new Date(2026, 10, 1)]) {
      expect(monthGrid(month)).toHaveLength(42);
    }
  });

  it("börjar på måndag och har varje dag en gång", () => {
    const cells = monthGrid(new Date(2026, 10, 1)); // november 2026: söndag den 1:a
    expect(cells.slice(0, 6).every((c) => c === null)).toBe(true);
    expect(cells[6]?.getDate()).toBe(1);
    const days = cells.filter((c): c is Date => c !== null).map((c) => c.getDate());
    expect(days).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});
