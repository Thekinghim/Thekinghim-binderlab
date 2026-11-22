/** AxisTick: var n:e etikett, nivåer för gallring efter bredd och ankring vid kanterna. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AxisTick } from "./axis-tick";

const html = (index: number, count: number, step: number) =>
  renderToStaticMarkup(
    <AxisTick index={index} count={count} step={step}>
      x
    </AxisTick>,
  );

describe("AxisTick", () => {
  it("visar bara var step:e etikett", () => {
    expect(html(1, 30, 4)).toBe("");
    expect(html(4, 30, 4)).toContain("v2-axt");
  });

  it("ger nivåer så att smala axlar kan gallra", () => {
    expect(html(0, 30, 4)).toContain('data-k="4"');
    expect(html(4, 30, 4)).toContain('data-k="1"');
    expect(html(8, 30, 4)).toContain('data-k="2"');
    expect(html(16, 30, 4)).toContain('data-k="4"');
  });

  it("ankrar första etiketten i början och den sista nära högerkanten i slutet", () => {
    expect(html(0, 30, 4)).toContain("data-start");
    // 30 staplar, var 4:e: 28 är sista etiketten (1 stapel kvar), 24 sista vid varannan.
    expect(html(28, 30, 4)).toContain("data-end=");
    expect(html(24, 30, 4)).not.toContain("data-end=");
    expect(html(24, 30, 4)).toContain("data-end2");
    expect(html(6, 7, 1)).toContain("data-end=");
  });
});
