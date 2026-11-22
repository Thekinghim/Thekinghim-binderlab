import { describe, expect, it } from "vitest";

import { fillReturnTo, parseFillReturn } from "./fill-return";

describe("fillReturnTo", () => {
  it("känner bara Hem och Automater", () => {
    expect(fillReturnTo("hem")).toBe("/");
    expect(fillReturnTo(["automater"])).toBe("/automater");
    expect(fillReturnTo("https://example.com")).toBeNull();
    expect(fillReturnTo("toString")).toBeNull();
    expect(fillReturnTo(undefined)).toBeNull();
  });
});

describe("parseFillReturn", () => {
  const ok = { title: "Påfyllt", detail: "", packs: 4, clientIds: ["a"], at: 1_000 };
  it("läser ett färskt besked", () => {
    expect(parseFillReturn(JSON.stringify(ok), 2_000)?.packs).toBe(4);
  });
  it("struntar i gamla och trasiga besked", () => {
    expect(parseFillReturn(JSON.stringify(ok), 1_000 + 61_000)).toBeNull();
    expect(parseFillReturn("{", 2_000)).toBeNull();
    expect(parseFillReturn(JSON.stringify({ ...ok, clientIds: [1] }), 2_000)).toBeNull();
  });
});
