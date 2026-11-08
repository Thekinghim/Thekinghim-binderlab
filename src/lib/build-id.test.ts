import { describe, expect, it } from "vitest";

import { isBuildId, resolveBuildId } from "./build-id";

describe("byggets id", () => {
  it("giltiga id", () => {
    expect(isBuildId("dpl_7Hk2abc")).toBe(true);
    expect(isBuildId("71f1344c0ffe")).toBe(true);
    expect(isBuildId("lokal")).toBe(true);
  });

  it.each(["", " ", "a b", "<x>", "x".repeat(81), null, 1])("ogiltigt: %j", (v) => {
    expect(isBuildId(v)).toBe(false);
  });

  it("testkakan räknas bara i next dev", () => {
    expect(
      resolveBuildId({ baked: "A", testOverride: "B", nodeEnv: "development", appEnv: undefined }),
    ).toBe("B");
  });

  it.each([
    ["production", undefined],
    ["production", "production"],
    ["test", undefined],
    [undefined, undefined],
    ["development", "production"],
    ["development", "preview"],
  ])("aldrig i drift (NODE_ENV %s, APP_ENV %s)", (nodeEnv, appEnv) => {
    expect(resolveBuildId({ baked: "A", testOverride: "B", nodeEnv, appEnv })).toBe("A");
  });

  it("ogiltig testkaka: det inbakade id:t", () => {
    expect(
      resolveBuildId({
        baked: "A",
        testOverride: "<x>",
        nodeEnv: "development",
        appEnv: undefined,
      }),
    ).toBe("A");
  });
});
