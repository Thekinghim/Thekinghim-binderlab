import { describe, expect, it } from "vitest";

import { v2CompareText, v2PeriodOf } from "./period";

describe("V2 periodval", () => {
  it("de tre valen markeras, andra perioder blir Eget (null)", () => {
    expect(v2PeriodOf("30d")).toBe("30d");
    expect(v2PeriodOf("7d")).toBe("7d");
    expect(v2PeriodOf("idag")).toBe("idag");
    expect(v2PeriodOf("manad")).toBeNull();
    expect(v2PeriodOf("eget")).toBeNull();
  });
  it("jämförelsetext", () => {
    expect(v2CompareText("idag")).toBe("mot i går");
    expect(v2CompareText("30d")).toBe("mot förra");
  });
});
