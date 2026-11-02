import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limit";

describe("begränsning av försök", () => {
  it("stoppar efter gränsen och släpper efter fönstret", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check("k").allowed).toBe(true);
      limiter.hit("k");
    }
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.check("annan").allowed).toBe(true);
    now = 999;
    expect(limiter.check("k").allowed).toBe(false);
    now = 1000;
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("nollställs efter lyckat försök", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    limiter.hit("k");
    expect(limiter.check("k").allowed).toBe(false);
    limiter.reset("k");
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("håller nere antalet nycklar", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => 0 });
    limiter.hit("a");
    limiter.hit("b");
    limiter.hit("c");
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(false);
  });
});
