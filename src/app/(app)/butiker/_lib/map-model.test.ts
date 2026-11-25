import { describe, expect, it } from "vitest";

import {
  MIN_SPAN_LAT,
  cityPoint,
  dotRadius,
  firstOfEachText,
  fitView,
  labelBox,
  placeLabels,
  placeLabelsAround,
  projector,
  smoothPath,
  spreadOffsets,
  zoomView,
} from "./map-model";

describe("butikskartan", () => {
  it("hittar orter oavsett skiftläge och blanksteg", () => {
    expect(cityPoint(" Alingsås ")).toEqual([12.533, 57.93]);
    expect(cityPoint("GÖTEBORG")).toEqual([11.975, 57.709]);
    expect(cityPoint("Ingenstans")).toBeNull();
    expect(cityPoint(null)).toBeNull();
  });

  it("rymmer alla punkter i rutan med marginal", () => {
    const pts = [cityPoint("Göteborg")!, cityPoint("Uddevalla")!, cityPoint("Alingsås")!];
    const w = 600;
    const h = 340;
    const view = fitView(pts, w, h, 0.16);
    const p = projector(view, w, h);
    for (const pt of pts) {
      const [x, y] = p(pt);
      expect(x).toBeGreaterThanOrEqual(w * 0.16 - 0.5);
      expect(x).toBeLessThanOrEqual(w * 0.84 + 0.5);
      expect(y).toBeGreaterThanOrEqual(h * 0.16 - 0.5);
      expect(y).toBeLessThanOrEqual(h * 0.84 + 0.5);
    }
    // Norr är upp: Uddevalla (norr) ovanför Göteborg.
    expect(p(cityPoint("Uddevalla")!)[1]).toBeLessThan(p(cityPoint("Göteborg")!)[1]);
  });

  it("en enda butik ger ett minsta utsnitt, mitt i rutan", () => {
    const view = fitView([[12.27, 57.77]], 400, 300);
    expect(view.spanLat).toBe(MIN_SPAN_LAT);
    expect(projector(view, 400, 300)([12.27, 57.77])).toEqual([200, 150]);
  });

  it("zoomar mot vald punkt", () => {
    const view = { center: [12, 58] as const, spanLat: 1 };
    const z = zoomView(view, 2, [13, 58]);
    expect(z.spanLat).toBe(0.5);
    expect(z.center[0]).toBeCloseTo(12.5);
    expect(zoomView(view, 1, [13, 58])).toEqual({ center: [12, 58], spanLat: 1 });
  });

  it("prickens yta följer vinsten", () => {
    const big = dotRadius(10_000_00, 10_000_00);
    const quarter = dotRadius(2_500_00, 10_000_00);
    expect(big).toBe(18);
    expect(quarter).toBe(12);
    expect(dotRadius(0, 10_000_00)).toBeLessThan(quarter);
    expect(dotRadius(-5, 10)).toBe(dotRadius(0, 10));
    expect(dotRadius(5, 0, true)).toBe(4.5);
  });

  it("sprider butiker på samma punkt", () => {
    expect(spreadOffsets(1)).toEqual([[0, 0]]);
    const three = spreadOffsets(3, 10);
    expect(three).toHaveLength(3);
    for (const [x, y] of three) expect(Math.hypot(x, y)).toBeCloseTo(10);
  });

  it("sluten mjuk kurva", () => {
    expect(
      smoothPath([
        [0, 0],
        [1, 1],
      ]),
    ).toBe("");
    const d = smoothPath([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(d.startsWith("M0.0,0.0C")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("etiketter som krockar hoppas över, viktigast först", () => {
    const shown = placeLabels(
      [
        { x: 0 + 10, y: 10, w: 50, h: 14 },
        { x: 30, y: 12, w: 50, h: 14 },
        { x: 200, y: 10, w: 50, h: 14 },
        { x: 395, y: 10, w: 50, h: 14 },
      ],
      [{ x: 190, y: 0, w: 20, h: 40 }],
      { w: 400, h: 100 },
    );
    expect([...shown]).toEqual([0]);
  });
});

describe("etiketter runt pricken", () => {
  it("tar nästa läge när det första krockar", () => {
    const x = 100;
    const y = 50;
    const sides = ["right", "left", "above", "below"] as const;
    const cands = sides.map((s) => labelBox(x, y, 10, 40, s));
    const blockRight = [{ x: 115, y: 40, w: 30, h: 20 }];
    expect(placeLabelsAround([cands], blockRight, { w: 300, h: 200 }).get(0)).toBe(1);
    // Allt blockerat: ingen etikett.
    expect(placeLabelsAround([cands], [{ x: 0, y: 0, w: 300, h: 200 }]).size).toBe(0);
    expect(labelBox(x, y, 10, 40, "above")).toEqual({ x: 80, y: 20, w: 40, h: 16 });
  });
});

describe("firstOfEachText", () => {
  it("bara första etiketten av varje text, oavsett stora bokstäver", () => {
    expect(firstOfEachText(["Örebro", "Sala", "örebro ", "Västerås", "Sala"])).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
  });
});
