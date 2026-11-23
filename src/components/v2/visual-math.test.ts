import { describe, expect, it } from "vitest";

import {
  CITY_TONES,
  cityTone,
  FAN_MAX,
  fanLayout,
  fanWidthInPacks,
  NEUTRAL_TONE,
  profitBarParts,
  RING,
  ringGeometry,
  stackDepth,
  storeFace,
  storeGlyph,
  storeInitials,
} from "./visual-math";

describe("ringGeometry", () => {
  const c = 2 * Math.PI * RING.r;

  it("ritar utfallet som andel av omkretsen och procenten avrundad", () => {
    const g = ringGeometry({ value: 36920, goal: 50000 });
    expect(g.result).toBeCloseTo(0.7384, 4);
    expect(g.percent).toBe(74);
    expect(g.resultDash).toBe(`${Math.round(c * 0.7384 * 100) / 100} ${Math.round(c * 100) / 100}`);
    expect(g.reached).toBe(false);
    expect(g.forecastPath).toBeNull();
    expect(g.paceTick).toBeNull();
  });

  it("lägger takt-markören tvärs över ringen (r ± 10) på taktens vinkel", () => {
    const g = ringGeometry({ value: 0, goal: 100, pace: 25 });
    // 25 % = en kvarts varv medurs från start (x = cx, y = cx + r i svg:ns ovridna system).
    expect(g.paceTick).toEqual({ x1: 75, y1: 75 + RING.r - 10, x2: 75, y2: 75 + RING.r + 10 });
    expect(g.resultDash).toBeNull();
  });

  it("drar prognosbågen från utfallet (med en liten lucka) till prognosen", () => {
    const g = ringGeometry({ value: 25, goal: 100, forecast: 50 });
    expect(g.forecastPath).toMatch(/^M[\d.]+,[\d.]+A62,62 0 0 1 [\d.]+,[\d.]+$/);
    // Slutet: 50 % = rakt motsatt starten (cx − r, cy).
    expect(g.forecastPath!.endsWith(` ${75 - RING.r},75`)).toBe(true);
  });

  it("använder stora bågen när prognosen går mer än ett halvt varv längre", () => {
    expect(ringGeometry({ value: 10, goal: 100, forecast: 90 }).forecastPath).toContain(" 0 1 1 ");
  });

  it("klämmer prognos över målet strax före helt varv och hoppar över prognos ≤ utfall", () => {
    const over = ringGeometry({ value: 50, goal: 100, forecast: 400 });
    expect(over.forecastPath).not.toBeNull();
    expect(ringGeometry({ value: 60, goal: 100, forecast: 55 }).forecastPath).toBeNull();
  });

  it("fyller ringen när målet är nått, utan prognos, och visar procent över 100", () => {
    const g = ringGeometry({ value: 52000, goal: 50000, forecast: 60000, pace: 70000 });
    expect(g.result).toBe(1);
    expect(g.reached).toBe(true);
    expect(g.percent).toBe(104);
    expect(g.forecastPath).toBeNull();
    // Takten klämd till ett helt varv: tillbaka vid start.
    expect(g.paceTick!.y1).toBeCloseTo(75, 1);
  });

  it("utan mål: ingenting ritas och ingen procent", () => {
    const g = ringGeometry({ value: 10, goal: 0, pace: 5, forecast: 20 });
    expect(g).toMatchObject({
      resultDash: null,
      forecastPath: null,
      paceTick: null,
      percent: null,
    });
  });

  it("negativt utfall ritas som 0", () => {
    const g = ringGeometry({ value: -500, goal: 1000 });
    expect(g.result).toBe(0);
    expect(g.resultDash).toBeNull();
    expect(g.percent).toBe(-50);
  });
});

describe("storeFace", () => {
  it("väljer symbol ur butikstypen (fri text, versaler och mellanslag spelar ingen roll)", () => {
    expect(storeGlyph("Serie- och spelbutik")).toBe("card");
    expect(storeGlyph("Spelbutik")).toBe("game");
    expect(storeGlyph("Rollspel och brädspel")).toBe("dice");
    expect(storeGlyph("Biograf")).toBe("reel");
    expect(storeGlyph("Nöjeshall")).toBe("pin");
    expect(storeGlyph("Bowlinghall")).toBe("pin");
    expect(storeGlyph("Leksaksbutik")).toBe("blocks");
    expect(storeGlyph("Köpcentrum")).toBe("bag");
    expect(storeGlyph("Bokhandel")).toBe("book");
    expect(storeGlyph("Badhus")).toBe("wave");
    expect(storeGlyph("Fritidsgård")).toBe("wave");
    expect(storeGlyph("bensinstation")).toBe("fuel");
    expect(storeGlyph("Livs ")).toBe("kiosk");
    expect(storeGlyph("kiosk")).toBe("kiosk");
  });

  it("ger initialer när typen saknas eller är okänd", () => {
    expect(storeGlyph(null)).toBeNull();
    expect(storeGlyph("   ")).toBeNull();
    expect(storeGlyph("Frisör")).toBeNull();
    expect(
      storeFace({ name: "Köpcentrum Kvarnhagen", storeType: null, city: "Eskilstuna" }).glyph,
    ).toBeNull();
  });

  it("initialer: två ord → första bokstaven i varje, ett ord → två första", () => {
    expect(storeInitials("Köpcentrum Kvarnhagen")).toBe("KK");
    expect(storeInitials("Lekboden")).toBe("LE");
    expect(storeInitials("Rutor & Rollspel")).toBe("RR");
    expect(storeInitials("  åsa-kiosken ")).toBe("ÅK");
    expect(storeInitials("7-Eleven")).toBe("7E");
    expect(storeInitials("")).toBe("?");
    expect(storeInitials(null)).toBe("?");
  });

  it("samma stad får alltid samma färg, oavsett versaler och mellanslag", () => {
    expect(cityTone("Västerås")).toEqual(cityTone(" västerås "));
    expect(CITY_TONES).toContainEqual(cityTone("Köping"));
    expect(cityTone(null)).toEqual(NEUTRAL_TONE);
    expect(cityTone("")).toEqual(NEUTRAL_TONE);
  });

  it("sprider städerna över paletten", () => {
    const cities = [
      "Västerås",
      "Eskilstuna",
      "Enköping",
      "Köping",
      "Sala",
      "Örebro",
      "Arboga",
      "Uppsala",
      "Göteborg",
      "Malmö",
    ];
    const tones = new Set(cities.map((c) => cityTone(c)[0]));
    expect(tones.size).toBeGreaterThanOrEqual(5);
  });

  it("är deterministisk för hela valet", () => {
    const a = storeFace({ name: "Bio Fyren", storeType: "Biograf", city: "Enköping" });
    const b = storeFace({ name: "Bio Fyren", storeType: "Biograf", city: "Enköping" });
    expect(a).toEqual(b);
    expect(a.glyph).toBe("reel");
  });
});

