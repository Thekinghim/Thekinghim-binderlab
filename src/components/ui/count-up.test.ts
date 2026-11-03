import { describe, expect, it } from "vitest";

import { countUpFrame, countUpStart } from "./count-up";

describe("countUpStart", () => {
  it("hoppar aldrig till 0 vid hydrering", () => {
    expect(countUpStart(500, undefined, true)).toBe(500);
  });
  it("räknar från 0 första gången på klienten", () => {
    expect(countUpStart(500, undefined, false)).toBe(0);
  });
  it("börjar från förra värdet", () => {
    expect(countUpStart(500, 300, false)).toBe(300);
    expect(countUpStart(500, 500, false)).toBe(500);
  });
});

describe("countUpFrame", () => {
  it("negativ tid ger startvärdet, aldrig minus", () => {
    expect(countUpFrame(0, 100, -16, 650)).toEqual({ n: 0, done: false });
    expect(Object.is(countUpFrame(0, -1, 1, 650).n, -0)).toBe(false);
  });
  it("sista rutan är exakt", () => {
    expect(countUpFrame(0, 1234567, 650, 650)).toEqual({ n: 1234567, done: true });
    expect(countUpFrame(0, 1234567, 9999, 650).n).toBe(1234567);
  });
  it("stannar mellan start och mål", () => {
    for (let t = 0; t < 650; t += 13) {
      const { n } = countUpFrame(200, 100, t, 650);
      expect(n).toBeGreaterThanOrEqual(100);
      expect(n).toBeLessThanOrEqual(200);
    }
  });
});
