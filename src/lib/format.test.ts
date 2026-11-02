import { describe, expect, it } from "vitest";
import {
  EN_DASH,
  MINUS,
  NBSP,
  formatCompact,
  formatCsvNumber,
  formatDate,
  formatDateTime,
  formatDay,
  formatDecimal,
  formatDelta,
  formatDuration,
  formatInt,
  formatKronor,
  formatMonth,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatPeriodShort,
  formatRelative,
  formatSek,
  formatSekAxis,
  formatSignedKronor,
  formatTime,
  formatTkr,
  formatWeekdayDay,
  weekdaysShort,
} from "./format";

/** "~" står för hårt mellanslag (U+00A0) i förväntade värden. */
const t = (s: string) => s.replace(/~/g, NBSP);

const NOW = new Date(2026, 10, 2, 9, 30); // mån 2 nov. 2026 09:30
const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const p = (a: Date, b: Date) => ({ start: a, end: b });

describe("tecken", () => {
  it("är rätt kodpunkter", () => {
    expect(NBSP).toBe(" ");
    expect(MINUS).toBe("−");
    expect(EN_DASH).toBe("–");
  });

  it("innehåller aldrig smalt mellanslag eller bindestreck", () => {
    const samples = [
      formatKronor(-1234567.891),
      formatPercent(-0.5),
      formatInt(-1_000_000),
      formatCompact(-12_400),
      formatSekAxis(-2_500_000),
    ];
    for (const s of samples) {
      expect(s).not.toMatch(/[   -]/);
    }
  });
});

describe("formatKronor", () => {
  it("två decimaler som standard", () => {
    expect(formatKronor(79987)).toBe(t("79~987,00~kr"));
    expect(formatKronor(79987.5)).toBe(t("79~987,50~kr"));
  });
  it("decimals: 0", () => {
    expect(formatKronor(79987, { decimals: 0 })).toBe(t("79~987~kr"));
    expect(formatKronor(79987.5, { decimals: 0 })).toBe(t("79~988~kr"));
  });
  it("noll och negativt", () => {
    expect(formatKronor(0)).toBe(t("0,00~kr"));
    expect(formatKronor(-1240)).toBe(t("−1~240,00~kr"));
    expect(formatKronor(-0.001)).toBe(t("0,00~kr"));
    expect(formatKronor(-0)).toBe(t("0,00~kr"));
  });
  it("avrundar halva öre uppåt", () => {
    expect(formatKronor(0.005)).toBe(t("0,01~kr"));
    expect(formatKronor(1.005)).toBe(t("1,01~kr"));
    expect(formatKronor(0.004)).toBe(t("0,00~kr"));
    expect(formatKronor(2.675)).toBe(t("2,68~kr"));
  });
  it("stora tal", () => {
    expect(formatKronor(12_345_678.9)).toBe(t("12~345~678,90~kr"));
    expect(formatKronor(1_000_000_000, { decimals: 0 })).toBe(t("1~000~000~000~kr"));
  });
  it("ej ändliga tal", () => {
    expect(formatKronor(NaN)).toBe("–");
    expect(formatKronor(Infinity)).toBe("–");
    expect(formatKronor(-Infinity)).toBe("–");
  });
});

describe("formatSignedKronor", () => {
  it("skriver alltid tecken", () => {
    expect(formatSignedKronor(1240)).toBe(t("+1~240,00~kr"));
    expect(formatSignedKronor(-1240)).toBe(t("−1~240,00~kr"));
    expect(formatSignedKronor(0)).toBe(t("±0,00~kr"));
    expect(formatSignedKronor(-0.001)).toBe(t("±0,00~kr"));
    expect(formatSignedKronor(1240.4, { decimals: 0 })).toBe(t("+1~240~kr"));
    expect(formatSignedKronor(NaN)).toBe("–");
  });
});

describe("formatSek (heltal, befintligt beteende)", () => {
  it("formaterar hela kronor", () => {
    expect(formatSek(12480)).toBe(t("12~480~kr"));
    expect(formatSek(12480.6)).toBe(t("12~481~kr"));
    expect(formatSek(-3200)).toBe(t("−3~200~kr"));
    expect(formatSek(0)).toBe(t("0~kr"));
  });

  it("avrundar halva kronor bort från noll, lika för båda tecknen", () => {
    expect(formatSek(384.5)).toBe(t("385~kr"));
    expect(formatSek(-384.5)).toBe(t("−385~kr"));
    expect(formatSek(-0.4)).toBe(t("0~kr"));
    expect(formatInt(-2.5)).toBe("−3");
    expect(formatInt(2.5)).toBe("3");
    expect(formatSek(-0.4)).toBe(t("0~kr"));
    expect(formatSek(NaN)).toBe("–");
  });
});

