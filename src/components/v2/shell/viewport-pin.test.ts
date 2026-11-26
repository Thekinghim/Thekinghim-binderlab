import { describe, expect, it } from "vitest";

import {
  calmReading,
  forgetsHealthy,
  HealthyTracker,
  healthyReading,
  keyboardUp,
  looksStuck,
  pinDecision,
  pinShift,
  RELEARN_MS,
  screenHeightFor,
  STUCK_MIN_GAP,
  type HealthySample,
  type PinInput,
} from "./viewport-pin";

/** Vanliga Safari (ingen inlärd höjd): som förut. */
const browser: PinInput = {
  naturalBottom: 844,
  visibleBottom: 844,
  visibleTop: 0,
  healthyBottom: 0,
  scale: 1,
  typing: false,
  learned: false,
  overscroll: false,
};

/** Hemskärmsappen på ägarens iPhone: vyn 793 hög, skärmen 852 (statusraden 59 utanför). */
const app: PinInput = {
  naturalBottom: 793,
  visibleBottom: 793,
  visibleTop: 0,
  healthyBottom: 793,
  scale: 1,
  typing: false,
  learned: true,
  overscroll: false,
};

describe("pinShift i vanliga Safari (oförändrat)", () => {
  it("rör inget när det fasta innehållet redan ligger längst ner", () => {
    expect(pinShift(browser)).toBe(0);
  });

  it("använder visualViewport när den är rätt men layoutvyn fel", () => {
    expect(pinShift({ ...browser, naturalBottom: 530 })).toBe(314);
  });

  it("följer verktygsraden när den ändrar höjden på riktigt", () => {
    expect(pinShift({ ...browser, naturalBottom: 544, visibleBottom: 544 })).toBe(0);
    expect(pinShift({ ...browser, naturalBottom: 800, visibleBottom: 844 })).toBe(44);
  });

  it("låter raden vara medan man skriver, när sidan är inzoomad och utan mått", () => {
    expect(pinShift({ ...browser, naturalBottom: 544, typing: true })).toBe(0);
    expect(pinShift({ ...browser, naturalBottom: 544, scale: 1.5 })).toBe(0);
    expect(pinShift({ ...browser, naturalBottom: 0 })).toBe(0);
  });

  it("struntar i småsaker och orimliga värden", () => {
    expect(pinShift({ ...browser, naturalBottom: 843 })).toBe(0);
    expect(pinShift({ ...browser, naturalBottom: 100 })).toBe(0);
  });
});

describe("pinShift i hemskärmsappen", () => {
  it("rör inget när vyn mår bra", () => {
    expect(pinDecision(app)).toEqual({ shift: 0, gap: 0 });
  });

  it("flyttar ner raden när vyn fastnat en tangentbordshöjd för kort (även visualViewport)", () => {
    expect(pinShift({ ...app, naturalBottom: 500, visibleBottom: 500 })).toBe(293);
  });

  it("använder visualViewport.height när layoutvyn är fel och inget lärts in", () => {
    expect(pinShift({ ...app, naturalBottom: 500, healthyBottom: 0 })).toBe(293);
  });

  it("en för stor inlärd höjd (852 = skärmen) skjuter aldrig ut raden", () => {
    expect(pinDecision({ ...app, healthyBottom: 852 })).toEqual({ shift: 0, gap: 59 });
  });

  it("en kvarglömd offsetTop i storlek med statusraden skjuter aldrig ut raden", () => {
    expect(pinShift({ ...app, visibleTop: 59, visibleBottom: 59 + 793 })).toBe(0);
  });

  it("offsetTop stor som ett tangentbord räknas, men inte under gummibandsscroll", () => {
    expect(pinShift({ ...app, visibleTop: 200, visibleBottom: 200 + 793 })).toBe(200);
    expect(pinShift({ ...app, visibleTop: 200, visibleBottom: 200 + 793, overscroll: true })).toBe(
      0,
    );
  });

  it("flyttar aldrig upp och aldrig ett glapp under STUCK_MIN_GAP", () => {
    expect(pinShift({ ...app, naturalBottom: 852, visibleBottom: 852 })).toBe(0);
    expect(pinShift({ ...app, naturalBottom: 793 - STUCK_MIN_GAP + 1 })).toBe(0);
    expect(pinShift({ ...app, naturalBottom: 793 - STUCK_MIN_GAP })).toBe(STUCK_MIN_GAP);
  });

  it("låter raden vara medan man skriver, när sidan är inzoomad och vid orimliga värden", () => {
    expect(pinShift({ ...app, naturalBottom: 500, typing: true })).toBe(0);
    expect(pinShift({ ...app, naturalBottom: 500, scale: 2 })).toBe(0);
    expect(pinShift({ ...app, naturalBottom: 100, visibleBottom: 100 })).toBe(0);
  });
});

