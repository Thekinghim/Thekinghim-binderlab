import { describe, expect, it } from "vitest";

import { toolHref, withToolHrefs } from "./links";

describe("assistentens länkar i underlaget", () => {
  it("översätter /forsaljning (som 404:ade) till Lönsamhet per dag/veckodag", () => {
    expect(toolHref("/forsaljning?fran=2026-10-24&till=2026-10-24")).toBe(
      "/lonsamhet?from=2026-10-24&to=2026-10-24&per=dag",
    );
    expect(toolHref("/forsaljning?fran=2026-10-05&till=2026-11-02&vy=veckodag")).toMatch(
      /^\/lonsamhet\?/,
    );
  });

  it("den gamla bokföringsadressen går till Ekonomi → Bokföring", () => {
    expect(toolHref("/ekonomi/bokforing")).toBe("/ekonomi?vy=bokforing#bokforing");
  });

  it("vanliga sidor är oförändrade och externa adresser blir /", () => {
    expect(toolHref("/lager?automat=m1")).toBe("/lager?automat=m1");
    expect(toolHref("https://example.com/x")).toBe("/");
    expect(withToolHrefs([{ label: "Bokföring", href: "/ekonomi/bokforing" }])).toEqual([
      { label: "Bokföring", href: "/ekonomi?vy=bokforing#bokforing" },
    ]);
  });
});

describe("verktygens egna länkar", () => {
  it("ingen fast länk går till en sida som inte finns", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL("./tools/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const hrefs: string[] = [];
    for (const f of files) {
      const text = await readFile(new URL(f, dir), "utf8");
      for (const m of text.matchAll(/href: "([^"]+)"/g)) hrefs.push(m[1]!);
    }
    expect(hrefs.length).toBeGreaterThan(5);
    const broken = hrefs.filter((h) => /^\/(forsaljning|titlar)\b|^\/ekonomi\/bokforing\b/.test(h));
    expect(broken).toEqual([]);
  });
});
