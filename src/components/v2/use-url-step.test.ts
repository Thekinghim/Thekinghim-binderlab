import { describe, expect, it } from "vitest";

import { parseStep, stepHref } from "./use-url-step";

describe("steget i adressen", () => {
  it("läser ?steg= från 1 till antalet steg", () => {
    expect(parseStep(null, 4)).toBeNull();
    expect(parseStep("1", 4)).toBe(0);
    expect(parseStep("4", 4)).toBe(3);
    for (const bad of ["0", "5", "-1", "2.5", "x", ""]) expect(parseStep(bad, 4)).toBeNull();
  });

  it("byter steget och behåller andra parametrar", () => {
    expect(stepHref("/avtal", "?skapa=store%3Ax", "steg", 1)).toBe("/avtal?skapa=store%3Ax&steg=2");
    expect(stepHref("/butiker/ny", "?steg=3", "steg", null)).toBe("/butiker/ny");
    expect(stepHref("/butiker/ny", "", "steg", 2)).toBe("/butiker/ny?steg=3");
  });
});