describe("formatSekAxis och formatTkr", () => {
  it("axelvärden", () => {
    expect(formatSekAxis(8000)).toBe(t("8~000"));
    expect(formatSekAxis(12000)).toBe(t("12~tkr"));
    expect(formatSekAxis(31100)).toBe(t("31,1~tkr"));
    expect(formatSekAxis(1_200_000)).toBe(t("1,2~mkr"));
    expect(formatSekAxis(-12000)).toBe(t("−12~tkr"));
    expect(formatSekAxis(0)).toBe("0");
    expect(formatSekAxis(Infinity)).toBe("–");
  });
  it("tkr", () => {
    expect(formatTkr(2900)).toBe(t("2,9~tkr"));
    expect(formatTkr(131_400)).toBe(t("131,4~tkr"));
    expect(formatTkr(5000)).toBe(t("5~tkr"));
    expect(formatTkr(NaN)).toBe("–");
  });
});

describe("tal", () => {
  it("formatInt", () => {
    expect(formatInt(12480)).toBe(t("12~480"));
    expect(formatInt(-12480.4)).toBe(t("−12~480"));
    expect(formatInt(0)).toBe("0");
    expect(formatInt(NaN)).toBe("–");
  });
  it("formatNumber", () => {
    expect(formatNumber(1234.567, 2)).toBe(t("1~234,57"));
    expect(formatNumber(1234.567)).toBe(t("1~235"));
    expect(formatNumber(-0.5, 1)).toBe("−0,5");
    expect(formatNumber(Infinity, 2)).toBe("–");
  });
  it("formatDecimal", () => {
    expect(formatDecimal(12.44)).toBe("12,4");
    expect(formatDecimal(-3)).toBe("−3,0");
    expect(formatDecimal(NaN)).toBe("–");
  });
  it("formatCompact", () => {
    expect(formatCompact(12_400)).toBe(t("12,4~tn"));
    expect(formatCompact(1_240_000)).toBe(t("1,2~mn"));
    expect(formatCompact(NaN)).toBe("–");
  });
  it("formatCsvNumber", () => {
    expect(formatCsvNumber(79987)).toBe("79987,00");
    expect(formatCsvNumber(-1240.5)).toBe("-1240,50");
    expect(formatCsvNumber(12_345_678.912, 0)).toBe("12345679");
    expect(formatCsvNumber(0.005)).toBe("0,01");
    expect(formatCsvNumber(-0.001)).toBe("0,00");
    expect(formatCsvNumber(NaN)).toBe("");
  });
});

describe("procent", () => {
  it("en decimal som standard", () => {
    expect(formatPercent(0.331)).toBe(t("33,1~%"));
    expect(formatPercent(1)).toBe(t("100,0~%"));
    expect(formatPercent(0)).toBe(t("0,0~%"));
  });
  it("digits som tal eller option", () => {
    expect(formatPercent(0.331, 0)).toBe(t("33~%"));
    expect(formatPercent(0.33149, { digits: 2 })).toBe(t("33,15~%"));
    expect(formatPercent(0.42, {})).toBe(t("42,0~%"));
  });
  it("negativt, avrundning och ej ändligt", () => {
    expect(formatPercent(-0.085)).toBe(t("−8,5~%"));
    expect(formatPercent(0.00005)).toBe(t("0,0~%"));
    expect(formatPercent(-0.00001)).toBe(t("0,0~%"));
    expect(formatPercent(12.5, 0)).toBe(t("1~250~%"));
    expect(formatPercent(NaN)).toBe("–");
  });
  it("formatDelta", () => {
    expect(formatDelta(0.42)).toBe(t("+42~%"));
    expect(formatDelta(-0.08)).toBe(t("−8~%"));
    expect(formatDelta(0)).toBe(t("±0~%"));
    expect(formatDelta(0.0004)).toBe(t("±0~%"));
    expect(formatDelta(0.064, 1)).toBe(t("+6,4~%"));
    expect(formatDelta(Infinity)).toBe("–");
  });
});

describe("formatDuration", () => {
  const s = 1000;
  const m = 60 * s;
  const h = 60 * m;
  it("enheter", () => {
    expect(formatDuration(0)).toBe(t("0~s"));
    expect(formatDuration(45 * s)).toBe(t("45~s"));
    expect(formatDuration(14 * m)).toBe(t("14~min"));
    expect(formatDuration(2 * h + 14 * m)).toBe(t("2~h 14~min"));
    expect(formatDuration(2 * h)).toBe(t("2~h"));
    expect(formatDuration(3 * 24 * h)).toBe(t("3~d"));
    expect(formatDuration(3 * 24 * h + 4 * h)).toBe(t("3~d 4~h"));
  });
  it("avrundning vid gränser", () => {
    expect(formatDuration(59.6 * s)).toBe(t("1~min"));
    expect(formatDuration(59 * m + 40 * s)).toBe(t("1~h"));
    expect(formatDuration(23 * h + 59 * m + 50 * s)).toBe(t("1~d"));
  });
  it("negativt och ej ändligt", () => {
    expect(formatDuration(-5 * m)).toBe(t("−5~min"));
    expect(formatDuration(NaN)).toBe("–");
  });
});

