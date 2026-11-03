import { describe, expect, it } from "vitest";

import {
  foldLine,
  googleMapsUrls,
  icsText,
  mapsQuery,
  MAX_WAYPOINTS,
  parseLocation,
  stopsWithoutPlace,
  visitIcs,
  type RouteStop,
} from "./links";

function stop(n: number, over: Partial<RouteStop> = {}): RouteStop {
  return {
    machineId: `m${n}`,
    label: `BL‑00${n} Automat ${n}`,
    storeId: `s${n}`,
    storeName: `Butik ${n}`,
    address: `Storgatan ${n}`,
    city: "Lund",
    location: null,
    packs: 10 * n,
    ...over,
  };
}

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("mapsQuery", () => {
  it("tar bort | ur adressen (skiljer mellanstoppen i länken)", () => {
    expect(mapsQuery({ address: "Storgatan 1 | port B", city: "Lund", location: null })).toBe(
      "Storgatan 1 port B, Lund",
    );
  });

  it("koordinater före adress; ort läggs till om den inte redan står i adressen", () => {
    expect(mapsQuery({ address: "A 1", city: "Lund", location: { lat: 55.7, lng: 13.19 } })).toBe(
      "55.7,13.19",
    );
    expect(mapsQuery({ address: "Storgatan 1", city: "Lund", location: null })).toBe(
      "Storgatan 1, Lund",
    );
    expect(mapsQuery({ address: "Storgatan 1, 222 22 Lund", city: "Lund", location: null })).toBe(
      "Storgatan 1, 222 22 Lund",
    );
    expect(mapsQuery({ address: "  ", city: "Lund", location: null })).toBeNull();
  });
});

describe("googleMapsUrls", () => {
  it("sista stoppet är destination, övriga mellanstopp i ordning, ingen origin", () => {
    const [url, ...rest] = googleMapsUrls([stop(1), stop(2), stop(3)]);
    expect(rest).toEqual([]);
    expect(url!.startsWith("https://www.google.com/maps/dir/?api=1")).toBe(true);
    const p = params(url!);
    expect(p.get("destination")).toBe("Storgatan 3, Lund");
    expect(p.get("waypoints")).toBe("Storgatan 1, Lund|Storgatan 2, Lund");
    expect(p.get("origin")).toBeNull();
    expect(p.get("travelmode")).toBe("driving");
  });

  it("ett stopp: bara destination; stopp utan adress hoppas över; inga = inga länkar", () => {
    const p = params(googleMapsUrls([stop(1, { address: null }), stop(2)])[0]!);
    expect(p.get("destination")).toBe("Storgatan 2, Lund");
    expect(p.get("waypoints")).toBeNull();
    expect(googleMapsUrls([stop(1, { address: null })])).toEqual([]);
    expect(
      stopsWithoutPlace([stop(1, { address: null }), stop(2)]).map((s) => s.machineId),
    ).toEqual(["m1"]);
  });

  it("fler än MAX_WAYPOINTS + 1 stopp delas; nästa länk startar vid förra destinationen", () => {
    const stops = Array.from({ length: MAX_WAYPOINTS + 3 }, (_, i) => stop(i + 1));
    const urls = googleMapsUrls(stops);
    expect(urls).toHaveLength(2);
    const a = params(urls[0]!);
    const b = params(urls[1]!);
    expect(a.get("waypoints")!.split("|")).toHaveLength(MAX_WAYPOINTS);
    expect(b.get("origin")).toBe(a.get("destination"));
    expect(b.get("destination")).toBe(`Storgatan ${MAX_WAYPOINTS + 3}, Lund`);
  });
});

describe("parseLocation", () => {
  it("läser koordinater ur Google Maps-länkar och text", () => {
    expect(parseLocation("https://www.google.com/maps/place/X/@55.7047,13.191,17z")).toEqual({
      lat: 55.7047,
      lng: 13.191,
    });
    expect(
      parseLocation("https://www.google.com/maps/place/X/@1,1,17z/data=!3d55.70471!4d13.19101"),
    ).toEqual({ lat: 55.70471, lng: 13.19101 });
    expect(parseLocation("https://maps.google.com/?q=59.3293,18.0686")).toEqual({
      lat: 59.3293,
      lng: 18.0686,
    });
    expect(parseLocation("59.3293, 18.0686")).toEqual({ lat: 59.3293, lng: 18.0686 });
  });

  it("tomt = null, ogiltigt = undefined", () => {
    expect(parseLocation("")).toBeNull();
    expect(parseLocation("  ")).toBeNull();
    expect(parseLocation("Storgatan 1")).toBeUndefined();
    expect(parseLocation("https://maps.app.goo.gl/abc")).toBeUndefined();
    expect(parseLocation("95, 18")).toBeUndefined();
  });
});

describe("kalender", () => {
  it("escapar och viker rader enligt RFC 5545", () => {
    expect(icsText("a,b;c\\d\ne")).toBe(String.raw`a\,b\;c\\d\ne`);
    const long = `DESCRIPTION:${"å".repeat(80)}`;
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("en heldagshändelse per dag med stabilt UID, stoppen och kartlänken", () => {
    const ics = visitIcs(
      [{ date: "2026-11-04", summary: "Påfyllning: 2 besök, 30 pack", stops: [stop(1), stop(2)] }],
      "org1",
      new Date("2026-11-03T08:00:00Z"),
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("UID:besok-20261104-org1@binderlab");
    expect(unfolded).toContain("DTSTART;VALUE=DATE:20261104");
    expect(unfolded).toContain("DTEND;VALUE=DATE:20261105");
    expect(unfolded).toContain("DTSTAMP:20261103T080000Z");
    expect(unfolded).toContain("SUMMARY:Påfyllning: 2 besök\\, 30 pack");
    expect(unfolded).toContain("1. BL‑001 Automat 1 – Butik 1\\, Storgatan 1\\, Lund (10 pack)");
    expect(unfolded).toContain("Karta: https://www.google.com/maps/dir/?api=1");
    expect(unfolded).toContain("LOCATION:Butik 1\\, Storgatan 1\\, Lund");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("utan dagar blir det en tom kalender", () => {
    const ics = visitIcs([], "org1", new Date("2026-11-03T08:00:00Z"));
    expect(ics).not.toContain("VEVENT");
  });
});
