import { describe, expect, it } from "vitest";

import { refillWarning } from "./display";

const NB = " ";

describe("refillWarning (~58 h/vecka stod två gånger utan att säga var det kom ifrån)", () => {
  it("mätningen på Effekt: säger värdet, månaden, vad planen räknar med och länkar dit", () => {
    const w = refillWarning({
      ignored: { minutes: 3_462, source: "data" },
      usedMinutes: 45,
      measurement: { month: "2026-11", minutesPerMonth: 15_000 },
    });
    expect(w).toEqual({
      text: `Effekt har ~250${NB}h påfyllning för november 2026 (~58${NB}h per automat och vecka). Troligen fel, så planen räknar med 45${NB}min per automat och vecka.`,
      href: "/effekt",
      cta: "Rätta på Effekt",
    });
  });

  it("eget sparat värde: ingen länk (Ändra står i kortet)", () => {
    const w = refillWarning({
      ignored: { minutes: 601, source: "saved" },
      usedMinutes: 45,
      measurement: null,
    });
    expect(w?.href).toBeUndefined();
    expect(w?.text).toContain(`~10${NB}h per automat och vecka verkar fel`);
  });

  it("rimligt värde: ingen varning", () => {
    expect(refillWarning({ ignored: null, usedMinutes: 45, measurement: null })).toBeNull();
  });
});
