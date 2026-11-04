import { describe, expect, it } from "vitest";

import { dayLabel } from "./display";

const sp = (s: string) => s.replace(/\u00a0/g, " ");

describe("dayLabel", () => {
  it("skriver datum som resten av sajten: '2 nov.', 'mars' utan punkt", () => {
    const today = "2026-11-04";
    expect(sp(dayLabel("2026-11-02", today))).toBe("2 nov.");
    expect(sp(dayLabel("2026-11-03", today))).toBe("i går");
    expect(sp(dayLabel("2026-11-04", today))).toBe("i dag");
    expect(sp(dayLabel("2026-03-17", today))).toBe("17 mars");
    expect(sp(dayLabel("2027-01-05", today))).toBe("5 jan. 2027");
  });
});
