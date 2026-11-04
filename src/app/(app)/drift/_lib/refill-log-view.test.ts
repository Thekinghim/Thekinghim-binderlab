import { describe, expect, it } from "vitest";

import { businessDateOf, refillLogView, type RefillLogRow } from "./refill-log-view";

const TZ = "Europe/Stockholm";
const row = (occurredAt: string, quantity: number, extra: Partial<RefillLogRow> = {}) => ({
  clientId: `${occurredAt}-${quantity}`,
  machineCode: "BL-001",
  machineName: "Sega gubben",
  titleName: "Mystery Pack",
  quantity,
  occurredAt,
  by: "Wille",
  ...extra,
});

describe("påfyllningsloggen", () => {
  it("i dag räknas i svensk tid, inte UTC", () => {
    // 23:30 UTC den 3 nov är 00:30 den 4 nov i Stockholm.
    expect(businessDateOf("2026-11-03T23:30:00.000Z", TZ)).toBe("2026-11-04");
    const v = refillLogView(
      [row("2026-11-03T23:30:00.000Z", 12), row("2026-11-03T21:00:00.000Z", 5)],
      "2026-11-04",
      TZ,
    );
    expect(v.today.packs).toBe(12);
    expect(v.today.entries[0]?.time).toBe("00:30");
    expect(v.earlier.map((d) => [d.date, d.packs])).toEqual([["2026-11-03", 5]]);
    expect(v.headline).toBe("12 pack påfyllda i dag.");
  });

  it("senaste först; tom dag säger det", () => {
    const v = refillLogView(
      [row("2026-11-04T08:00:00.000Z", 3), row("2026-11-04T10:00:00.000Z", 1)],
      "2026-11-04",
      TZ,
    );
    expect(v.today.entries.map((e) => e.time)).toEqual(["11:00", "09:00"]);
    expect(refillLogView([], "2026-11-04", TZ).headline).toBe("Inget påfyllt i dag.");
    expect(refillLogView([row("2026-11-04T08:00:00.000Z", 1)], "2026-11-04", TZ).headline).toBe(
      "1 pack påfyllt i dag.",
    );
  });
});