describe("datum och tid", () => {
  it("formatDateTime", () => {
    expect(formatDateTime(d(2026, 11, 1, 17, 17), { now: NOW })).toBe(t("1~nov. 17:17"));
    expect(formatDateTime(d(2025, 12, 28, 9, 5), { now: NOW })).toBe(t("28~dec.~2025 09:05"));
    expect(formatDateTime(d(2026, 11, 1, 17, 17), { year: "always" })).toBe(t("1~nov.~2026 17:17"));
  });
  it("formatDate", () => {
    expect(formatDate(d(2026, 11, 1))).toBe(t("1~nov.~2026"));
    expect(formatDate(d(2026, 11, 1), { year: "auto", now: NOW })).toBe(t("1~nov."));
    expect(formatDate(d(2025, 11, 1), { year: "auto", now: NOW })).toBe(t("1~nov.~2025"));
    expect(formatDate(d(2026, 3, 9), { year: "never" })).toBe(t("9~mars"));
    expect(formatDate(d(2028, 2, 29))).toBe(t("29~feb.~2028"));
    expect(formatDate(new Date(NaN))).toBe("–");
  });
  it("formatTime", () => {
    expect(formatTime(d(2026, 11, 1, 17, 17))).toBe("17:17");
    expect(formatTime(d(2026, 11, 1, 9, 5))).toBe("09:05");
    expect(formatTime(d(2026, 11, 1, 0, 0))).toBe("00:00");
  });
  it("formatMonth", () => {
    expect(formatMonth(d(2026, 11, 15))).toBe("november 2026");
    expect(formatMonth(d(2026, 1, 1), { year: "never" })).toBe("januari");
    expect(formatMonth(d(2026, 5, 1), { year: "auto", now: NOW })).toBe("maj");
  });
  it("formatDay och formatWeekdayDay (befintligt beteende)", () => {
    expect(formatDay(d(2026, 10, 26))).toBe(t("26~okt"));
    expect(formatWeekdayDay(d(2026, 10, 27))).toBe(t("tis 27~okt"));
    expect(weekdaysShort[0]).toBe("Mån");
  });
  it("tid över sommartidsskiftet (25 okt. 2026, 03:00 → 02:00)", () => {
    const before = new Date("2026-10-25T00:30:00Z"); // 02:30 CEST
    const after = new Date("2026-10-25T01:30:00Z"); // 02:30 CET
    expect(formatTime(before)).toBe("02:30");
    expect(formatTime(after)).toBe("02:30");
    expect(formatDate(after)).toBe(t("25~okt.~2026"));
  });
});

describe("formatRelative", () => {
  it("närtid", () => {
    expect(formatRelative(new Date(NOW.getTime() - 20_000), NOW)).toBe("nyss");
    expect(formatRelative(new Date(NOW.getTime() + 20_000), NOW)).toBe("nyss");
    expect(formatRelative(new Date(NOW.getTime() - 4 * 60_000), NOW)).toBe(t("för 4~min sedan"));
    expect(formatRelative(d(2026, 11, 2, 6, 10), NOW)).toBe(t("för 3~h sedan"));
  });
  it("igår, veckodag och äldre", () => {
    expect(formatRelative(d(2026, 11, 1, 17, 17), NOW)).toBe("igår 17:17");
    expect(formatRelative(d(2026, 10, 29, 8, 0), NOW)).toBe("tor 08:00");
    expect(formatRelative(d(2026, 10, 24, 17, 17), NOW)).toBe(t("24~okt. 17:17"));
    expect(formatRelative(d(2025, 10, 24, 17, 17), NOW)).toBe(t("24~okt.~2025 17:17"));
  });
  it("igår strax före midnatt, mindre än en timme sedan", () => {
    const now = d(2026, 11, 2, 0, 10);
    expect(formatRelative(d(2026, 11, 1, 23, 50), now)).toBe(t("för 20~min sedan"));
    expect(formatRelative(d(2026, 11, 1, 22, 0), now)).toBe("igår 22:00");
  });
  it("igår över sommartidsskiftet", () => {
    const now = d(2026, 10, 26, 0, 30);
    expect(formatRelative(d(2026, 10, 25, 1, 0), now)).toBe("igår 01:00");
  });
  it("framtid och ogiltigt", () => {
    expect(formatRelative(d(2026, 11, 3, 10, 0), NOW)).toBe(t("3~nov. 10:00"));
    expect(formatRelative(new Date(NaN), NOW)).toBe("–");
  });
});

