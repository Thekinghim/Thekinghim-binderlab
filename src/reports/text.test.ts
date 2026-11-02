import { describe, expect, it } from "vitest";
import {
  countText,
  dateText,
  krText,
  listText,
  monthText,
  pctText,
  periodText,
  pointsText,
  shortDateText,
  signedKrText,
  signedPctText,
  weekText,
} from "./text";

const plain = (s: string) => s.replace(/ /g, " ");

describe("belopp", () => {
  it("visar öre bara när beloppet inte är jämna kronor", () => {
    expect(plain(krText(490_000))).toBe("4 900 kr");
    expect(plain(krText(490_050))).toBe("4 900,50 kr");
    expect(plain(krText(5))).toBe("0,05 kr");
    expect(plain(krText(0))).toBe("0 kr");
    expect(plain(krText(-12_000))).toBe("−120 kr");
    expect(plain(krText(490_000, "always"))).toBe("4 900,00 kr");
    expect(plain(krText(-7, "always"))).toBe("−0,07 kr");
  });

  it("hela kronor avrundas halva uppåt, utan −0", () => {
    expect(plain(krText(150, "never"))).toBe("2 kr");
    expect(plain(krText(149, "never"))).toBe("1 kr");
    expect(plain(krText(-150, "never"))).toBe("−2 kr");
    expect(plain(krText(-40, "never"))).toBe("0 kr");
  });

  it("med tecken", () => {
    expect(plain(signedKrText(120_000))).toBe("+1 200 kr");
    expect(plain(signedKrText(-8000))).toBe("−80 kr");
    expect(plain(signedKrText(0))).toBe("±0 kr");
  });
});

describe("procent", () => {
  it("bp som procent, noll eller en decimal", () => {
    expect(plain(pctText(3300))).toBe("33 %");
    expect(plain(pctText(3350))).toBe("34 %");
    expect(plain(pctText(2520, 1))).toBe("25,2 %");
    expect(plain(pctText(5, 1))).toBe("0,1 %");
    expect(plain(pctText(-1234, 1))).toBe("−12,3 %");
    expect(plain(pctText(-40))).toBe("0 %");
    expect(plain(pctText(1_234_550))).toBe("12 346 %");
  });

  it("förändring och procentenheter", () => {
    expect(plain(signedPctText(1200))).toBe("+12 %");
    expect(plain(signedPctText(-800))).toBe("−8 %");
    expect(plain(signedPctText(20))).toBe("±0 %");
    expect(plain(pointsText(120))).toBe("+1,2 procentenheter");
    expect(plain(pointsText(-50))).toBe("−0,5 procentenheter");
  });
});

describe("datum och perioder", () => {
  it("månader och datum", () => {
    expect(monthText("2026-11")).toBe("november 2026");
    expect(dateText("2026-03-01")).toBe("1 mars 2026");
    expect(shortDateText("2026-02-28")).toBe("28 feb.");
    expect(plain(weekText("2026-11-04"))).toBe("v. 45");
    expect(plain(weekText("2027-01-01"))).toBe("v. 53");
  });

  it("perioder", () => {
    expect(periodText({ start: "2026-11-01", end: "2026-11-30" })).toBe("november 2026");
    expect(periodText({ start: "2024-02-01", end: "2024-02-29" })).toBe("februari 2024");
    expect(periodText({ start: "2026-02-01", end: "2026-02-27" })).toBe("1–27 feb. 2026");
    expect(periodText({ start: "2026-10-20", end: "2026-11-10" })).toBe("20 okt.–10 nov. 2026");
    expect(periodText({ start: "2025-12-20", end: "2026-01-10" })).toBe(
      "20 dec. 2025–10 jan. 2026",
    );
    expect(periodText({ start: "2026-11-16", end: "2026-11-16" })).toBe("16 nov. 2026");
    expect(periodText({ start: "2026-01-01", end: "2026-12-31" })).toBe("1 jan.–31 dec. 2026");
  });

  it("ogiltiga datum ger fel", () => {
    expect(() => dateText("2026-02-30")).toThrow();
    expect(() => monthText("2026-13")).toThrow();
  });
});

describe("antal och listor", () => {
  it("böjning och uppräkning", () => {
    expect(plain(countText(1, "dag", "dagar"))).toBe("1 dag");
    expect(plain(countText(1200, "dag", "dagar"))).toBe("1 200 dagar");
    expect(listText([])).toBe("");
    expect(listText(["A"])).toBe("A");
    expect(listText(["A", "B"])).toBe("A och B");
    expect(listText(["A", "B", "C"])).toBe("A, B och C");
  });
});
