import { describe, expect, it } from "vitest";

import { isTransientLoadError } from "./load-error";

describe("isTransientLoadError", () => {
  it("känner igen brutna nedladdningar i Safari, Chrome, Firefox och React", () => {
    expect(isTransientLoadError(new TypeError("Load failed"))).toBe(true);
    expect(isTransientLoadError(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isTransientLoadError(new TypeError("NetworkError when attempting to fetch resource.")),
    ).toBe(true);
    expect(isTransientLoadError(new Error("Connection closed."))).toBe(true);
    expect(isTransientLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isTransientLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(
      true,
    );
  });

  it("programfel och serverfel räknas inte", () => {
    expect(
      isTransientLoadError(new TypeError("undefined is not an object (evaluating 'a.b')")),
    ).toBe(false);
    expect(
      isTransientLoadError(Object.assign(new TypeError("Load failed"), { digest: "123" })),
    ).toBe(false);
    expect(isTransientLoadError(null)).toBe(false);
    expect(isTransientLoadError("Load failed")).toBe(false);
  });
});
