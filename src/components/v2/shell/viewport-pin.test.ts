import { describe, expect, it } from "vitest";

import { pinShift } from "./viewport-pin";

const base = {
  rectBottom: 844,
  currentShift: 0,
  rectHeight: 90,
  visibleBottom: 844,
  scale: 1,
  typing: false,
};

describe("pinShift", () => {
  it("rör inget när raden redan ligger längst ner", () => {
    expect(pinShift(base)).toBe(0);
  });

  it("flyttar ner raden när Safari ritar den en tangentbordshöjd för högt", () => {
    expect(pinShift({ ...base, rectBottom: 530 })).toBe(314);
  });

  it("räknar från radens naturliga läge när den redan är flyttad", () => {
    // Raden är flyttad 314 px och ligger nu rätt: förskjutningen ska ligga kvar.
    expect(pinShift({ ...base, rectBottom: 844, currentShift: 314 })).toBe(314);
    // Felet har släppt (vyn är hel igen): flytten tas bort.
    expect(pinShift({ ...base, rectBottom: 1158, currentShift: 314 })).toBe(0);
  });

  it("låter raden vara medan man skriver, när sidan är inzoomad och när den är dold", () => {
    expect(pinShift({ ...base, rectBottom: 530, typing: true })).toBe(0);
    expect(pinShift({ ...base, rectBottom: 530, scale: 1.5 })).toBe(0);
    expect(pinShift({ ...base, rectBottom: 0, rectHeight: 0 })).toBe(0);
  });

  it("struntar i småsaker och orimliga värden", () => {
    expect(pinShift({ ...base, rectBottom: 843 })).toBe(0);
    expect(pinShift({ ...base, rectBottom: -2000 })).toBe(0);
  });
});
