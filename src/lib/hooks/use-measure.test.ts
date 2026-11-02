import { describe, expect, it } from "vitest";

import { svgSizeProps, unmeasuredStyle } from "./use-measure";

/**
 * Diagram före mätningen (serverrenderingen och tills JS har körts): ritningen skalas till
 * behållarens bredd i stället för att vara 640 px bred, så att en 375 px bred mobil inte
 * får horisontell scroll under laddningen.
 */
describe("diagrammens mått före och efter mätningen", () => {
  it("omätt: hela bredden med viewBox över den beräknade geometrin", () => {
    expect(svgSizeProps(640, 280, false)).toEqual({
      width: "100%",
      height: 280,
      viewBox: "0 0 640 280",
    });
    expect(unmeasuredStyle(false)).toEqual({ overflowX: "clip" });
  });

  it("mätt: exakta pixlar och ingen klippning (fokusringen syns)", () => {
    expect(svgSizeProps(343, 280, true)).toEqual({ width: 343, height: 280 });
    expect(unmeasuredStyle(true)).toBeUndefined();
  });
});
