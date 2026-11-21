import { describe, expect, it } from "vitest";

import { mapsDirUrl, mapsSearchUrl, telHref } from "./links";

describe("länkar ut ur appen", () => {
  it("tel: bara siffror", () => {
    expect(telHref("070-000 00 00")).toBe("tel:0700000000");
    expect(telHref("+46 70 000 00 00")).toBe("tel:+46700000000");
    expect(telHref("")).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it("en plats: adress, annars koordinater", () => {
    expect(mapsSearchUrl({ address: "Gatan 1", city: "Staden" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Gatan%201%2C%20Staden",
    );
    expect(mapsSearchUrl({ lat: 57.7, lng: 11.9 })).toContain("query=57.7%2C11.9");
    expect(mapsSearchUrl({})).toBeNull();
  });

  it("hela rutten från lagret och tillbaka, högst nio mellanstopp", () => {
    const url = new URL(mapsDirUrl(["A", "B"], "Lagret")!);
    expect(url.searchParams.get("origin")).toBe("Lagret");
    expect(url.searchParams.get("destination")).toBe("Lagret");
    expect(url.searchParams.get("waypoints")).toBe("A|B");
    const many = new URL(mapsDirUrl(Array.from({ length: 12 }, (_, i) => `S${i}`))!);
    expect(many.searchParams.get("destination")).toBe("S11");
    expect(many.searchParams.get("waypoints")?.split("|")).toHaveLength(9);
    expect(mapsDirUrl([])).toBeNull();
  });
});
