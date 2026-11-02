import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarDaysBetween,
  daysInPeriod,
  endOfMonth,
  isFullMonth,
  normalizePeriod,
  periodFromPreset,
  periodPresets,
  previousPeriod,
  startOfDay,
  type Period,
} from "./period";

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const NOW = d(2026, 11, 2, 9, 30);

/** "2026-11-02–2026-11-02" i lokal tid, för läsbara jämförelser. */
function iso(p: Period): string {
  const f = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return `${f(p.start)}/${f(p.end)}`;
}

describe("tidszon", () => {
  it("testerna körs i Europe/Stockholm", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Europe/Stockholm");
    expect(d(2026, 7, 1).getTimezoneOffset()).toBe(-120);
    expect(d(2026, 1, 1).getTimezoneOffset()).toBe(-60);
  });
});

describe("periodFromPreset", () => {
  it("idag", () => {
    expect(iso(periodFromPreset("idag", NOW))).toBe("2026-11-02/2026-11-02");
    expect(periodFromPreset("idag", NOW).start.getHours()).toBe(0);
  });
  it("senaste N dagar inklusive idag", () => {
    expect(iso(periodFromPreset("7d", NOW))).toBe("2026-10-27/2026-11-02");
    expect(iso(periodFromPreset("30d", NOW))).toBe("2026-10-04/2026-11-02");
    expect(iso(periodFromPreset("90d", NOW))).toBe("2026-08-05/2026-11-02");
    expect(daysInPeriod(periodFromPreset("7d", NOW))).toBe(7);
    expect(daysInPeriod(periodFromPreset("30d", NOW))).toBe(30);
    expect(daysInPeriod(periodFromPreset("90d", NOW))).toBe(90);
  });
  it("månad, förra månaden, året hittills", () => {
    expect(iso(periodFromPreset("manad", NOW))).toBe("2026-11-01/2026-11-02");
    expect(iso(periodFromPreset("forra-manaden", NOW))).toBe("2026-10-01/2026-10-31");
    expect(iso(periodFromPreset("atd", NOW))).toBe("2026-01-01/2026-11-02");
  });
  it("förra månaden över årsskifte och i skottår", () => {
    expect(iso(periodFromPreset("forra-manaden", d(2027, 1, 15)))).toBe("2026-12-01/2026-12-31");
    expect(iso(periodFromPreset("forra-manaden", d(2028, 3, 31)))).toBe("2028-02-01/2028-02-29");
  });
  it("7d över årsskifte", () => {
    expect(iso(periodFromPreset("7d", d(2027, 1, 3)))).toBe("2026-12-28/2027-01-03");
  });
  it("alla förval har etiketter", () => {
    for (const preset of periodPresets) {
      expect(daysInPeriod(periodFromPreset(preset.id, NOW))).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
});

describe("daysInPeriod", () => {
  it("samma dag är en dag", () => {
    expect(daysInPeriod({ start: d(2026, 11, 1, 8), end: d(2026, 11, 1, 23, 59) })).toBe(1);
  });
  it("månader och skottår", () => {
    expect(daysInPeriod({ start: d(2026, 11, 1), end: d(2026, 11, 30) })).toBe(30);
    expect(daysInPeriod({ start: d(2028, 2, 1), end: d(2028, 2, 29) })).toBe(29);
    expect(daysInPeriod({ start: d(2028, 1, 1), end: d(2028, 12, 31) })).toBe(366);
    expect(daysInPeriod({ start: d(2026, 1, 1), end: d(2026, 12, 31) })).toBe(365);
  });
  it("över sommartidsskiften (25-timmars- och 23-timmarsdygn)", () => {
    expect(daysInPeriod({ start: d(2026, 10, 24), end: d(2026, 10, 26) })).toBe(3);
    expect(daysInPeriod({ start: d(2026, 3, 28), end: d(2026, 3, 30) })).toBe(3);
    expect(calendarDaysBetween(d(2026, 10, 25, 23, 59), d(2026, 10, 26, 0, 1))).toBe(1);
  });
});

describe("previousPeriod", () => {
  it("lika lång period direkt före", () => {
    expect(iso(previousPeriod({ start: d(2026, 11, 1), end: d(2026, 11, 30) }))).toBe(
      "2026-10-02/2026-10-31",
    );
    expect(iso(previousPeriod(periodFromPreset("7d", NOW)))).toBe("2026-10-20/2026-10-26");
    expect(iso(previousPeriod(periodFromPreset("idag", NOW)))).toBe("2026-11-01/2026-11-01");
  });
  it("över årsskifte och skottdag", () => {
    expect(iso(previousPeriod({ start: d(2027, 1, 1), end: d(2027, 1, 7) }))).toBe(
      "2026-12-25/2026-12-31",
    );
    expect(iso(previousPeriod({ start: d(2028, 3, 1), end: d(2028, 3, 2) }))).toBe(
      "2028-02-28/2028-02-29",
    );
  });
  it("över sommartidsskiftet behåller midnatt", () => {
    const prev = previousPeriod({ start: d(2026, 10, 26), end: d(2026, 11, 1) });
    expect(iso(prev)).toBe("2026-10-19/2026-10-25");
    expect(prev.end.getHours()).toBe(0);
    expect(daysInPeriod(prev)).toBe(7);
  });
});

describe("hjälpfunktioner", () => {
  it("addDays över sommartid ger midnatt", () => {
    const x = addDays(d(2026, 10, 24), 2);
    expect(x.getDate()).toBe(26);
    expect(x.getHours()).toBe(0);
  });
  it("startOfDay, endOfMonth", () => {
    expect(startOfDay(NOW).getHours()).toBe(0);
    expect(endOfMonth(d(2028, 2, 10)).getDate()).toBe(29);
    expect(endOfMonth(d(2026, 12, 10)).getDate()).toBe(31);
  });
  it("normalizePeriod byter ordning", () => {
    expect(iso(normalizePeriod({ start: d(2026, 11, 30), end: d(2026, 11, 1) }))).toBe(
      "2026-11-01/2026-11-30",
    );
  });
  it("isFullMonth", () => {
    expect(isFullMonth({ start: d(2026, 2, 1), end: d(2026, 2, 28) })).toBe(true);
    expect(isFullMonth({ start: d(2028, 2, 1), end: d(2028, 2, 28) })).toBe(false);
    expect(isFullMonth({ start: d(2026, 1, 1), end: d(2026, 2, 28) })).toBe(false);
  });
});
