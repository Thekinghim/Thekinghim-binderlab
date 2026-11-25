import { describe, expect, it } from "vitest";

import { revealLeft } from "./chips";
import { wholeItemLeft } from "./sub-nav";

describe("valt chip syns helt i sidledsraden", () => {
  it("står kvar när chipet redan syns utanför tonade kanterna", () => {
    expect(revealLeft(0, 360, 100, 80)).toBe(0);
  });
  it("rullar fram ett chip som står under högra kanten", () => {
    // Chipet 320–400 i en rad 0–360: slutet + 24 px tona = 424 → raden till 64.
    expect(revealLeft(0, 360, 320, 80)).toBe(64);
  });
  it("rullar tillbaka till ett chip till vänster, aldrig under 0", () => {
    expect(revealLeft(200, 360, 150, 80)).toBe(126);
    expect(revealLeft(200, 360, 10, 80)).toBe(0);
  });
});

describe("underflikarna börjar på en hel flik", () => {
  const starts = [0, 90, 200, 310, 430];
  it("vänsterkanten på en flikstart (minus luft), inte mitt i ett ord", () => {
    expect(wholeItemLeft(150, 400, starts)).toBe(84);
  });
  it("längst till höger: radens slut; raden rullar inte: 0", () => {
    expect(wholeItemLeft(500, 400, starts)).toBe(400);
    expect(wholeItemLeft(50, 0, starts)).toBe(0);
  });
});
