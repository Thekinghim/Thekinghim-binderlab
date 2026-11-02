import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  assertPeriod,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  eachDay,
  eachMonth,
  fromDayNumber,
  intersectPeriods,
  isIsoDate,
  isoWeekLabel,
  monthEnd,
  monthOf,
  monthPeriod,
  monthsElapsed,
  overlapDays,
  periodDays,
  previousPeriod,
  toDayNumber,
  weekOf,
} from "./dates";
import { DomainError } from "./errors";

/** Oberoende facit via Date.UTC (påverkas inte av processens tidszon). */
function utcIso(dayNumber: number): string {
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
}

describe("dagnummer", () => {
  it("1970-01-01 är dag 0", () => {
    expect(toDayNumber("1970-01-01")).toBe(0);
    expect(fromDayNumber(0)).toBe("1970-01-01");
    expect(toDayNumber("1969-12-31")).toBe(-1);
  });

  it("stämmer med Date.UTC för varje dag 1900–2100", () => {
    const from = toDayNumber("1900-01-01");
    const to = toDayNumber("2100-12-31");
    for (let n = from; n <= to; n++) {
      const iso = utcIso(n);
      if (fromDayNumber(n) !== iso || toDayNumber(iso) !== n) {
        throw new Error(`Fel vid dag ${n}: ${fromDayNumber(n)} ≠ ${iso}`);
      }
    }
  });

  it("klarar år 1 och 9999 men inte utanför", () => {
    expect(fromDayNumber(toDayNumber("0001-01-01"))).toBe("0001-01-01");
    expect(fromDayNumber(toDayNumber("9999-12-31"))).toBe("9999-12-31");
    expect(() => addDays("9999-12-31", 1)).toThrow(DomainError);
  });
});

describe("ogiltiga datum", () => {
  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "2026-1-5",
    "26-01-01",
    "",
    "2026-01-01T00:00",
  ])("%s kastar", (s) => {
    expect(isIsoDate(s)).toBe(false);
    expect(() => toDayNumber(s)).toThrow(DomainError);
  });

  it("skottdagar", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(isIsoDate("2100-02-29")).toBe(false);
  });
});

