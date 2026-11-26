import { describe, expect, it } from "vitest";

import { isAppleMobile, mapsDirUrl, mapsSearchUrl, telHref } from "./links";

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

  it("iPhone och iPad öppnar Apple Kartor, resten Google", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
    expect(isAppleMobile({ userAgent: iphone })).toBe(true);
    // iPad som säger att den är en Mac (pekskärm).
    expect(isAppleMobile({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 })).toBe(
      true,
    );
    expect(isAppleMobile({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 })).toBe(
      false,
    );
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux" })).toBe(
      false,
    );
  });

  it("Apple Kartor: vägen dit med bil; flera stopp går till Google", () => {
    const one = new URL(mapsSearchUrl({ address: "Gatan 1", city: "Staden" }, "apple")!);
    expect(one.host).toBe("maps.apple.com");
    expect(one.searchParams.get("daddr")).toBe("Gatan 1, Staden");
    expect(one.searchParams.get("dirflg")).toBe("d");
    expect(new URL(mapsDirUrl(["A"], null, "apple")!).host).toBe("maps.apple.com");
    expect(new URL(mapsDirUrl(["A", "B"], null, "apple")!).host).toBe("www.google.com");
    expect(new URL(mapsDirUrl(["A"], "Lagret", "apple")!).host).toBe("www.google.com");
  });
});