describe("formatPeriod", () => {
  it("enskild dag", () => {
    expect(formatPeriod(p(d(2026, 11, 1), d(2026, 11, 1)))).toBe(t("1~nov.~2026"));
    expect(formatPeriod(p(d(2026, 11, 1, 8), d(2026, 11, 1, 20)))).toBe(t("1~nov.~2026"));
  });
  it("samma månad", () => {
    expect(formatPeriod(p(d(2026, 11, 3), d(2026, 11, 30)))).toBe(t("3–30~nov.~2026"));
    expect(formatPeriod(p(d(2026, 11, 1), d(2026, 11, 29)))).toBe(t("1–29~nov.~2026"));
  });
  it("hel månad, inklusive februari i skottår", () => {
    expect(formatPeriod(p(d(2026, 11, 1), d(2026, 11, 30)))).toBe("november 2026");
    expect(formatPeriod(p(d(2028, 2, 1), d(2028, 2, 29)))).toBe("februari 2028");
    expect(formatPeriod(p(d(2027, 2, 1), d(2027, 2, 28)))).toBe("februari 2027");
    expect(formatPeriod(p(d(2028, 2, 1), d(2028, 2, 28)))).toBe(t("1–28~feb.~2028"));
  });
  it("flera hela månader", () => {
    expect(formatPeriod(p(d(2026, 10, 1), d(2026, 11, 30)))).toBe("oktober–november 2026");
    expect(formatPeriod(p(d(2025, 12, 1), d(2026, 1, 31)))).toBe(t("december 2025~–~januari 2026"));
  });
  it("hela år", () => {
    expect(formatPeriod(p(d(2026, 1, 1), d(2026, 12, 31)))).toBe("2026");
    expect(formatPeriod(p(d(2025, 1, 1), d(2026, 12, 31)))).toBe("2025–2026");
  });
  it("över månadsgräns och årets början", () => {
    expect(formatPeriod(p(d(2026, 10, 3), d(2026, 11, 1)))).toBe(t("3~okt.~–~1~nov.~2026"));
    expect(formatPeriod(p(d(2026, 1, 1), d(2026, 11, 1)))).toBe(t("1~jan.~–~1~nov.~2026"));
  });
  it("över årsskifte", () => {
    expect(formatPeriod(p(d(2025, 12, 28), d(2026, 1, 3)))).toBe(t("28~dec.~2025~–~3~jan.~2026"));
  });
  it("omvänd ordning och sommartidsskifte", () => {
    expect(formatPeriod(p(d(2026, 11, 30), d(2026, 11, 3)))).toBe(t("3–30~nov.~2026"));
    expect(formatPeriod(p(d(2026, 10, 1), d(2026, 10, 31)))).toBe("oktober 2026");
    expect(formatPeriod(p(d(2026, 10, 20), d(2026, 10, 27)))).toBe(t("20–27~okt.~2026"));
  });
  it("ogiltigt datum", () => {
    expect(formatPeriod(p(new Date(NaN), d(2026, 1, 1)))).toBe("–");
  });
});

describe("formatPeriodShort", () => {
  it("utelämnar innevarande år", () => {
    expect(formatPeriodShort(p(d(2026, 11, 1), d(2026, 11, 1)), NOW)).toBe(t("1~nov."));
    expect(formatPeriodShort(p(d(2026, 11, 3), d(2026, 11, 30)), NOW)).toBe(t("3–30~nov."));
    expect(formatPeriodShort(p(d(2026, 10, 3), d(2026, 11, 1)), NOW)).toBe(t("3~okt.~–~1~nov."));
    expect(formatPeriodShort(p(d(2026, 11, 1), d(2026, 11, 30)), NOW)).toBe("nov.");
  });
  it("skriver år när perioden ligger i ett annat år", () => {
    expect(formatPeriodShort(p(d(2025, 11, 1), d(2025, 11, 30)), NOW)).toBe(t("nov.~2025"));
    expect(formatPeriodShort(p(d(2025, 11, 3), d(2025, 11, 9)), NOW)).toBe(t("3–9~nov.~2025"));
    expect(formatPeriodShort(p(d(2025, 1, 1), d(2025, 12, 31)), NOW)).toBe("2025");
    expect(formatPeriodShort(p(d(2025, 12, 28), d(2026, 1, 3)), NOW)).toBe(
      t("28~dec.~2025~–~3~jan."),
    );
  });
});
