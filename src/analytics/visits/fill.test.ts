import { describe, expect, it } from "vitest";

import { channelText, fillLevelOf, fillLevels, fillPercent, fillTone } from "./fill";

describe("fillLevels", () => {
  it("summerar min(saldo, kapacitet) över titlarna med kapacitet", () => {
    const levels = fillLevels(
      [
        { machineId: "m1", titleId: "t1", capacity: 10, channels: ["A1", "A2"] },
        { machineId: "m1", titleId: "t2", capacity: 10, channels: ["A3"] },
        { machineId: "m1", titleId: "t3", capacity: 4 },
      ],
      [
        { machineId: "m1", titleId: "t1", onHand: 4 },
        // Mer än kapaciteten räknas som fullt, inte mer.
        { machineId: "m1", titleId: "t2", onHand: 15 },
        // Titel utan kapacitet räknas inte.
        { machineId: "m1", titleId: "t9", onHand: 50 },
      ],
    );
    // (4 + 10 + 0) / 24 = 58,33 % → 5 833 bp.
    expect(fillLevelOf(levels, "m1")).toEqual({
      units: 14,
      capacity: 24,
      bp: 5_833,
      emptyChannels: 1,
      emptyTitles: 1,
    });
  });

  it("slutsåld titel räknar alla sina fack; negativt saldo är 0", () => {
    const levels = fillLevels(
      [{ machineId: "m1", titleId: "t1", capacity: 6, channels: ["A1", "A2", "A3"] }],
      [{ machineId: "m1", titleId: "t1", onHand: -2 }],
    );
    expect(fillLevelOf(levels, "m1")).toMatchObject({ units: 0, bp: 0, emptyChannels: 3 });
  });

  it("automat utan kapacitet har ingen fyllnadsgrad (null, inte 0)", () => {
    const levels = fillLevels(
      [{ machineId: "m1", titleId: "t1", capacity: 6 }],
      [{ machineId: "m2", titleId: "t1", onHand: 3 }],
    );
    expect(fillLevelOf(levels, "m2")).toBeNull();
    expect(fillLevelOf(fillLevels([], []), "m1")).toBeNull();
  });

  it("ogiltig kapacitet hoppas över", () => {
    const levels = fillLevels([{ machineId: "m1", titleId: "t1", capacity: 0 }], []);
    expect(fillLevelOf(levels, "m1")).toBeNull();
  });
});

describe("fillTone och fillPercent", () => {
  it("under 30 % röd, under 60 % gul, annars grön", () => {
    expect(fillTone(0)).toBe("critical");
    expect(fillTone(2_999)).toBe("critical");
    expect(fillTone(3_000)).toBe("warning");
    expect(fillTone(5_999)).toBe("warning");
    expect(fillTone(6_000)).toBe("ok");
    expect(fillTone(10_000)).toBe("ok");
  });
  it("hela procent avrundat halvt uppåt", () => {
    expect(fillPercent(5_833)).toBe(58);
    expect(fillPercent(6_650)).toBe(67);
    expect(fillPercent(10_000)).toBe(100);
  });
});

describe("channelText", () => {
  it("sorterar numeriskt och slår ihop tre eller fler i följd", () => {
    expect(channelText(["A5", "A3", "A4", "B1"])).toBe("A3–A5 B1");
    expect(channelText(["A3", "A4"])).toBe("A3 A4");
    expect(channelText(["A10", "A2", "A9", "A11"])).toBe("A2 A9–A11");
    expect(channelText(["B2", "A1", "A1"])).toBe("A1 B2");
    expect(channelText(["X", "A1"])).toBe("A1 X");
    expect(channelText([])).toBe("");
  });
});
