import { describe, expect, it } from "vitest";

import { parseNayaxStatement } from "@/server/accounting/nayax-statement";
import { extractPdfLines } from "@/server/accounting/pdf-text";
import { octoberPdf } from "@/server/accounting/testing/nayax-pdf";

import {
  cardFeeBpOf,
  cardFeeHelp,
  deductionText,
  devicesText,
  nayaxPaysText,
  nayaxSoldText,
  pctBp,
  salesMatchText,
} from "./nayax";

const { statement } = parseNayaxStatement(extractPdfLines(octoberPdf()));
const plain = (s: string) => s.replace(/[ ⁠]/g, " ");

describe("texterna om Nayax-rapporten", () => {
  it("procent ur baspunkter", () => {
    expect(plain(pctBp(400))).toBe("4,0 %");
    expect(plain(pctBp(150))).toBe("1,5 %");
    expect(plain(pctBp(395))).toBe("3,95 %");
    expect(plain(pctBp(0))).toBe("0 %");
  });

  it("vad Nayax betalar och när", () => {
    expect(plain(nayaxPaysText(statement, "2026-11-12"))).toBe(
      "Nayax betalar 72 330,48 kr senast 16 nov.",
    );
    expect(plain(nayaxPaysText(statement, "2026-12-01"))).toBe(
      "Nayax betalade 72 330,48 kr senast 16 nov.",
    );
    expect(plain(nayaxPaysText({ ...statement, payoutUntil: null }, "2026-11-12"))).toBe(
      "Nayax betalar 72 330,48 kr.",
    );
  });

  it("sålt, avgifter och engångsavgift i en mening", () => {
    expect(plain(nayaxSoldText(statement))).toBe(
      "Sålt 76 245 kr, avgifter 3 089,80 kr (kortavgift 4,0 %), engångsavgift 824,72 kr.",
    );
    // Bara kortavgift: procenten står ensam.
    expect(
      plain(nayaxSoldText({ ...statement, feesOre: 304_980, cardFeeOre: 304_980, deductions: [] })),
    ).toBe("Sålt 76 245 kr, avgifter 3 049,80 kr (4,0 %).");
  });

  it("varje avdrag på en egen rad med klartext", () => {
    expect(statement.deductions.map((d) => plain(deductionText(d)))).toEqual([
      "Bankavgift hos Nayax: 40,00 kr",
      "Engångsavgift hos Nayax: 824,72 kr (Onboarding fee)",
    ]);
    expect(plain(deductionText({ kind: "adjustment", reason: "Refund", amountOre: -5_000 }))).toBe(
      "Tillägg från Nayax: 50,00 kr (Refund)",
    );
  });

  it("stämmer med appen eller inte, med båda talen", () => {
    expect(salesMatchText(7_624_500, 7_624_500)).toEqual({
      ok: true,
      text: "Det stämmer med appens försäljning.",
    });
    expect(salesMatchText(7_624_500, 7_624_450).ok).toBe(true);
    const off = salesMatchText(7_624_500, 7_251_100);
    expect(off.ok).toBe(false);
    expect(plain(off.text)).toBe(
      "Det stämmer inte med appen. Appen har sålt för 72 511,00 kr samma dagar. Nayax har 76 245,00 kr. Skillnad 3 734,00 kr.",
    );
  });

  it("automaterna på en rad", () => {
    expect(plain(devicesText(statement))).toBe("Sega Gubben 72 511 kr · Ny 3 20261016 3 734 kr");
  });

  it("kortavgiften: en rad och en knapp, bara när den skiljer sig", () => {
    expect(cardFeeBpOf(statement)).toBe(400);
    const help = cardFeeHelp(400, 0)!;
    expect(plain(help.text)).toBe("Nayax tar 4,0 % i kortavgift. Appen räknar med 0 %.");
    expect(plain(help.button)).toBe("Ändra till 4,0 %");
    expect(cardFeeHelp(400, 400)).toBeNull();
    expect(cardFeeHelp(null, 0)).toBeNull();
  });
});