// iPhone 14-ish: skärmen 390 × 844 (screen.* är alltid stående), stående vy 390 × 844.
const portrait: HealthySample = {
  innerWidth: 390,
  innerHeight: 844,
  vvWidth: 390,
  vvHeight: 844,
  vvTop: 0,
  naturalBottom: 844,
  typing: false,
  scale: 1,
  blocked: false,
  now: 0,
  screenMin: 390,
  screenMax: 844,
};
const landscape: HealthySample = {
  ...portrait,
  innerWidth: 844,
  innerHeight: 390,
  vvWidth: 844,
  vvHeight: 390,
  naturalBottom: 390,
};
/** Ägarens iPhone i hemskärmsappen med statusraden "default": vyn 793, skärmen 852. */
const owner: HealthySample = {
  ...portrait,
  innerHeight: 793,
  vvHeight: 793,
  naturalBottom: 793,
  screenMax: 852,
};
const ownerStuck: HealthySample = { ...owner, innerHeight: 500, vvHeight: 500, naturalBottom: 500 };
const ownerResume852: HealthySample = {
  ...owner,
  innerHeight: 852,
  vvHeight: 852,
  naturalBottom: 852,
};

/** Två likadana bildrutor i rad, som när vyn står still. */
function settle(t: HealthyTracker, s: HealthySample) {
  t.sample(s);
  return t.sample(s).healthy;
}

/** Bottenradens förskjutning i hemskärmsappen för en avläsning, med det trackern vet. */
function shiftFor(t: HealthyTracker, s: HealthySample) {
  return pinShift({
    naturalBottom: s.naturalBottom,
    visibleBottom: s.vvTop + s.vvHeight,
    visibleTop: s.vvTop,
    healthyBottom: t.get(s.innerWidth),
    scale: s.scale,
    typing: s.typing,
    learned: true,
    overscroll: false,
  });
}

describe("screenHeightFor, healthyReading och calmReading", () => {
  it("väljer skärmsidan efter läget", () => {
    expect(screenHeightFor(390, 390, 844)).toBe(844);
    expect(screenHeightFor(844, 390, 844)).toBe(390);
    expect(screenHeightFor(390, 0, 0)).toBe(0);
  });

  it("kapar en kvarglömd stående höjd i liggande läge", () => {
    expect(healthyReading({ ...landscape, innerHeight: 844, naturalBottom: 844 })).toBe(390);
  });

  it("litar inte på avläsningar under vridning, skrivning, zoom eller med arket öppet", () => {
    expect(healthyReading({ ...portrait, vvWidth: 844 })).toBeNull();
    expect(healthyReading({ ...portrait, typing: true })).toBeNull();
    expect(healthyReading({ ...portrait, scale: 2 })).toBeNull();
    expect(healthyReading({ ...portrait, blocked: true })).toBeNull();
    expect(
      healthyReading({ ...portrait, innerHeight: 0, vvHeight: 0, naturalBottom: 0 }),
    ).toBeNull();
  });

  it("blir aldrig högre än skärmen", () => {
    expect(healthyReading({ ...portrait, innerHeight: 2000, vvHeight: 2000 })).toBe(844);
  });

  it("en ensam avvikande källa räknas inte", () => {
    expect(healthyReading({ ...owner, naturalBottom: 852 })).toBe(793);
    expect(healthyReading({ ...owner, vvHeight: 852 })).toBe(793);
    expect(healthyReading({ ...owner, innerHeight: 852 })).toBe(793);
    expect(
      healthyReading({ ...owner, innerHeight: 600, vvHeight: 700, naturalBottom: 800 }),
    ).toBeNull();
  });

  it("lugn bara när alla tre är överens och offsetTop är 0", () => {
    expect(calmReading(owner)).toBe(793);
    expect(calmReading({ ...owner, vvTop: 59 })).toBeNull();
    expect(calmReading({ ...owner, naturalBottom: 852 })).toBeNull();
    expect(calmReading({ ...owner, blocked: true })).toBeNull();
  });
});

