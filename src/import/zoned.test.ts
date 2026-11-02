import { describe, expect, it } from "vitest";

import {
  businessDateOf,
  formatInZone,
  isValidTimeZone,
  parseSourceDateTime,
  zonedToUtc,
  type LocalDateTime,
} from "./zoned";

function local(text: string): LocalDateTime {
  const p = parseSourceDateTime(text);
  if (!p.ok || p.kind !== "local") {
    throw new Error(`kunde inte tolka ${text}`);
  }
  return p.local;
}

describe("parseSourceDateTime", () => {
  it.each([
    ["2026-11-02 00:17:00", { year: 2026, month: 11, day: 2, hour: 0, minute: 17, second: 0 }],
    ["2026-11-02 00:17", { year: 2026, month: 11, day: 2, hour: 0, minute: 17, second: 0 }],
    ["2026/11/02 00:17", { year: 2026, month: 11, day: 2, hour: 0, minute: 17, second: 0 }],
    ["2026/1/2 7:05:09", { year: 2026, month: 1, day: 2, hour: 7, minute: 5, second: 9 }],
    ["2026-11-02T23:59:59", { year: 2026, month: 11, day: 2, hour: 23, minute: 59, second: 59 }],
    ["  2026-02-28 12:00:00  ", { year: 2026, month: 2, day: 28, hour: 12, minute: 0, second: 0 }],
    ["2028-02-29 12:00:00", { year: 2028, month: 2, day: 29, hour: 12, minute: 0, second: 0 }],
  ])("%j", (text, expected) => {
    expect(local(text)).toMatchObject(expected);
  });

  it.each([
    "",
    "2026-11-02",
    "02/11/2026 00:17",
    "2026-13-01 10:00:00",
    "2026-02-29 10:00:00",
    "2026-11-31 10:00:00",
    "2026-11-02 24:00:00",
    "2026-11-02 23:60:00",
    "2026-11-02 23:59:60",
    "1999-12-31 23:00:00",
    "igår 17:17",
  ])("nekar %j", (text) => {
    expect(parseSourceDateTime(text).ok).toBe(false);
  });

  it("tider med zonangivelse är redan entydiga", () => {
    const z = parseSourceDateTime("2026-11-02T00:17:00+08:00");
    expect(z.ok && z.kind === "absolute" && z.utc.toISOString()).toBe("2026-11-01T16:17:00.000Z");
    const u = parseSourceDateTime("2026-11-01 16:17:00Z");
    expect(u.ok && u.kind === "absolute" && u.utc.toISOString()).toBe("2026-11-01T16:17:00.000Z");
  });
});

describe("zonedToUtc", () => {
  it("order 42780: 2 nov. 00:17 i Shanghai = 1 nov. 16:17 UTC = 1 nov. 17:17 svensk tid", () => {
    const r = zonedToUtc(local("2026-11-02 00:17:00"), "Asia/Shanghai");
    expect(r.resolution).toBe("exact");
    expect(r.utc.toISOString()).toBe("2026-11-01T16:17:00.000Z");
    expect(formatInZone(r.utc, "Europe/Stockholm")).toBe("2026-11-01 17:17:00");
    expect(businessDateOf(r.utc, "Europe/Stockholm")).toBe("2026-11-01");
    expect(businessDateOf(r.utc, "Asia/Shanghai")).toBe("2026-11-02");
  });

  it("Shanghai har ingen sommartid: varje lokal tid i sommartidsveckan är entydig", () => {
    for (let h = 0; h < 24; h += 1) {
      const text = `2026-10-25 ${String(h).padStart(2, "0")}:30:00`;
      const r = zonedToUtc(local(text), "Asia/Shanghai");
      expect(r.resolution).toBe("exact");
      expect(r.utc.getTime()).toBe(Date.UTC(2026, 9, 25, h - 8, 30));
    }
  });

  it("dubbeltimmen 25 okt. 2026 i Stockholm: tidigaste väljs och markeras", () => {
    const r = zonedToUtc(local("2026-10-25 02:30:00"), "Europe/Stockholm");
    expect(r.resolution).toBe("ambiguous");
    expect(r.utc.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(r.candidates.map((d) => d.toISOString())).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
  });

  it("timmarna runt dubbeltimmen i Stockholm är entydiga", () => {
    expect(zonedToUtc(local("2026-10-25 01:59:59"), "Europe/Stockholm")).toMatchObject({
      resolution: "exact",
      utc: new Date("2026-10-24T23:59:59Z"),
    });
    expect(zonedToUtc(local("2026-10-25 03:00:00"), "Europe/Stockholm")).toMatchObject({
      resolution: "exact",
      utc: new Date("2026-10-25T02:00:00Z"),
    });
  });

  it("glappet 29 mars 2026 i Stockholm flyttas fram och markeras", () => {
    const r = zonedToUtc(local("2026-03-29 02:30:00"), "Europe/Stockholm");
    expect(r.resolution).toBe("gap");
    expect(r.utc.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(formatInZone(r.utc, "Europe/Stockholm")).toBe("2026-03-29 03:30:00");
  });

  it("UTC → svenskt affärsdatum runt midnatt och sommartid", () => {
    expect(businessDateOf(new Date("2026-10-24T21:59:59Z"), "Europe/Stockholm")).toBe("2026-10-24");
    expect(businessDateOf(new Date("2026-10-24T22:00:00Z"), "Europe/Stockholm")).toBe("2026-10-25");
    expect(businessDateOf(new Date("2026-10-25T22:59:59Z"), "Europe/Stockholm")).toBe("2026-10-25");
    expect(businessDateOf(new Date("2026-10-25T23:00:00Z"), "Europe/Stockholm")).toBe("2026-10-26");
    expect(businessDateOf(new Date("2026-12-31T23:00:00Z"), "Europe/Stockholm")).toBe("2027-01-01");
  });

  it("rundresa lokal → UTC → lokal för varje halvtimme ett helt år i Stockholm", () => {
    let ambiguous = 0;
    let gaps = 0;
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 30 * 60_000) {
      const text = new Date(t).toISOString().slice(0, 19).replace("T", " ");
      const r = zonedToUtc(local(text), "Europe/Stockholm");
      if (r.resolution === "gap") {
        gaps += 1;
        continue;
      }
      if (r.resolution === "ambiguous") {
        ambiguous += 1;
      }
      expect(formatInZone(r.utc, "Europe/Stockholm")).toBe(text);
    }
    expect(ambiguous).toBe(2);
    expect(gaps).toBe(2);
  });

  it("okänd tidszon kastar", () => {
    expect(isValidTimeZone("Europe/Stockholm")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(() => zonedToUtc(local("2026-11-02 00:17:00"), "Mars/Olympus")).toThrow(RangeError);
  });
});