describe("addDays / daysBetween / eachDay", () => {
  it("över månads-, års- och skottårsgränser", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30"); // sommartid i Sverige
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26"); // vintertid
    expect(addDays("2026-11-02", 0)).toBe("2026-11-02");
  });

  it("daysBetween är to − from", () => {
    expect(daysBetween("2026-11-01", "2026-11-30")).toBe(29);
    expect(daysBetween("2026-11-30", "2026-11-01")).toBe(-29);
    expect(daysBetween("2024-01-01", "2025-01-01")).toBe(366);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("eachDay tar med båda ändar", () => {
    expect(eachDay("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(eachDay("2026-11-02", "2026-11-02")).toEqual(["2026-11-02"]);
    expect(eachDay("2026-11-02", "2026-11-01")).toEqual([]);
  });
});

describe("månader", () => {
  it("monthOf och daysInMonth", () => {
    expect(monthOf("2026-11-02")).toBe("2026-11");
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2024-02")).toBe(29);
    expect(daysInMonth("2100-02")).toBe(28);
    expect(daysInMonth("2000-02-10")).toBe(29);
    expect(daysInMonth("2026-04")).toBe(30);
    expect(daysInMonth("2026-12")).toBe(31);
    expect(monthEnd("2024-02")).toBe("2024-02-29");
  });

  it("addMonths och eachMonth", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-01", -13)).toBe("2024-12");
    expect(eachMonth("2026-11-15", "2027-02-01")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(eachMonth("2026-11-15", "2026-11-20")).toEqual(["2026-11"]);
  });

  it("monthsElapsed räknar hela månader", () => {
    expect(monthsElapsed("2026-01-15", "2026-02-14")).toBe(0);
    expect(monthsElapsed("2026-01-15", "2026-02-15")).toBe(1);
    expect(monthsElapsed("2026-01-31", "2026-02-28")).toBe(1);
    expect(monthsElapsed("2026-01-31", "2026-02-27")).toBe(0);
    expect(monthsElapsed("2026-01-01", "2027-01-01")).toBe(12);
    expect(monthsElapsed("2026-03-01", "2026-01-01")).toBe(-2);
  });
});

describe("ISO-veckor", () => {
  it.each([
    ["2026-01-01", "2026-W01"], // torsdag
    ["2026-11-02", "2026-W45"],
    ["2026-12-31", "2026-W53"], // 2026 har 53 veckor
    ["2027-01-01", "2026-W53"],
    ["2027-01-04", "2027-W01"],
    ["2024-12-30", "2025-W01"],
    ["2021-01-03", "2020-W53"],
    ["2008-12-29", "2009-W01"],
  ])("%s → %s", (date, key) => {
    expect(isoWeekLabel(date)).toBe(key);
  });

  it("vecka går måndag–söndag", () => {
    const w = weekOf("2026-11-04");
    expect(w).toMatchObject({ year: 2026, week: 45, start: "2026-11-02", end: "2026-11-08" });
    expect(dayOfWeek("2026-11-02")).toBe(1);
    expect(dayOfWeek("2026-11-08")).toBe(7);
  });

  it("stämmer med ISO-definitionen för varje dag 2000–2040", () => {
    for (let n = toDayNumber("2000-01-01"); n <= toDayNumber("2040-12-31"); n++) {
      const date = fromDayNumber(n);
      const dt = new Date(n * 86_400_000);
      const dow = dt.getUTCDay() || 7;
      expect(dayOfWeek(date)).toBe(dow);
      // Torsdagen i samma vecka avgör året.
      const thu = new Date((n - dow + 4) * 86_400_000);
      const y = thu.getUTCFullYear();
      const jan1 = Date.UTC(y, 0, 1) / 86_400_000;
      const week = Math.floor((n - dow + 4 - jan1) / 7) + 1;
      const w = weekOf(date);
      if (w.year !== y || w.week !== week) throw new Error(`Fel vecka för ${date}`);
    }
  });
});

describe("perioder", () => {
  it("periodDays, intersect, overlap", () => {
    expect(periodDays({ start: "2026-11-01", end: "2026-11-30" })).toBe(30);
    expect(
      intersectPeriods(
        { start: "2026-11-01", end: "2026-11-30" },
        { start: "2026-11-20", end: "2026-12-10" },
      ),
    ).toEqual({
      start: "2026-11-20",
      end: "2026-11-30",
    });
    expect(
      intersectPeriods(
        { start: "2026-11-01", end: "2026-11-10" },
        { start: "2026-11-11", end: "2026-11-12" },
      ),
    ).toBeNull();
    expect(
      overlapDays(
        { start: "2026-11-01", end: "2026-11-10" },
        { start: "2026-11-10", end: "2026-11-12" },
      ),
    ).toBe(1);
  });

  it("assertPeriod stoppar omvänd period", () => {
    expect(() => assertPeriod({ start: "2026-11-02", end: "2026-11-01" })).toThrow(/slutar/);
  });
});

describe("previousPeriod och monthPeriod", () => {
  it("lika lång period före", () => {
    expect(previousPeriod({ start: "2026-11-01", end: "2026-11-30" })).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
    });
    expect(previousPeriod({ start: "2026-11-03", end: "2026-11-09" })).toEqual({
      start: "2026-10-27",
      end: "2026-11-02",
    });
    expect(previousPeriod({ start: "2026-03-01", end: "2026-03-31" })).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
    expect(previousPeriod({ start: "2026-03-02", end: "2026-03-31" })).toEqual({
      start: "2026-01-31",
      end: "2026-03-01",
    });
  });

  it("monthPeriod", () => {
    expect(monthPeriod("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });
});
