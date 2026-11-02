/**
 * Snabbvägarna i time.ts (prestanda, fas 7) ska ge exakt samma svar som den långsamma
 * vägen: localParts mot Intl (intlParts) och tryParseInstant utan undantag.
 */

import { describe, expect, it } from "vitest";

import { intlParts, localParts, parseInstant, tryParseInstant } from "./time";

const ZONES = [
  "Europe/Stockholm",
  "Asia/Shanghai",
  "UTC",
  "America/New_York",
  "America/St_Johns", // −3:30 / −2:30
  "Asia/Kathmandu", // +5:45
  "Australia/Lord_Howe", // sommartid med 30 minuter
  "Pacific/Chatham", // +12:45 / +13:45
  "Australia/Eucla", // +8:45
  "America/Santiago",
];

/** Deterministisk slump (samma följd varje körning). */
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("localParts (snabbväg per timme)", () => {
  it.each(ZONES)("ger samma datum och klockslag som Intl i %s", (zone) => {
    const rand = lcg(zone.length * 7919);
    const from = Date.UTC(1971, 0, 1);
    const to = Date.UTC(2101, 0, 1);
    for (let i = 0; i < 4_000; i++) {
      const ms = Math.floor(from + rand() * (to - from));
      expect(localParts(ms, zone), `${zone} ${new Date(ms).toISOString()}`).toEqual(
        intlParts(ms, zone),
      );
    }
  });

  it.each(ZONES)("stämmer minut för minut runt sommartidsskiftena 2026 i %s", (zone) => {
    // Varje minut i dygnen runt de vanliga skiftesdatumen (norra och södra halvklotet).
    const days = [
      "2026-03-08",
      "2026-03-29",
      "2026-04-05",
      "2026-09-06",
      "2026-09-27",
      "2026-10-04",
      "2026-10-25",
      "2026-11-01",
    ];
    for (const d of days) {
      const start = Date.parse(`${d}T00:00:00Z`) - 12 * 3_600_000;
      for (let m = 0; m < 48 * 60; m += 1) {
        const ms = start + m * 60_000 + 59_999 * (m % 2);
        expect(localParts(ms, zone), `${zone} ${new Date(ms).toISOString()}`).toEqual(
          intlParts(ms, zone),
        );
      }
    }
  });

  it("går den långsamma vägen före 1972 och efter 2099", () => {
    for (const ms of [Date.UTC(1879, 0, 1, 12), Date.UTC(1900, 5, 1, 3, 7), Date.UTC(2150, 6, 1)]) {
      expect(localParts(ms, "Europe/Stockholm")).toEqual(intlParts(ms, "Europe/Stockholm"));
    }
  });

  it("kastar som Intl för ogiltiga tidpunkter", () => {
    expect(() => localParts(Number.NaN)).toThrow(RangeError);
  });
});

describe("tryParseInstant utan undantag", () => {
  it("ger samma värde som parseInstant, och null där parseInstant kastar", () => {
    const values: Array<Date | string | number> = [
      "2026-11-01T16:17:00Z",
      "2026-11-01T16:17:00.123+01:00",
      "2026-11-01T16:17+0100",
      "2026-11-01 16:17:00+00",
      "2026-11-01T16:17",
      "2026-13-01T16:17:00Z",
      "",
      "nonsens",
      new Date(Date.UTC(2026, 10, 1)),
      new Date(Number.NaN),
      1_762_000_000_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    for (const v of values) {
      let expected: number | null;
      try {
        expected = parseInstant(v);
      } catch {
        expected = null;
      }
      expect(tryParseInstant(v), String(v)).toBe(expected);
    }
  });
});