describe("HealthyTracker", () => {
  it("lär sig höjden först när den stått still två bildrutor", () => {
    const t = new HealthyTracker();
    expect(t.sample(portrait)).toMatchObject({ healthy: 0, confirm: true });
    expect(t.sample(portrait)).toMatchObject({ healthy: 844, confirm: false });
    expect(t.get(390)).toBe(844);
    expect(t.get(844)).toBe(0);
  });

  it("sjunker aldrig av en fastnad vy, hur länge den än står still", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    const stuck = { ...portrait, innerHeight: 544, vvHeight: 544, naturalBottom: 544 };
    expect(settle(t, stuck)).toBe(844);
    expect(t.sample({ ...stuck, now: 60_000 })).toMatchObject({ healthy: 844, recheck: false });
  });

  it("en ensam felaktig bildruta lärs inte in", () => {
    const t = new HealthyTracker();
    const s800 = { ...portrait, innerHeight: 800, vvHeight: 800, naturalBottom: 800 };
    settle(t, s800);
    expect(t.sample(portrait).healthy).toBe(800);
    expect(t.sample(s800).healthy).toBe(800);
  });

  it("vridning: en förgiftad bildruta trycker inte ut raden utanför skärmen", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    // Mitt i vridningen: bredden har bytts men höjden är kvar från stående läge, två gånger.
    const mid = { ...landscape, innerHeight: 844, naturalBottom: 844, vvHeight: 844 };
    t.sample({ ...mid, vvWidth: 390 });
    t.sample(mid);
    t.sample(mid);
    // Liggande vy på plats: den friska höjden är skärmens korta sida, inte 844.
    expect(settle(t, landscape)).toBe(390);
    expect(shiftFor(t, landscape)).toBe(0);
    // Tillbaka till stående: ny bredd, inget minne kvar från liggande.
    expect(t.get(390)).toBe(0);
    expect(settle(t, portrait)).toBe(844);
  });

  it("reset() glömmer allt", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    t.reset();
    expect(t.get(390)).toBe(0);
  });

  it("lär sig inget medan ett ark är öppet", () => {
    const t = new HealthyTracker();
    settle(t, owner);
    expect(settle(t, { ...ownerResume852, blocked: true })).toBe(793);
  });
});

