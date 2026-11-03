import { describe, expect, it } from "vitest";
import { FOCUS_STALE_MS, INTERVAL_MS, isBusy, shouldRefresh } from "./use-auto-refresh";

function doc(opts: { visible?: boolean; tag?: string; modal?: boolean; editable?: boolean } = {}) {
  return {
    visibilityState: opts.visible === false ? "hidden" : "visible",
    activeElement: opts.tag
      ? ({ tagName: opts.tag, isContentEditable: !!opts.editable } as unknown as Element)
      : null,
    querySelector: (sel: string) =>
      opts.modal && sel.includes("aria-modal") ? ({} as Element) : null,
  };
}

describe("shouldRefresh", () => {
  const t0 = 1_000_000;

  it("vid fokus: bara när mer än 60 s gått", () => {
    expect(shouldRefresh("focus", t0 + FOCUS_STALE_MS, t0, doc())).toBe(false);
    expect(shouldRefresh("focus", t0 + FOCUS_STALE_MS + 1, t0, doc())).toBe(true);
  });

  it("med timer: efter 5 minuter", () => {
    expect(shouldRefresh("interval", t0 + 60_000, t0, doc())).toBe(false);
    expect(shouldRefresh("interval", t0 + INTERVAL_MS, t0, doc())).toBe(true);
  });

  it("aldrig när fliken är dold", () => {
    expect(shouldRefresh("interval", t0 + INTERVAL_MS, t0, doc({ visible: false }))).toBe(false);
  });

  it("hoppar över när man skriver eller har en dialog öppen", () => {
    const late = t0 + INTERVAL_MS;
    expect(shouldRefresh("interval", late, t0, doc({ tag: "INPUT" }))).toBe(false);
    expect(shouldRefresh("interval", late, t0, doc({ tag: "TEXTAREA" }))).toBe(false);
    expect(shouldRefresh("interval", late, t0, doc({ modal: true }))).toBe(false);
    expect(shouldRefresh("interval", late, t0, doc({ tag: "BUTTON" }))).toBe(true);
  });

  it("isBusy känner igen redigerbara element", () => {
    expect(isBusy(doc({ tag: "DIV", editable: true }))).toBe(true);
    expect(isBusy(doc({ tag: "SELECT" }))).toBe(true);
    expect(isBusy(doc())).toBe(false);
  });
});
