import { describe, expect, it } from "vitest";
import { fitInSquare, SQUARE_SIDE } from "./square";

describe("fitInSquare", () => {
  it("avlång (stående) bild hamnar i mitten med samma proportioner", () => {
    const r = fitInSquare(300, 600);
    expect(r).toEqual({ x: 150, y: 0, w: 300, h: 600 });
    expect(r.w / r.h).toBeCloseTo(300 / 600);
  });
  it("liggande bild centreras lodrätt", () => {
    expect(fitInSquare(1600, 800)).toEqual({ x: 0, y: 150, w: 600, h: 300 });
  });
  it("liten bild förstoras till kvadratens kant utan att sträckas", () => {
    const r = fitInSquare(100, 200);
    expect(r).toEqual({ x: 150, y: 0, w: 300, h: 600 });
  });
  it("kvadratisk bild fyller hela kvadraten", () => {
    expect(fitInSquare(1200, 1200)).toEqual({ x: 0, y: 0, w: SQUARE_SIDE, h: SQUARE_SIDE });
  });
  it("aldrig utanför kvadraten", () => {
    for (const [w, h] of <Array<[number, number]>>[
      [1, 5000],
      [5000, 1],
      [333, 777],
      [599, 601],
    ]) {
      const r = fitInSquare(w, h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(SQUARE_SIDE);
      expect(r.y + r.h).toBeLessThanOrEqual(SQUARE_SIDE);
    }
  });
});
