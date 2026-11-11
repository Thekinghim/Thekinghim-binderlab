import { describe, expect, it } from "vitest";

import { lastPurchase } from "./last-purchase";

const inv = (machineId: string, kind: string, amountOre: number, investedOn: string) => ({
  machineId,
  kind,
  amountOre,
  investedOn,
});

describe("lastPurchase (förifyllt i Ny investering)", () => {
  const list = [
    inv("m1", "purchase", 4_000_000, "2026-02-01"),
    inv("m2", "installation", 300_000, "2026-09-01"),
    inv("m2", "purchase", 4_500_000, "2026-08-01"),
    inv("m3", "purchase", 5_000_000, "2026-10-01"),
  ];

  it("senaste inköpet av en annan automat, inte installation och inte automaten själv", () => {
    expect(lastPurchase(list, "m3")?.amountOre).toBe(4_500_000);
    expect(lastPurchase(list, "m9")?.amountOre).toBe(5_000_000);
  });

  it("inget att förifylla: null", () => {
    expect(lastPurchase([], "m1")).toBeNull();
    expect(lastPurchase([inv("m1", "purchase", 1, "2026-01-01")], "m1")).toBeNull();
    expect(lastPurchase([inv("m2", "purchase", 0, "2026-01-01")], "m1")).toBeNull();
  });
});
