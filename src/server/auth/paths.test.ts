import { describe, expect, it } from "vitest";

import { isPublicPath, loginRedirectPath, safeRedirectPath } from "./paths";

describe("öppna sökvägar", () => {
  it.each([
    "/logga-in",
    "/inbjudan/abc123",
    "/design",
    "/design/komponenter",
    "/design-system",
    "/datamodell",
    "/datamodell/order",
    "/rapport/2026-10/butik",
    "/_next/static/chunk.js",
    "/favicon.ico",
    "/bilder/logo.svg",
  ])("%s är öppen", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/lonsamhet",
    "/installningar",
    "/inbjudan",
    "/rapport",
    "/rapporter",
    "/datamodeller",
    "/logga-in-x",
    "/api/export.csv.php",
  ])("%s kräver inloggning", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("säkra omdirigeringar", () => {
  it("släpper igenom lokala sökvägar", () => {
    expect(safeRedirectPath("/lonsamhet?vy=butik#tabell")).toBe("/lonsamhet?vy=butik#tabell");
    expect(safeRedirectPath("/")).toBe("/");
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "lonsamhet",
    "/\t/evil.example",
    "/logga-in",
    "",
    undefined,
    42,
  ])("stoppar %s", (next) => {
    expect(safeRedirectPath(next)).toBe("/");
  });

  it("bygger inloggningslänken med next", () => {
    expect(loginRedirectPath("/lonsamhet", "?vy=butik")).toBe(
      "/logga-in?next=%2Flonsamhet%3Fvy%3Dbutik",
    );
    expect(loginRedirectPath("/")).toBe("/logga-in");
    expect(loginRedirectPath("//evil.example")).toBe("/logga-in");
  });
});
