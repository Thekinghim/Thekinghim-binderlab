import { describe, expect, it } from "vitest";

import { machinesJustLow, type SlotBalance } from "./stock-drop";

const slot = (
  machineId: string,
  titleId: string,
  onHand: number,
  alertAt: number | null = null,
): SlotBalance => ({ machineId, titleId, onHand, alertAt });

describe("machinesJustLow", () => {
  it("3 → 0 räknas en gång; nästa läsning med 0 → 0 räknas inte", () => {
    expect(machinesJustLow([slot("m1", "t1", 3)], [slot("m1", "t1", 0)])).toEqual(["m1"]);
    expect(machinesJustLow([slot("m1", "t1", 0)], [slot("m1", "t1", 0)])).toEqual([]);
  });

  it("sålt men inte slut räknas inte", () => {
    expect(machinesJustLow([slot("m1", "t1", 5)], [slot("m1", "t1", 2)])).toEqual([]);
  });

  it("larmgränsen: över gränsen → på eller under gränsen räknas, en gång", () => {
    expect(machinesJustLow([slot("m1", "t1", 4, 3)], [slot("m1", "t1", 3, 3)])).toEqual(["m1"]);
    expect(machinesJustLow([slot("m1", "t1", 3, 3)], [slot("m1", "t1", 2, 3)])).toEqual([]);
    // Under gränsen och sedan slut: larmet har redan gått.
    expect(machinesJustLow([slot("m1", "t1", 2, 3)], [slot("m1", "t1", 0, 3)])).toEqual([]);
  });

  it("påfyllt (0 → 10) och ny titel som börjar på 0 räknas inte", () => {
    expect(machinesJustLow([slot("m1", "t1", 0)], [slot("m1", "t1", 10)])).toEqual([]);
    expect(machinesJustLow([], [slot("m1", "t2", 0)])).toEqual([]);
  });

  it("flera automater: varje automat en gång, sorterade", () => {
    const before = [slot("m2", "t1", 1), slot("m2", "t2", 2), slot("m1", "t1", 1), slot("m3", "t1", 9)];
    const after = [slot("m2", "t1", 0), slot("m2", "t2", 0), slot("m1", "t1", 0), slot("m3", "t1", 8)];
    expect(machinesJustLow(before, after)).toEqual(["m1", "m2"]);
  });

  it("negativt saldo är också slut", () => {
    expect(machinesJustLow([slot("m1", "t1", 1)], [slot("m1", "t1", -1)])).toEqual(["m1"]);
  });
});
