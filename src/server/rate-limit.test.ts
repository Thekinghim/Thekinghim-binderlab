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

  it("håller nere antalet nycklar men tar aldrig bort en spärrad nyckel", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => 0 });
    limiter.hit("a");
    limiter.hit("a"); // a är spärrad
    limiter.hit("b"); // b är inte spärrad
    limiter.hit("c"); // tar bort b (äldsta ospärrade), inte a
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("c").allowed).toBe(true);
    limiter.hit("c"); // nu är både a och c spärrade
    // Minnet är fullt av spärrade nycklar: nya nycklar nekas (fail closed).
    expect(limiter.consume([{ key: "d" }])).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("consume räknar före försöket och är atomär över flera nycklar", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    const both = [{ key: "par" }, { key: "konto", limit: 3 }];
    expect(limiter.consume(both).allowed).toBe(true);
    expect(limiter.consume(both).allowed).toBe(true);
    // "par" är spärrad: inget räknas, inte heller "konto".
    expect(limiter.consume(both)).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.consume([{ key: "konto", limit: 3 }]).allowed).toBe(true);
    expect(limiter.consume([{ key: "konto", limit: 3 }]).allowed).toBe(false);
    now = 1000;
    expect(limiter.consume(both).allowed).toBe(true);
  });

  it("en egen gräns per nyckel gäller även vid check", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: () => 0 });
    limiter.hit("k", 1);
    expect(limiter.check("k").allowed).toBe(false);
    expect(limiter.check("k", 10).allowed).toBe(false);
  });
});
