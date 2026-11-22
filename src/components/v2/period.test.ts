import { describe, expect, it } from "vitest";

import { parsePeriod } from "@/components/shell/period-state";

import { v2CompareText, v2PeriodOf } from "./period";

const NOW = new Date(2026, 10, 22, 10);
const p = (q: string) => parsePeriod(new URLSearchParams(q), { now: NOW });

describe("V2 periodval", () => {
  it("snabbvalen markeras, andra perioder visas på datumknappen (null)", () => {
    expect(v2PeriodOf("30d")).toBe("30d");
    expect(v2PeriodOf("7d")).toBe("7d");
    expect(v2PeriodOf("igar")).toBe("igar");
    expect(v2PeriodOf("idag")).toBe("idag");
    expect(v2PeriodOf("manad")).toBeNull();
    expect(v2PeriodOf("forra-manaden")).toBeNull();
    expect(v2PeriodOf("eget")).toBeNull();
  });
  it("jämförelsetext", () => {
    expect(v2CompareText(p("period=idag"))).toBe("mot i går");
    expect(v2CompareText(p("period=igar"))).toBe("mot dagen innan");
    expect(v2CompareText(p("period=30d"))).toBe("mot förra 30 dagarna");
    expect(v2CompareText(p("period=allt"))).toBe("mot förra");
  });
});
