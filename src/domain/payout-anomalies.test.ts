import { describe, expect, it } from "vitest";

import { gapWarnings, shareJumpWarnings, unmappedDeviceWarnings } from "./payout-anomalies";

describe("payout-anomalies", () => {
  it("hittar dagar med försäljning mellan två utbetalningar", () => {
    const w = gapWarnings(
      [
        { from: "2026-11-06", to: "2026-11-10" },
        { from: "2026-10-28", to: "2026-11-03" },
      ],
      new Set(["2026-11-04", "2026-11-05", "2026-11-08"]),
    );
    expect(w).toEqual([{ code: "GAP_DAYS", from: "2026-11-04", to: "2026-11-05" }]);
    expect(
      gapWarnings([{ from: "2026-11-01", to: "2026-11-02" }], new Set(["2026-11-05"])),
    ).toEqual([]);
  });

  it("varnar när butikens andel hoppar", () => {
    const w = shareJumpWarnings([
      { storeId: "A", shareOre: 4000, grossOre: 10_000, historyBp: [1200, 1300, 1250] },
      { storeId: "B", shareOre: 1300, grossOre: 10_000, historyBp: [1200, 1300] },
      { storeId: "C", shareOre: 400, grossOre: 1000, historyBp: [] },
    ]);
    expect(w).toEqual([{ code: "SHARE_JUMP", storeId: "A", ratioBp: 4000, medianBp: 1250 }]);
  });

  it("varnar för okända automater i rapporten", () => {
    const w = unmappedDeviceWarnings(["NX-001", "nx001", "NX-999 "], new Set(["NX001"]));
    expect(w).toEqual([{ code: "UNMAPPED_DEVICE", serial: "NX-999" }]);
  });
});
