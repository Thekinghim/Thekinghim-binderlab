import { describe, expect, it } from "vitest";

import { hasOwnStockRows, ownStockTotals, sumOwnStock } from "./own-stock";

const row = (
  locationKind: "warehouse" | "machine",
  titleId: string,
  onHand: number,
  lastCountedAt: string | null = null,
) => ({
  locationKind,
  titleId,
  onHand,
  lastCountedAt,
  lastEventAt: null,
  lastRestockedAt: null,
});

describe("vårt lager = summan av alla egna lager", () => {
  it("summerar per titel över lagren, automater räknas inte", () => {
    const rows = [
      row("warehouse", "a", 30, "2026-11-01T10:00:00.000Z"),
      row("warehouse", "a", 10, "2026-11-02T10:00:00.000Z"),
      row("machine", "a", 7),
      row("warehouse", "b", -2),
      row("warehouse", "b", 5),
    ];
    expect(ownStockTotals(rows)).toEqual([
      { titleId: "a", onHand: 40 },
      { titleId: "b", onHand: 3 },
    ]);
    expect(sumOwnStock(rows)[0]!.lastCountedAt).toBe("2026-11-02T10:00:00.000Z");
  });

  it("utan egna lager: inga rader", () => {
    expect(hasOwnStockRows([row("machine", "a", 1)])).toBe(false);
    expect(ownStockTotals([row("machine", "a", 1)])).toEqual([]);
  });
});
