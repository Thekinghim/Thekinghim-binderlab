import { describe, expect, it } from "vitest";

import { isChunkLoadError, isTransientLoadError } from "./load-error";

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

  it("Reacts produktionsfel #412 (strömmen bröts) och kodfiler som saknas", () => {
    expect(
      isTransientLoadError(
        new Error(
          "Minified React error #412; visit https://react.dev/errors/412 for the full message",
        ),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new Error("Failed to load chunk /_next/static/chunks/a.js"))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError("Load failed"))).toBe(false);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
  });
});
