import { describe, expect, it } from "vitest";

import {
  forgetsHealthy,
  HealthyTracker,
  healthyReading,
  keyboardUp,
  looksStuck,
  pinShift,
  screenHeightFor,
} from "./viewport-pin";

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

// iPhone 14-ish: skärmen 390 × 844 (screen.* är alltid stående), stående vy 390 × 844.
const portrait = {
  innerWidth: 390,
  innerHeight: 844,
  vvWidth: 390,
  visibleBottom: 844,
  naturalBottom: 844,
  typing: false,
  scale: 1,
  screenMin: 390,
  screenMax: 844,
};
const landscape = {
  ...portrait,
  innerWidth: 844,
  innerHeight: 390,
  vvWidth: 844,
  visibleBottom: 390,
  naturalBottom: 390,
};

/** Två likadana bildrutor i rad, som när vyn står still. */
function settle(t: HealthyTracker, s: typeof portrait) {
  t.sample(s);
  return t.sample(s).healthy;
}

describe("screenHeightFor och healthyReading", () => {
  it("väljer skärmsidan efter läget", () => {
    expect(screenHeightFor(390, 390, 844)).toBe(844);
    expect(screenHeightFor(844, 390, 844)).toBe(390);
    expect(screenHeightFor(390, 0, 0)).toBe(0);
  });

  it("kapar en kvarglömd stående höjd i liggande läge", () => {
    expect(healthyReading({ ...landscape, innerHeight: 844, naturalBottom: 844 })).toBe(390);
  });

  it("litar inte på avläsningar mitt i en vridning, medan man skriver eller zoomar", () => {
    expect(healthyReading({ ...portrait, vvWidth: 844 })).toBeNull();
    expect(healthyReading({ ...portrait, typing: true })).toBeNull();
    expect(healthyReading({ ...portrait, scale: 2 })).toBeNull();
    expect(
      healthyReading({ ...portrait, innerHeight: 0, visibleBottom: 0, naturalBottom: 0 }),
    ).toBeNull();
  });

  it("blir aldrig högre än skärmen", () => {
    expect(healthyReading({ ...portrait, innerHeight: 2000 })).toBe(844);
  });
});

describe("HealthyTracker", () => {
  it("lär sig höjden först när den stått still två bildrutor", () => {
    const t = new HealthyTracker();
    expect(t.sample(portrait)).toEqual({ healthy: 0, confirm: true });
    expect(t.sample(portrait)).toEqual({ healthy: 844, confirm: false });
    expect(t.get(390)).toBe(844);
    expect(t.get(844)).toBe(0);
  });

  it("sjunker aldrig av en fastnad vy", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    const stuck = { ...portrait, innerHeight: 544, visibleBottom: 544, naturalBottom: 544 };
    expect(settle(t, stuck)).toBe(844);
  });

  it("en ensam felaktig bildruta lärs inte in", () => {
    const t = new HealthyTracker();
    settle(t, { ...portrait, innerHeight: 800, visibleBottom: 800, naturalBottom: 800 });
    expect(t.sample({ ...portrait, innerHeight: 844 }).healthy).toBe(800);
    expect(
      t.sample({ ...portrait, innerHeight: 800, visibleBottom: 800, naturalBottom: 800 }).healthy,
    ).toBe(800);
  });

  it("vridning: en förgiftad bildruta trycker inte ut raden utanför skärmen", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    // Mitt i vridningen: bredden har bytts men höjden är kvar från stående läge, två gånger.
    const mid = { ...landscape, innerHeight: 844, naturalBottom: 844, visibleBottom: 844 };
    t.sample({ ...mid, vvWidth: 390 });
    t.sample(mid);
    t.sample(mid);
    // Liggande vy på plats: den friska höjden är skärmens korta sida, inte 844.
    expect(settle(t, landscape)).toBe(390);
    expect(
      pinShift({
        naturalBottom: 390,
        visibleBottom: 390,
        healthyBottom: t.get(844),
        scale: 1,
        typing: false,
      }),
    ).toBe(0);
    // Tillbaka till stående: ny bredd, inget minne kvar från liggande.
    expect(t.get(390)).toBe(0);
    expect(settle(t, portrait)).toBe(844);
  });

  it("reset() (orientationchange) glömmer allt", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    t.reset();
    expect(t.get(390)).toBe(0);
  });
});

describe("forgetsHealthy", () => {
  it("orientationchange med oförändrad bredd glömmer inte, och fastnad höjd lärs inte in", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    expect(forgetsHealthy("orientationchange", 390, 390)).toBe(false);
    // Vyn är fast (tangentbordshöjd för kort) när orientationchange kommer.
    const stuck = { ...portrait, innerHeight: 544, visibleBottom: 544, naturalBottom: 544 };
    if (forgetsHealthy("orientationchange", 390, 390)) t.reset();
    expect(settle(t, stuck)).toBe(844);
    expect(
      looksStuck({ innerHeight: 544, healthyBottom: t.get(390), offsetTop: 0, typing: false }),
    ).toBe(true);
  });

  it("orientationchange glömmer aldrig på egen hand; resize glömmer bara vid ny bredd", () => {
    expect(forgetsHealthy("orientationchange", 390, 844)).toBe(false);
    expect(forgetsHealthy("resize", 390, 390.4)).toBe(false);
    expect(forgetsHealthy("resize", 390, 844)).toBe(true);
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
