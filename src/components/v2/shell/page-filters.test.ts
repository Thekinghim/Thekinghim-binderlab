import { describe, expect, it } from "vitest";

import { activeFilterCount } from "./page-filters";

describe("activeFilterCount (Filter-knappen på telefonen)", () => {
  it("räknar valda filter i adressen", () => {
    expect(activeFilterCount(new URLSearchParams(""))).toBe(0);
    expect(activeFilterCount(new URLSearchParams("period=30d&vy=x"))).toBe(0);
    expect(activeFilterCount(new URLSearchParams("butik=a&vmb=1"))).toBe(2);
    expect(activeFilterCount(new URLSearchParams("automat="))).toBe(0);
  });
});
