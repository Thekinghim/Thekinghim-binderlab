import { describe, expect, it } from "vitest";

import { deviceHint } from "./device-hint";

const OK = { push: true, denied: false, ios: false, installed: false };

describe("raden om enheten", () => {
  it("ingen rad när allt fungerar", () => {
    expect(deviceHint(OK)).toBeNull();
    expect(deviceHint({ ...OK, ios: true, installed: true })).toBeNull();
  });

  it("iPhone i Safari: lägg på hemskärmen (även när Safari saknar push)", () => {
    expect(deviceHint({ ...OK, ios: true })).toMatch(/hemskärmen/);
    expect(deviceHint({ ...OK, push: false, ios: true })).toMatch(/hemskärmen/);
  });

  it("installerad på för gammal iPhone: uppdatera", () => {
    expect(deviceHint({ ...OK, push: false, ios: true, installed: true })).toMatch(/16\.4/);
  });

  it("blockerade notiser och webbläsare utan stöd", () => {
    expect(deviceHint({ ...OK, denied: true })).toMatch(/blockerade/);
    expect(deviceHint({ ...OK, push: false })).toMatch(/kan inte/);
  });
});
