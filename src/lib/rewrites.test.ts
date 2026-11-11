import { describe, expect, it } from "vitest";

import { APP_REWRITES } from "./rewrites";

/** Next:s källmönster (path-to-regexp) för de enkla mönster som används här. */
function matcher(source: string): RegExp {
  const pattern = source.replace(/:[A-Za-z]+\(([^)]+)\)/g, "($1)");
  return new RegExp(`^${pattern}/?$`);
}

describe("omskrivningar (next.config.ts)", () => {
  it("/fyll-pa/<automat> visar listans rutt, så att adressen och sidan aldrig hör till olika rutter", () => {
    const rule = APP_REWRITES.find((r) => r.source.startsWith("/fyll-pa/"));
    expect(rule?.destination).toBe("/fyll-pa");
    const re = matcher(rule!.source);
    expect(re.test("/fyll-pa/067621fb-dec9-415f-8584-1ff013eda035")).toBe(true);
    expect(re.test("/fyll-pa/067621FB-DEC9-415F-8584-1FF013EDA035")).toBe(true);
  });

  it("gäller bara ett id: listan, QR-sidan och annat rörs inte", () => {
    const re = matcher(APP_REWRITES.find((r) => r.source.startsWith("/fyll-pa/"))!.source);
    for (const path of [
      "/fyll-pa",
      "/fyll-pa/067621fb-dec9-415f-8584-1ff013eda035/qr",
      "/fyll-pa/abc",
      "/fyll-pa/067621fb-dec9-415f-8584-1ff013eda03",
      "/drift/067621fb-dec9-415f-8584-1ff013eda035",
    ]) {
      expect(re.test(path), path).toBe(false);
    }
  });

  it("målet är en sökväg i appen, utan fråga (rutten ska vara exakt listans)", () => {
    for (const r of APP_REWRITES) {
      expect(r.destination.startsWith("/")).toBe(true);
      expect(r.destination).not.toMatch(/[?#:]/);
    }
  });
});
