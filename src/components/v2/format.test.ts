import { describe, expect, it } from "vitest";

import { formatValue } from "./format";

describe("formatValue", () => {
  it("enheterna", () => {
    expect(formatValue(123_456, "ore")).toBe("1 235 kr");
    expect(formatValue(1235, "kr")).toBe("1 235 kr");
    expect(formatValue(12, "pack")).toBe("12 pack");
    expect(formatValue(2_040, "bp")).toBe("20,4 %");
    expect(formatValue(7.4, "int")).toBe("7");
  });
});
