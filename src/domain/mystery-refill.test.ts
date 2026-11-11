import { describe, expect, it } from "vitest";

import {
  mysteryBatch,
  mysteryBatchesToPack,
  mysteryCapacityShort,
  mysteryEmptyText,
  mysteryNeedsRefill,
  mysteryRefillProblem,
  mysteryRefillQty,
  wholeBatches,
} from "./index";

describe("mystery packs: fylls bara på när facket är tomt, med en hel omgång", () => {
  it("omgången finns bara för giltiga storlekar", () => {
    expect(mysteryBatch(14)).toBe(14);
    expect(mysteryBatch(null)).toBeNull();
    expect(mysteryBatch(undefined)).toBeNull();
    expect(mysteryBatch(0)).toBeNull();
    expect(mysteryBatch(2.5)).toBeNull();
  });

  it("förslaget är 0 medan facket har pack och en hel omgång när det är tomt", () => {
    expect(mysteryRefillQty(3, 14)).toBe(0);
    expect(mysteryRefillQty(1, 14)).toBe(0);
    expect(mysteryRefillQty(0, 14)).toBe(14);
    expect(mysteryRefillQty(-2, 14)).toBe(14);
    expect(mysteryNeedsRefill(1)).toBe(false);
    expect(mysteryNeedsRefill(0)).toBe(true);
  });

  it("varnar när en hel omgång inte får plats", () => {
    expect(mysteryCapacityShort(10, 14)).toBe(true);
    expect(mysteryCapacityShort(14, 14)).toBe(false);
    expect(mysteryCapacityShort(null, 14)).toBe(false);
    expect(mysteryCapacityShort(0, 14)).toBe(false);
  });

  it("avrundar uppåt till hela omgångar", () => {
    expect(wholeBatches(0, 14)).toBe(0);
    expect(wholeBatches(1, 14)).toBe(14);
    expect(wholeBatches(14, 14)).toBe(14);
    expect(wholeBatches(15, 14)).toBe(28);
  });

  it("texten när facket är tomt", () => {
    expect(mysteryEmptyText("Mystery Pack Plus", 14)).toBe(
      "Mystery Pack Plus är slut – fyll på en hel omgång (14 st)",
    );
  });

  it("en påfyllning som bryter regeln får en förklaring", () => {
    expect(mysteryRefillProblem(0, 14, 14)).toBeNull();
    expect(mysteryRefillProblem(3, 14, 14)).toBe("not_empty");
    expect(mysteryRefillProblem(0, 10, 14)).toBe("not_one_batch");
    expect(mysteryRefillProblem(3, 0, 14)).toBeNull();
  });
});

describe("omgångar att packa: planens antal i hela omgångar", () => {
  it("planens pack blir hela omgångar, avrundat uppåt", () => {
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 56 })).toEqual({
      batches: 4,
      packs: 56,
      batchSize: 14,
      readyBatches: 0,
      before: null,
    });
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 5 })?.batches).toBe(1);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 5 })?.packs).toBe(14);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 15 })?.batches).toBe(2);
  });

  it("samma antal som Inköp visar i dag (wholeBatches)", () => {
    for (const batchSize of [1, 6, 14, 20]) {
      for (let planPacks = 0; planPacks <= 90; planPacks++) {
        const plan = mysteryBatchesToPack({ batchSize, planPacks });
        expect(plan?.packs).toBe(wholeBatches(planPacks, batchSize));
        expect(plan!.batches * batchSize).toBe(plan!.packs);
      }
    }
  });

  it("inget att packa: 0 omgångar, inte null", () => {
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: 0 })?.batches).toBe(0);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: -14 })?.batches).toBe(0);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: Number.NaN })?.batches).toBe(0);
  });

  it("färdiga pack hemma räknas i hela omgångar, minus räknas som 0", () => {
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: 14 })?.readyBatches,
    ).toBe(1);
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: 27 })?.readyBatches,
    ).toBe(1);
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: -1 })?.readyBatches,
    ).toBe(0);
    expect(
      mysteryBatchesToPack({ batchSize: 14, planPacks: 14, packedAtHome: null })?.readyBatches,
    ).toBe(0);
  });

  it("en titel som inte är ett mystery pack ger null", () => {
    expect(mysteryBatchesToPack({ batchSize: null, planPacks: 9 })).toBeNull();
    expect(mysteryBatchesToPack({ batchSize: undefined, planPacks: 9 })).toBeNull();
    expect(mysteryBatchesToPack({ batchSize: 0, planPacks: 9 })).toBeNull();
  });
});
