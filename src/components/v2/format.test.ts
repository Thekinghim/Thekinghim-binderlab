import { describe, expect, it } from "vitest";

import { formatAmountOre, formatValue } from "./format";

describe("formatValue", () => {
  it("enheterna", () => {
    expect(formatValue(123_456, "ore")).toBe("1 235 kr");
    expect(formatValue(1235, "kr")).toBe("1 235 kr");
    expect(formatValue(12, "pack")).toBe("12 pack");
    expect(formatValue(2_040, "bp")).toBe("20,4 %");
    expect(formatValue(7.4, "int")).toBe("7");
  });
});

describe("formatAmountOre", () => {
  it("hela kronor utan decimaler, ören bara när de finns", () => {
    expect(formatAmountOre(12_900)).toBe("129 kr");
    expect(formatAmountOre(12_950)).toBe("129,50 kr");
    expect(formatAmountOre(42_581_700)).toBe("425 817 kr");
  });
});
