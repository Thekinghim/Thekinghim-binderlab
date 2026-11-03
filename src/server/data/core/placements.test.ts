import { describe, expect, it } from "vitest";

import { effectivePlacements } from "./placements";
import type { PlacementRecord } from "./types";

const p = (
  id: string,
  machineId: string,
  from: string,
  to: string | null = null,
): PlacementRecord => ({
  id,
  machineId,
  storeId: `s-${id}`,
  from,
  to,
});

describe("effectivePlacements", () => {
  it("låter automatens första placering gälla från automatens första order", () => {
    // Som i drift: automaten placerad 3 nov., försäljningen importerad från 14 okt.
    const placements = [p("a", "m1", "2026-11-03")];
    const orders = [
      { machineId: "m1", businessDate: "2026-10-20" },
      { machineId: "m1", businessDate: "2026-10-14" },
      { machineId: null, businessDate: "2026-10-01" },
    ];
    expect(effectivePlacements(placements, orders)).toEqual([
      { ...placements[0], from: "2026-10-14" },
    ]);
  });

  it("ändrar bara den första placeringen och inget när ordern kom efter starten", () => {
    const placements = [p("b", "m1", "2026-10-10", "2026-10-31"), p("a", "m1", "2026-11-01")];
    const extended = effectivePlacements(placements, [
      { machineId: "m1", businessDate: "2026-10-01" },
    ]);
    expect(extended).toEqual([{ ...placements[0], from: "2026-10-01" }, placements[1]]);
    expect(
      effectivePlacements(placements, [{ machineId: "m1", businessDate: "2026-10-12" }]),
    ).toEqual(placements);
  });

  it("rör inte andra automaters placeringar", () => {
    const placements = [p("a", "m1", "2026-11-03"), p("c", "m2", "2026-11-03")];
    const out = effectivePlacements(placements, [{ machineId: "m2", businessDate: "2026-10-30" }]);
    expect(out[0]).toBe(placements[0]);
    expect(out[1]).toEqual({ ...placements[1], from: "2026-10-30" });
  });
});
