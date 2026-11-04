/**
 * Vyknappen ska alltid säga hur siffrorna räknas: "Utan VMB" när den är av (standard) och
 * "Med VMB" när den är på. Tidigare stod det "Med VMB" även när VMB var av, och ägaren
 * trodde att VMB räknades.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = { on: false };
vi.mock("./use-period", () => ({
  useVmbView: () => ({ on: state.on, setOn: () => {} }),
}));

const { VmbToggle, vmbToggleLabel } = await import("./vmb-toggle");

function html(on: boolean): string {
  state.on = on;
  return renderToString(createElement(VmbToggle, { userKey: "u-1" }));
}

describe("VmbToggle", () => {
  it("av (standard): 'Utan VMB', inte nedtryckt", () => {
    const out = html(false);
    expect(out).toContain("Utan VMB");
    expect(out).not.toContain("Med VMB");
    expect(out).toContain('aria-pressed="false"');
  });

  it("på: 'Med VMB', nedtryckt och markerad", () => {
    const out = html(true);
    expect(out).toContain("Med VMB");
    expect(out).not.toContain("Utan VMB");
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("bg-hover");
  });

  it("etiketten", () => {
    expect(vmbToggleLabel(false)).toBe("Utan VMB");
    expect(vmbToggleLabel(true)).toBe("Med VMB");
  });
});
