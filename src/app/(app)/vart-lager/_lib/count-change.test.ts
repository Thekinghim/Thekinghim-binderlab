import { describe, expect, it } from "vitest";

import { isBigCountChange } from "./count-change";

describe("stor ändring av antal", () => {
  it("frågar vid en nolla för mycket eller ett tömt lager", () => {
    expect(isBigCountChange(162, 1620)).toBe(true);
    expect(isBigCountChange(162, 0)).toBe(true);
    expect(isBigCountChange(0, 60)).toBe(true);
  });

  it("sparar små och rimliga ändringar direkt", () => {
    expect(isBigCountChange(162, 120)).toBe(false);
    expect(isBigCountChange(5, 40)).toBe(false);
    expect(isBigCountChange(400, 340)).toBe(false);
    expect(isBigCountChange(-10, 30)).toBe(false);
  });
});
