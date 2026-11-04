import { describe, expect, it } from "vitest";

import {
  BOTTOM_NAV_PX,
  FAB_SIZE_PX,
  fabLayout,
  fabVisibleAfterScroll,
  phoneFabLayout,
  showsRefillShortcut,
} from "./fab";

describe("flytande knappar", () => {
  it("sidan har luft ovanför AI-knappen, så att inget göms bakom den", () => {
    const l = fabLayout({ refill: false, assistant: true });
    expect(l.assistantBottom).not.toBeNull();
    expect(l.mainPaddingBottom).toBeGreaterThan((l.assistantBottom ?? 0) + FAB_SIZE_PX);
  });

  it("utan knappar räcker bottenradens höjd", () => {
    expect(fabLayout({ refill: false, assistant: false }).mainPaddingBottom).toBe(BOTTOM_NAV_PX);
  });

  it("påfyllarens Fyll på tar platsen; AI-knappen ligger inte ovanpå den", () => {
    const l = fabLayout({ refill: true, assistant: true });
    expect(l.refillBottom).not.toBeNull();
    expect(l.assistantBottom).toBeNull();
    expect(l.mainPaddingBottom).toBeGreaterThan((l.refillBottom ?? 0) + FAB_SIZE_PX);
  });

  it("på telefonen finns ingen flytande AI-knapp; Fyll på står kvar", () => {
    const owner = phoneFabLayout({ refill: false });
    expect(owner.assistantBottom).toBeNull();
    expect(owner.mainPaddingBottom).toBe(BOTTOM_NAV_PX);
    const refiller = phoneFabLayout({ refill: true });
    expect(refiller.refillBottom).not.toBeNull();
    expect(refiller.mainPaddingBottom).toBeGreaterThan((refiller.refillBottom ?? 0) + FAB_SIZE_PX);
  });

  it("Fyll på-genvägen bara för påfyllaren och inte på fältsidorna", () => {
    expect(showsRefillShortcut("refiller", "/att-gora")).toBe(true);
    expect(showsRefillShortcut("refiller", "/drift/pafyllning")).toBe(false);
    expect(showsRefillShortcut("refiller", "/drift/besok")).toBe(false);
    expect(showsRefillShortcut("owner", "/att-gora")).toBe(false);
  });

  it("AI-knappen glider undan nedåt och kommer tillbaka uppåt, överst och i slutet", () => {
    expect(fabVisibleAfterScroll(true, 200, 260)).toBe(false);
    expect(fabVisibleAfterScroll(false, 260, 200)).toBe(true);
    expect(fabVisibleAfterScroll(false, 300, 304)).toBe(false);
    expect(fabVisibleAfterScroll(true, 300, 304)).toBe(true);
    expect(fabVisibleAfterScroll(false, 120, 40)).toBe(true);
    expect(fabVisibleAfterScroll(false, 900, 1200, true)).toBe(true);
  });
});
