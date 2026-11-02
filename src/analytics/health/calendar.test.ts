import { describe, expect, it } from "vitest";
import {
  buildHourCalendar,
  calendarHourAt,
  hourSlotAt,
  localDayStartMs,
  poissonCdf,
  poissonSf,
  poissonZero,
  probabilityText,
  probabilityToBp,
  slotOf,
  durationText,
} from "./index";
import { slotsText } from "./text";

const TZ = "Europe/Stockholm";

describe("timkalender", () => {
  it("lokal midnatt i Stockholm, vinter och sommar", () => {
    expect(new Date(localDayStartMs("2026-11-02", TZ)).toISOString()).toBe(
      "2026-11-01T23:00:00.000Z",
    );
    expect(new Date(localDayStartMs("2026-07-01", TZ)).toISOString()).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    expect(new Date(localDayStartMs("2026-11-02", "Asia/Shanghai")).toISOString()).toBe(
      "2026-11-01T16:00:00.000Z",
    );
  });

  it("dygnet då sommartiden slutar har 25 timmar, då den börjar 23", () => {
    const count = (date: string) => {
      const next = date === "2026-10-25" ? "2026-10-26" : "2026-03-30";
      const cal = buildHourCalendar(localDayStartMs(date, TZ), localDayStartMs(next, TZ), TZ);
      return { n: cal.hours.length, hours: cal.hours.map((h) => h.hour) };
    };
    const oct = count("2026-10-25");
    expect(oct.n).toBe(25);
    expect(oct.hours.slice(0, 5)).toEqual([0, 1, 2, 2, 3]);
    const mar = count("2026-03-29");
    expect(mar.n).toBe(23);
    expect(mar.hours.slice(0, 4)).toEqual([0, 1, 3, 4]);
  });

  it("veckotimme och uppslag", () => {
    expect(slotOf(1, 0)).toBe(0);
    expect(slotOf(7, 23)).toBe(167);
    const ms = Date.parse("2026-11-02T13:37:00Z"); // måndag 14:37 svensk tid
    const h = hourSlotAt(ms, TZ);
    expect(h).toEqual({
      startMs: Date.parse("2026-11-02T13:00:00Z"),
      date: "2026-11-02",
      weekday: 1,
      hour: 14,
      slot: 14,
    });
    const cal = buildHourCalendar(ms - 3_600_000, ms + 1, TZ);
    expect(calendarHourAt(cal, ms)?.hour).toBe(14);
    expect(calendarHourAt(cal, ms + 7_200_000)).toBeUndefined();
  });

  it("vägrar orimligt lång kalender", () => {
    expect(() => buildHourCalendar(0, 10 * 366 * 24 * 3_600_000, TZ)).toThrow();
  });
});

describe("Poisson", () => {
  it("P(0) = e^−λ", () => {
    expect(poissonZero(0)).toBe(1);
    expect(probabilityToBp(poissonZero(4.6))).toBe(101);
    expect(probabilityToBp(poissonZero(4.61))).toBe(100);
    expect(() => poissonZero(-1)).toThrow();
    expect(() => poissonZero(Number.NaN)).toThrow();
  });

  it("fördelningsfunktion och svans", () => {
    expect(poissonCdf(-1, 3)).toBe(0);
    expect(poissonCdf(0, 3)).toBeCloseTo(Math.exp(-3), 12);
    expect(poissonCdf(2, 3)).toBeCloseTo(Math.exp(-3) * (1 + 3 + 4.5), 12);
    expect(poissonSf(0, 3)).toBe(1);
    expect(poissonSf(3, 3)).toBeCloseTo(1 - Math.exp(-3) * 8.5, 12);
    expect(poissonSf(1, 0)).toBe(0);
    expect(poissonCdf(5, 0)).toBe(1);
    // Långt ut i svansen: P(X ≥ 40 | λ = 10) ≈ 7,3e−13, ska inte bli 0.
    const tail = poissonSf(40, 10);
    expect(tail).toBeGreaterThan(5e-13);
    expect(tail).toBeLessThan(1e-12);
    expect(poissonCdf(1000, 10)).toBe(1);
  });
});

describe("texter", () => {
  const t = (s: string) => s.replace(/ /g, " ");
  it("sannolikhet", () => {
    expect(t(probabilityText(0))).toBe("under 0,01 %");
    expect(t(probabilityText(1))).toBe("0,01 %");
    expect(t(probabilityText(23))).toBe("0,23 %");
    expect(t(probabilityText(150))).toBe("1,5 %");
    expect(t(probabilityText(100))).toBe("1 %");
    expect(t(probabilityText(302))).toBe("3,02 %");
  });
  it("varaktighet", () => {
    expect(t(durationText(45))).toBe("45 min");
    expect(t(durationText(60))).toBe("1 timme");
    expect(t(durationText(71 * 60 + 59))).toBe("71 timmar");
    expect(t(durationText(72 * 60))).toBe("3 dygn");
  });
  it("veckotimmar slås ihop", () => {
    expect(
      slotsText([
        { weekday: 1, hour: 15 },
        { weekday: 1, hour: 14 },
        { weekday: 2, hour: 9 },
      ]),
    ).toBe("måndag 14–16, tisdag 09–10");
  });
});
