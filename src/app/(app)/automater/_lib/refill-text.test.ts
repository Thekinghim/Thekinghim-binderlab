import { describe, expect, it } from "vitest";

import { NO_REFILL_TEXT, stockAsideText } from "./refill-text";

const base = { packs: 76, timeZone: "Europe/Stockholm", now: "2026-11-04T09:00:00Z" };

describe("automatsidan: senast påfylld", () => {
  it("utan registrerad påfyllning står det att ingen är registrerad (inte inventeringen)", () => {
    expect(stockAsideText({ ...base, lastRefilledAt: null })).toBe(
      `76 pack i automaten, ${NO_REFILL_TEXT}.`,
    );
  });

  it("med en registrerad påfyllning står tiden", () => {
    const text = stockAsideText({ ...base, lastRefilledAt: "2026-11-03T12:20:00Z" });
    expect(text).toMatch(/^76 pack i automaten, senast påfylld /);
    expect(text).toContain("13:20");
  });
});
