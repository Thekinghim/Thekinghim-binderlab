import { describe, expect, it } from "vitest";

import { adviceHeadline, adviceMargin, parseTargetPercent } from "./advice-text";

describe("prisråd på Lönsamhet", () => {
  it("rubriken: antal produkter, eller att ingen är under målet", () => {
    expect(adviceHeadline(2, 2_500)).toBe("2 produkter tjänar för lite.");
    expect(adviceHeadline(1, 2_500)).toBe("1 produkt tjänar för lite.");
    // Sant även utan köp de senaste 30 dagarna (då är ingen produkt räknad alls).
    expect(adviceHeadline(0, 2_500)).toBe("Ingen produkt är under målet 25 %.");
  });

  it("marginalen på en rad ser aldrig ut att nå målet", () => {
    expect(adviceMargin(2_289, 2_500)).toBe("23 %");
    // 24,6 % avrundat till hela procent vore "25 %", samma som målet: visa en decimal.
    expect(adviceMargin(2_460, 2_500)).toBe("24,6 %");
    // 24,98 % vore "25,0 %" även med en decimal: avrunda neråt.
    expect(adviceMargin(2_498, 2_500)).toBe("24,9 %");
    expect(adviceMargin(-520, 2_500)).toBe("−5 %");
  });

  it("målet skrivs i hela procent, 1–90", () => {
    expect(parseTargetPercent("25")).toBe(2_500);
    expect(parseTargetPercent(" 30 % ")).toBe(3_000);
    expect(parseTargetPercent("1")).toBe(100);
    expect(parseTargetPercent("90")).toBe(9_000);
    for (const bad of ["", "0", "91", "25,5", "abc", "-5", "100"]) {
      expect(parseTargetPercent(bad), bad).toBeNull();
    }
  });
});
