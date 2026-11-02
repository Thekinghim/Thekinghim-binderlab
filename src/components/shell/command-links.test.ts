import { describe, expect, it } from "vitest";

import { machineLabel, withCarried } from "./command-links";
import { isInternalHref, parseRecent, pushRecent, recentKey, RECENT_LIMIT } from "./command-recent";

const current = new URLSearchParams("period=7d&butik=s1&automat=m1&q=ignoreras");

describe("länkar från paletten", () => {
  it("tar med period och filter (all)", () => {
    expect(withCarried("/automater/m2", "all", current)).toBe(
      "/automater/m2?period=7d&butik=s1&automat=m1",
    );
  });

  it("bara perioden när länken sätter eget filter, och länkens parametrar vinner", () => {
    expect(withCarried("/lager?automat=m9&titel=t1", "period", current)).toBe(
      "/lager?automat=m9&titel=t1&period=7d",
    );
  });

  it("inget när länken bär allt själv, ankaret behålls", () => {
    expect(withCarried("/rapporter#ny-rapport", "none", current)).toBe("/rapporter#ny-rapport");
    expect(withCarried("/order?period=allt&q=42780", "all", current)).toBe(
      "/order?period=allt&q=42780&butik=s1&automat=m1",
    );
  });

  it("automatens namn", () => {
    expect(machineLabel({ code: "BL-002", name: "Mobilia" })).toBe("BL-002 Mobilia");
    expect(machineLabel({ name: "Mobilia" })).toBe("Mobilia");
  });
});

describe("senaste val", () => {
  it("nyckeln skiljer organisation, användare och roll", () => {
    const a = recentKey({ organizationId: "o", user: "A@x.se", role: "owner" });
    const b = recentKey({ organizationId: "o", user: "a@x.se", role: "refiller" });
    expect(a).not.toBe(b);
    expect(a).toBe(recentKey({ organizationId: "o", user: "a@x.se", role: "owner" }));
  });

  it("godtar bara interna länkar och kända fält", () => {
    const raw = JSON.stringify([
      { type: "link", id: "order:1", label: "Ascended", href: "/order?order=1", carry: "none" },
      { type: "link", id: "evil", label: "x", href: "https://evil.example", carry: "all" },
      { type: "link", id: "evil2", label: "x", href: "//evil.example", carry: "all" },
      { type: "command", id: "nav-lager" },
      { type: "okänd", id: "x" },
      "skräp",
    ]);
    const parsed = parseRecent(raw);
    expect(parsed.map((e) => e.id)).toEqual(["order:1", "nav-lager"]);
    expect(parseRecent("{inte json")).toEqual([]);
    expect(isInternalHref("/lager")).toBe(true);
    expect(isInternalHref("javascript:alert(1)")).toBe(false);
  });

  it("senaste först, utan dubbletter, högst RECENT_LIMIT", () => {
    let list = parseRecent(null);
    for (let i = 0; i < RECENT_LIMIT + 2; i++)
      list = pushRecent(list, { type: "command", id: `c${i}` });
    list = pushRecent(list, { type: "command", id: "c3" });
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]!.id).toBe("c3");
    expect(list.filter((e) => e.id === "c3")).toHaveLength(1);
  });
});
