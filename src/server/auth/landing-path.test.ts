import { describe, expect, it } from "vitest";

import { landingPath } from "./landing-path";

const none = { member: false, staff: false, store: false };

/** Påfyllare och butiker hamnar direkt på sin sida efter inloggningen (ingen omväg via /). */
describe("landingPath", () => {
  it("medlemmar går dit de skulle", () => {
    expect(landingPath("/", { ...none, member: true })).toBe("/");
    expect(landingPath("/automater", { member: true, staff: true, store: true })).toBe(
      "/automater",
    );
  });

  it("påfyllare i butiken till /pafyll", () => {
    expect(landingPath("/", { ...none, staff: true })).toBe("/pafyll");
    expect(landingPath("/automater", { ...none, staff: true })).toBe("/pafyll");
    expect(landingPath("/pafyll/ny-pin", { ...none, staff: true })).toBe("/pafyll/ny-pin");
  });

  it("butiksanvändare till /portal", () => {
    expect(landingPath("/", { ...none, store: true })).toBe("/portal");
    expect(landingPath("/portal/avrakningar", { ...none, store: true })).toBe(
      "/portal/avrakningar",
    );
    expect(landingPath("/portalen", { ...none, store: true })).toBe("/portal");
  });

  it("utan medlemskap och roll: som förut", () => {
    expect(landingPath("/", none)).toBe("/");
  });
});
