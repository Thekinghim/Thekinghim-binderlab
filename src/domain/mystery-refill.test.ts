import { describe, expect, it } from "vitest";

import {
  mysteryBatch,
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
