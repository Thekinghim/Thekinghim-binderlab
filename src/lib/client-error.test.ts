import { describe, expect, it } from "vitest";

import {
  CLIENT_ERROR_LIMITS,
  clampClientError,
  describeThrown,
  scrubPath,
  scrubText,
} from "./client-error";

describe("klientfel: det som får skickas och sparas", () => {
  it("bara sökvägen, utan frågesträng och fragment", () => {
    expect(scrubPath("/drift?token=abc#x")).toBe("/drift");
    expect(scrubPath("/#a?b")).toBe("/");
    expect(scrubPath(42)).toBe("");
    expect(scrubPath("/a".repeat(500))).toHaveLength(CLIENT_ERROR_LIMITS.path);
    // En länk med en token i sökvägen (/inbjudan/<token>) sparar aldrig token.
    expect(scrubPath(`/inbjudan/${"k".repeat(48)}`)).toBe("/inbjudan/[token]");
  });

  it("tar bort frågesträngar i adresser, e-post, token och styrtecken", () => {
    expect(
      scrubText("at https://x.se/_next/a.js?dpl=dpl_1&k=secret:1:2 and https://y.se/b#frag", 500),
    ).toBe("at https://x.se/_next/a.js and https://y.se/b");
    expect(scrubText("ägaren anna.berg@example.se fick fel", 500)).toBe("ägaren [e-post] fick fel");
    expect(scrubText("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", 500)).toBe(
      "Bearer [token]",
    );
    expect(scrubText("a\u0000b\u0007c\nd", 500)).toBe("abc\nd");
    expect(scrubText(undefined, 10)).toBe("");
  });

  it("kortar varje fält till sin gräns", () => {
    const r = clampClientError({
      path: "/x",
      message: "m ".repeat(1000),
      stack: "s ".repeat(5000),
      digest: "d".repeat(200),
      buildId: "b".repeat(200),
      userAgent: "u ".repeat(400),
    });
    expect(r?.message).toHaveLength(500);
    expect(r?.stack).toHaveLength(4000);
    expect(r?.userAgent).toHaveLength(300);
    expect(r?.digest).toHaveLength(100);
    expect(r?.buildId).toHaveLength(80);
    // Ett bygge som är en hel incheckning (40 tecken) är inget hemligt och sparas som det är.
    const sha = "f29d18fe".repeat(5);
    expect(clampClientError({ message: "x", buildId: sha })?.buildId).toBe(sha);
    expect(clampClientError({ message: "x", digest: "a b<script>" })?.digest).toBeNull();
  });

  it("ogiltigt eller tomt blir null, okända fält i extra försvinner", () => {
    expect(clampClientError(null)).toBeNull();
    expect(clampClientError("x")).toBeNull();
    expect(clampClientError([])).toBeNull();
    expect(clampClientError({ path: "/" })).toBeNull();
    const r = clampClientError({
      path: "/?q=1",
      message: "TypeError: x",
      digest: "",
      extra: {
        source: "unhandledrejection",
        online: false,
        standalone: true,
        visibility: "visible",
        cookie: "sb=1",
      },
    });
    expect(r).toEqual({
      path: "/",
      message: "TypeError: x",
      stack: "",
      digest: null,
      buildId: null,
      userAgent: null,
      extra: {
        source: "unhandledrejection",
        online: false,
        standalone: true,
        visibility: "visible",
      },
    });
    expect(
      clampClientError({ message: "x", extra: { source: "evil", visibility: "<b>" } })?.extra,
    ).toEqual({ source: "boundary" });
  });

  it("describeThrown: Error, sträng, null och objekt som kastar", () => {
    const e = Object.assign(new TypeError("boom"), { digest: "123" });
    expect(describeThrown(e)).toMatchObject({ message: "TypeError: boom", digest: "123" });
    expect(describeThrown("text")).toEqual({ message: "text", stack: "", digest: null });
    expect(describeThrown(null).message).toBe("null");
    const evil = {
      get message(): string {
        throw new Error("nej");
      },
    };
    expect(describeThrown(evil).message).toBe("Okänt fel");
  });
});
