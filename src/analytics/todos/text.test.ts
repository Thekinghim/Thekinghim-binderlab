import { describe, expect, it } from "vitest";
import {
  day,
  kr,
  krExact,
  pct,
  pct1,
  periodText,
  plural,
  ratioTenths,
  sentence,
  tenths,
  weekdayDay,
} from "./text";

const S = " ";

describe("text", () => {
  it("kronor avrundas till hela kronor, halva uppåt", () => {
    expect(kr(123_456)).toBe(`1${S}235${S}kr`);
    expect(kr(150)).toBe(`2${S}kr`);
    expect(kr(149)).toBe(`1${S}kr`);
    expect(kr(-150)).toBe(`−2${S}kr`);
    expect(kr(0)).toBe(`0${S}kr`);
  });

  it("kronor med ören utan flyttal", () => {
    expect(krExact(-350)).toBe(`−3,50${S}kr`);
    expect(krExact(4_900)).toBe(`49,00${S}kr`);
    expect(krExact(5)).toBe(`0,05${S}kr`);
    expect(krExact(123_456_789)).toBe(`1${S}234${S}567,89${S}kr`);
  });

  it("procent från bp", () => {
    expect(pct(3_312)).toBe(`33${S}%`);
    expect(pct(3_350)).toBe(`34${S}%`);
    expect(pct1(352)).toBe(`3,5${S}%`);
    expect(pct1(345)).toBe(`3,5${S}%`);
    expect(pct1(1_200)).toBe(`12,0${S}%`);
    expect(pct(0)).toBe(`0${S}%`);
  });

  it("tiondelar och kvoter", () => {
    expect(tenths(14)).toBe("1,4");
    expect(tenths(30)).toBe("3,0");
    expect(tenths(5)).toBe("0,5");
    expect(ratioTenths(41, 14)).toBe("2,9");
  });

  it("plural", () => {
    expect(plural(1, "dag", "dagar")).toBe(`1${S}dag`);
    expect(plural(2, "dag", "dagar")).toBe(`2${S}dagar`);
    expect(plural(0, "dag", "dagar")).toBe(`0${S}dagar`);
  });

  it("datum och perioder utan Date", () => {
    expect(day("2026-10-31")).toBe(`31${S}okt.`);
    expect(day("2026-03-01")).toBe(`1${S}mars`);
    expect(weekdayDay("2026-10-31")).toBe(`lör 31${S}okt.`);
    expect(periodText({ start: "2026-11-01", end: "2026-11-30" })).toBe(`1–30${S}nov.`);
    expect(periodText({ start: "2026-10-28", end: "2026-11-03" })).toBe(
      `28${S}okt.${S}–${S}3${S}nov.`,
    );
    expect(periodText({ start: "2026-11-01", end: "2026-11-01" })).toBe(`1${S}nov.`);
  });
});

describe("sentence", () => {
  it("lägger till punkt men aldrig dubbel punkt efter förkortning", () => {
    expect(sentence("Slut 4 nov.")).toBe("Slut 4 nov.");
    expect(sentence("Slut 4 maj")).toBe("Slut 4 maj.");
  });
});
