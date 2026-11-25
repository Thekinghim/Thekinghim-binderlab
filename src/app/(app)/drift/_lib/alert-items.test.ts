import { describe, expect, it } from "vitest";

import { staleSince } from "./alert-items";

describe("larmets text och när den skrevs", () => {
  it("äldre än ett dygn: texten får tiden framför sig", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    expect(staleSince("2026-11-24T08:00:00Z", now)).toBe(false);
    expect(staleSince("2026-11-23T11:00:00Z", now)).toBe(true);
  });
});