describe("fanLayout", () => {
  it("är tom för 0 och klämmer till högst fem", () => {
    expect(fanLayout(0)).toEqual([]);
    expect(fanLayout(-3)).toEqual([]);
    expect(fanLayout(9)).toHaveLength(FAN_MAX);
  });

  it("ett pack står rakt i mitten", () => {
    expect(fanLayout(1)).toEqual([{ x: 0, y: 0, rotate: 0, scale: 1, z: 10, dim: 1 }]);
  });

  it("tre pack: mockens ±52 % och ±8°, mitten överst, upplyft och lite större", () => {
    const [l, c, r] = fanLayout(3);
    expect(l).toMatchObject({ x: -52, rotate: -8 });
    expect(r).toMatchObject({ x: 52, rotate: 8 });
    expect(c).toMatchObject({ x: 0, rotate: 0, scale: 1.08, y: -6 });
    expect(c!.z).toBeGreaterThan(l!.z);
    expect(c!.dim).toBeGreaterThan(l!.dim);
  });

  it("är symmetrisk kring mitten för alla antal", () => {
    for (let n = 1; n <= FAN_MAX; n++) {
      const s = fanLayout(n);
      for (let i = 0; i < n; i++) {
        const m = s[n - 1 - i]!;
        expect(s[i]!.x).toBeCloseTo(-m.x, 6);
        expect(s[i]!.rotate).toBeCloseTo(-m.rotate, 6);
        expect(s[i]!.z).toBe(m.z);
      }
    }
  });

  it("jämnt antal: ingen enskild mitt, de två innersta överst", () => {
    const s = fanLayout(4);
    expect(s.map((x) => x.scale)).toEqual([1, 1, 1, 1]);
    expect(s[1]!.z).toBeGreaterThan(s[0]!.z);
    expect(s[1]!.z).toBe(s[2]!.z);
  });

  it("bredden växer med antalet", () => {
    expect(fanWidthInPacks(0)).toBe(0);
    expect(fanWidthInPacks(1)).toBe(1);
    expect(fanWidthInPacks(3)).toBeGreaterThan(fanWidthInPacks(2));
    expect(fanWidthInPacks(5)).toBeGreaterThan(fanWidthInPacks(3));
  });
});

describe("stackDepth", () => {
  it("följer mockens gränser", () => {
    expect([null, 0, 19, 20, 59, 60, 119, 120, 199, 200, 5000].map(stackDepth)).toEqual([
      0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });
});

describe("profitBarParts", () => {
  it("delar intäkten i inköp och vinst och räknar marginalen", () => {
    expect(profitBarParts(21000, 13000, 21000)).toEqual({
      widthPct: 100,
      costPct: 61.9,
      profitPct: 38.1,
      marginPct: 38.1,
      loss: false,
    });
  });

  it("längden är intäkten mot skalan, högst 100 %", () => {
    expect(profitBarParts(5500, 2000, 22000).widthPct).toBe(25);
    expect(profitBarParts(30000, 2000, 22000).widthPct).toBe(100);
  });

  it("okänt inköp: ingen delning och ingen marginal", () => {
    expect(profitBarParts(8383, null, 22000)).toMatchObject({
      costPct: null,
      profitPct: null,
      marginPct: null,
      loss: false,
    });
  });

  it("förlust: hela stapeln är inköp och marginalen negativ", () => {
    expect(profitBarParts(1000, 1500, 1000)).toEqual({
      widthPct: 100,
      costPct: 100,
      profitPct: 0,
      marginPct: -50,
      loss: true,
    });
  });

  it("ingen intäkt: tom stapel utan marginal", () => {
    expect(profitBarParts(0, 0, 1000)).toEqual({
      widthPct: 0,
      costPct: 0,
      profitPct: 0,
      marginPct: null,
      loss: false,
    });
    expect(profitBarParts(0, 0, 0).widthPct).toBe(0);
  });
});
