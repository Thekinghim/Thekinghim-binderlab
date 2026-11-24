import { describe, expect, it } from "vitest";

import { keyboardUp, looksStuck, nextHealthy, pinShift } from "./viewport-pin";

const base = {
  naturalBottom: 844,
  visibleBottom: 844,
  healthyBottom: 844,
  scale: 1,
  typing: false,
};

describe("pinShift", () => {
  it("rör inget när det fasta innehållet redan ligger längst ner", () => {
    expect(pinShift(base)).toBe(0);
  });

  it("flyttar ner raden när vyn fastnat en tangentbordshöjd för kort (även visualViewport)", () => {
    // Hemskärmsappen efter tangentbordet: innerHeight, fixed-botten och visualViewport säger 544.
    expect(pinShift({ ...base, naturalBottom: 544, visibleBottom: 544 })).toBe(300);
  });

  it("använder visualViewport när den är rätt men layoutvyn fel", () => {
    expect(pinShift({ ...base, naturalBottom: 530, healthyBottom: 0 })).toBe(314);
  });

  it("i vanliga Safari (ingen frisk höjd) gäller visualViewport som förut", () => {
    expect(pinShift({ ...base, naturalBottom: 544, visibleBottom: 544, healthyBottom: 0 })).toBe(0);
  });

  it("låter raden vara medan man skriver, när sidan är inzoomad och utan mått", () => {
    expect(pinShift({ ...base, naturalBottom: 544, visibleBottom: 544, typing: true })).toBe(0);
    expect(pinShift({ ...base, naturalBottom: 544, scale: 1.5 })).toBe(0);
    expect(pinShift({ ...base, naturalBottom: 0 })).toBe(0);
  });

  it("struntar i småsaker och orimliga värden", () => {
    expect(pinShift({ ...base, naturalBottom: 843 })).toBe(0);
    expect(pinShift({ ...base, naturalBottom: 100, visibleBottom: 100 })).toBe(0);
  });
});

describe("nextHealthy", () => {
  const sample = {
    innerHeight: 844,
    visibleBottom: 844,
    naturalBottom: 844,
    typing: false,
    scale: 1,
    screenMax: 852,
  };

  it("minns den största höjden och sjunker aldrig av en fastnad vy", () => {
    expect(nextHealthy(0, sample)).toBe(844);
    expect(
      nextHealthy(844, { ...sample, innerHeight: 544, visibleBottom: 544, naturalBottom: 544 }),
    ).toBe(844);
  });

  it("lär sig inget medan man skriver eller zoomar", () => {
    expect(nextHealthy(0, { ...sample, typing: true })).toBe(0);
    expect(nextHealthy(0, { ...sample, scale: 2 })).toBe(0);
  });

  it("blir aldrig högre än skärmen", () => {
    expect(nextHealthy(0, { ...sample, innerHeight: 2000 })).toBe(852);
  });
});

describe("looksStuck och keyboardUp", () => {
  it("vyn är fast när den är kortare än den friska och ingen skriver", () => {
    expect(looksStuck({ innerHeight: 544, healthyBottom: 844, offsetTop: 0, typing: false })).toBe(
      true,
    );
    expect(looksStuck({ innerHeight: 844, healthyBottom: 844, offsetTop: 0, typing: false })).toBe(
      false,
    );
    expect(looksStuck({ innerHeight: 844, healthyBottom: 844, offsetTop: 40, typing: false })).toBe(
      true,
    );
    expect(looksStuck({ innerHeight: 544, healthyBottom: 844, offsetTop: 0, typing: true })).toBe(
      false,
    );
    expect(looksStuck({ innerHeight: 544, healthyBottom: 0, offsetTop: 0, typing: false })).toBe(
      false,
    );
  });

  it("tangentbordet räknas som uppe bara när man skriver och vyn krympt", () => {
    expect(keyboardUp({ typing: true, visibleHeight: 500, fullHeight: 844 })).toBe(true);
    expect(keyboardUp({ typing: true, visibleHeight: 844, fullHeight: 844 })).toBe(false);
    expect(keyboardUp({ typing: false, visibleHeight: 500, fullHeight: 844 })).toBe(false);
  });
});