describe("ägarens iPhone: 793 hög vy, 852 hög skärm", () => {
  it("en 852-avläsning vid återkomst skjuter inte ut raden och glöms", () => {
    const t = new HealthyTracker();
    expect(settle(t, owner)).toBe(793);
    // Återkomst från bakgrunden: WebKit säger 852 överallt i två bildrutor, sedan 793 igen.
    expect(settle(t, { ...ownerResume852, now: 1000 })).toBe(852);
    // Raden ligger kvar i skärmens nederkant (793) trots att 852 lärts in.
    expect(shiftFor(t, { ...owner, now: 1100 })).toBe(0);
    expect(t.sample({ ...owner, now: 1100 })).toMatchObject({ healthy: 852, recheck: true });
    expect(t.sample({ ...owner, now: 1100 + RELEARN_MS - 1 })).toMatchObject({
      healthy: 852,
      recheck: true,
    });
    expect(t.sample({ ...owner, now: 1100 + RELEARN_MS })).toMatchObject({
      healthy: 793,
      relearned: true,
    });
    // Och det ursprungliga felet rättas fortfarande, mot den rätta höjden.
    expect(settle(t, { ...ownerStuck, now: 5000 })).toBe(793);
    expect(shiftFor(t, ownerStuck)).toBe(293);
  });

  it("en orolig avläsning (offsetTop 59) avbryter omlärningen, klockan börjar om", () => {
    const t = new HealthyTracker();
    settle(t, owner);
    settle(t, { ...ownerResume852, now: 1000 });
    t.sample({ ...owner, now: 1100 });
    t.sample({ ...owner, vvTop: 59, now: 1200 });
    expect(t.sample({ ...owner, now: 1300 })).toMatchObject({ healthy: 852, recheck: true });
    expect(t.sample({ ...owner, now: 1300 + RELEARN_MS - 1 })).toMatchObject({ healthy: 852 });
    expect(t.sample({ ...owner, now: 1300 + RELEARN_MS })).toMatchObject({ healthy: 793 });
  });

  it("tangentbordet fastnar: 793 → 500 rättas med 293 px", () => {
    const t = new HealthyTracker();
    settle(t, owner);
    expect(settle(t, ownerStuck)).toBe(793);
    expect(shiftFor(t, ownerStuck)).toBe(293);
    expect(
      looksStuck({ innerHeight: 500, healthyBottom: t.get(390), offsetTop: 0, typing: false }),
    ).toBe(true);
    // Vyn kommer loss: raden tillbaka utan förskjutning.
    expect(shiftFor(t, owner)).toBe(0);
  });

  it("kvarglömd offsetTop efter tangentbordet: lärs inte in, och 59 px flyttar inget", () => {
    const t = new HealthyTracker();
    settle(t, owner);
    expect(settle(t, { ...owner, vvTop: 59 })).toBe(793);
    expect(shiftFor(t, { ...owner, vvTop: 59 })).toBe(0);
    expect(settle(t, { ...owner, vvTop: 200 })).toBe(793);
    expect(shiftFor(t, { ...owner, vvTop: 200 })).toBe(200);
  });

  it("ark öppnas och stängs (vaul): inget lärs in, raden står still", () => {
    const t = new HealthyTracker();
    settle(t, owner);
    const sheet = { ...owner, blocked: true };
    // Arket med inmatning och tangentbord: vyn krymper, men man skriver.
    settle(t, { ...sheet, typing: true, innerHeight: 500, vvHeight: 450, naturalBottom: 500 });
    settle(t, { ...sheet, innerHeight: 852, vvHeight: 852, naturalBottom: 852 });
    expect(t.get(390)).toBe(793);
    expect(shiftFor(t, owner)).toBe(0);
  });

  it("vridning till liggande och tillbaka", () => {
    const t = new HealthyTracker();
    settle(t, owner);
    const side = {
      ...owner,
      innerWidth: 852,
      vvWidth: 852,
      innerHeight: 390,
      vvHeight: 390,
      naturalBottom: 390,
    };
    expect(settle(t, side)).toBe(390);
    expect(shiftFor(t, side)).toBe(0);
    expect(settle(t, owner)).toBe(793);
  });
});

describe("forgetsHealthy", () => {
  it("orientationchange med oförändrad bredd glömmer inte, och fastnad höjd lärs inte in", () => {
    const t = new HealthyTracker();
    settle(t, portrait);
    expect(forgetsHealthy("orientationchange", 390, 390)).toBe(false);
    const stuck = { ...portrait, innerHeight: 544, vvHeight: 544, naturalBottom: 544 };
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
  it("vyn är fast när den är en tangentbordshöjd kortare än den friska och ingen skriver", () => {
    expect(looksStuck({ innerHeight: 544, healthyBottom: 844, offsetTop: 0, typing: false })).toBe(
      true,
    );
    expect(looksStuck({ innerHeight: 844, healthyBottom: 844, offsetTop: 0, typing: false })).toBe(
      false,
    );
    // 793 mot en för stor inlärd 852: statusradens storlek, inte fast.
    expect(looksStuck({ innerHeight: 793, healthyBottom: 852, offsetTop: 0, typing: false })).toBe(
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
