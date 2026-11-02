import { describe, expect, it } from "vitest";
import {
  carriedQuery,
  DEFAULT_PERIOD,
  describePeriod,
  parseIsoDate,
  parsePeriod,
  parseScope,
  todayIn,
  toIsoDate,
  wallClockIn,
  withPeriod,
  withScope,
  type DateRange,
} from "./period-state";

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const NOW = d(2026, 11, 2, 9, 30);
const iso = (r: DateRange | null) => (r ? `${toIsoDate(r.start)}/${toIsoDate(r.end)}` : null);
const sp = (q: string) => new URLSearchParams(q);

describe("parsePeriod: förval", () => {
  it("saknad period ger standardvalet", () => {
    const p = parsePeriod(sp(""), { now: NOW });
    expect(p.key).toBe(DEFAULT_PERIOD);
    expect(iso(p.range)).toBe("2026-10-04/2026-11-02");
    expect(iso(p.previous)).toBe("2026-09-04/2026-10-03");
  });
  it("i dag jämförs med i går", () => {
    const p = parsePeriod(sp("period=idag"), { now: NOW });
    expect(iso(p.range)).toBe("2026-11-02/2026-11-02");
    expect(iso(p.previous)).toBe("2026-11-01/2026-11-01");
  });
  it("7 dagar inklusive i dag", () => {
    const p = parsePeriod(sp("period=7d"), { now: NOW });
    expect(iso(p.range)).toBe("2026-10-27/2026-11-02");
    expect(iso(p.previous)).toBe("2026-10-20/2026-10-26");
  });
  it("denna månad jämförs med samma dagar förra månaden", () => {
    const p = parsePeriod(sp("period=manad"), { now: NOW });
    expect(iso(p.range)).toBe("2026-11-01/2026-11-02");
    expect(iso(p.previous)).toBe("2026-10-01/2026-10-02");
  });
  it("denna månad den 31:a kapas vid förra månadens slut", () => {
    const p = parsePeriod(sp("period=manad"), { now: d(2028, 3, 31, 12) });
    expect(iso(p.previous)).toBe("2028-02-01/2028-02-29");
  });
  it("allt saknar jämförelse och har intervall bara med känd start", () => {
    expect(parsePeriod(sp("period=allt"), { now: NOW })).toMatchObject({
      key: "allt",
      range: null,
      previous: null,
    });
    const withStart = parsePeriod(sp("period=allt"), { now: NOW, earliest: d(2025, 3, 14, 15) });
    expect(iso(withStart.range)).toBe("2025-03-14/2026-11-02");
  });
  it("okänt värde ger standardvalet", () => {
    expect(parsePeriod(sp("period=90d"), { now: NOW }).key).toBe(DEFAULT_PERIOD);
    expect(parsePeriod(sp("period="), { now: NOW }).key).toBe(DEFAULT_PERIOD);
  });
});

describe("parsePeriod: eget intervall", () => {
  it("from och to, båda inklusive", () => {
    const p = parsePeriod(sp("from=2026-10-13&to=2026-11-01"), { now: NOW });
    expect(p.key).toBe("eget");
    expect(iso(p.range)).toBe("2026-10-13/2026-11-01");
    expect(iso(p.previous)).toBe("2026-09-23/2026-10-12");
  });
  it("omvänt intervall vänds", () => {
    expect(iso(parsePeriod(sp("from=2026-11-01&to=2026-10-13"), { now: NOW }).range)).toBe(
      "2026-10-13/2026-11-01",
    );
  });
  it("utan to gäller till i dag; framtid kapas", () => {
    expect(iso(parsePeriod(sp("from=2026-10-30"), { now: NOW }).range)).toBe(
      "2026-10-30/2026-11-02",
    );
    expect(iso(parsePeriod(sp("from=2026-10-30&to=2027-01-01"), { now: NOW }).range)).toBe(
      "2026-10-30/2026-11-02",
    );
  });
  it("start i framtiden eller ogiltigt datum ger standardvalet", () => {
    expect(parsePeriod(sp("from=2026-12-01&to=2026-12-05"), { now: NOW }).key).toBe(DEFAULT_PERIOD);
    expect(parsePeriod(sp("from=2026-02-30&to=2026-03-02"), { now: NOW }).key).toBe(DEFAULT_PERIOD);
    expect(parsePeriod(sp("from=13/10/2026"), { now: NOW }).key).toBe(DEFAULT_PERIOD);
  });
  it("ett uttryckligt förval vinner över from/to", () => {
    expect(parsePeriod(sp("period=7d&from=2026-10-13&to=2026-11-01"), { now: NOW }).key).toBe("7d");
    expect(parsePeriod(sp("period=eget&from=2026-10-13&to=2026-11-01"), { now: NOW }).key).toBe(
      "eget",
    );
  });
  it("över sommartidens slut (25 okt) blir det hela dagar", () => {
    const p = parsePeriod(sp("from=2026-10-24&to=2026-10-26"), { now: NOW });
    expect(describePeriod(p).days).toBe(3);
    expect(iso(p.previous)).toBe("2026-10-21/2026-10-23");
  });
});

describe("parsePeriod: indata och tidszon", () => {
  it("tar emot Next-sidans searchParams-objekt", () => {
    const p = parsePeriod({ period: "7d", butik: "s1" }, { now: NOW });
    expect(p.key).toBe("7d");
    const arr = parsePeriod({ from: ["2026-10-13", "2026-01-01"], to: "2026-11-01" }, { now: NOW });
    expect(iso(arr.range)).toBe("2026-10-13/2026-11-01");
  });
  it("i dag räknas i bolagets tidszon, inte serverns", () => {
    // 23:30 UTC 1 nov är 00:30 2 nov i Stockholm.
    const late = new Date(Date.UTC(2026, 10, 1, 23, 30));
    expect(toIsoDate(todayIn(late, "Europe/Stockholm"))).toBe("2026-11-02");
    expect(toIsoDate(todayIn(late, "UTC"))).toBe("2026-11-01");
    expect(toIsoDate(parsePeriod(sp("period=idag"), { now: late }).today)).toBe("2026-11-02");
  });
  it("wallClockIn ger bolagets klockslag", () => {
    const t = wallClockIn(new Date(Date.UTC(2026, 10, 1, 20, 23)), "Europe/Stockholm");
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([1, 21, 23]);
  });
});

describe("skrivning", () => {
  it("withPeriod skriver förval och tar bort from/to, behåller annat", () => {
    const next = withPeriod(sp("from=2026-10-13&to=2026-11-01&butik=s1&sort=fyllnad"), {
      key: "7d",
    });
    expect(next.toString()).toBe("butik=s1&sort=fyllnad&period=7d");
  });
  it("withPeriod skriver eget intervall rättvänt", () => {
    const next = withPeriod(sp("period=30d"), {
      key: "eget",
      range: { start: d(2026, 11, 1), end: d(2026, 10, 13) },
    });
    expect(next.toString()).toBe("from=2026-10-13&to=2026-11-01");
    expect(parsePeriod(next, { now: NOW }).key).toBe("eget");
  });
  it("tur och retur ger samma vy", () => {
    for (const q of [
      "period=idag",
      "period=7d",
      "period=manad",
      "period=allt",
      "from=2026-09-01&to=2026-09-30",
    ]) {
      const a = parsePeriod(sp(q), { now: NOW });
      const sel =
        a.key === "eget" && a.range
          ? { key: "eget" as const, range: a.range }
          : { key: a.key as "7d" };
      const b = parsePeriod(withPeriod(sp(""), sel), { now: NOW });
      expect(b.key).toBe(a.key);
      expect(iso(b.range)).toBe(iso(a.range));
    }
  });
  it("filter: tolkning, sättning och borttagning", () => {
    expect(parseScope(sp("butik=s1&automat=%20"))).toEqual({ butik: "s1", automat: null });
    expect(withScope(sp("period=7d"), { butik: "s2", automat: "m4" }).toString()).toBe(
      "period=7d&butik=s2&automat=m4",
    );
    expect(withScope(sp("period=7d&butik=s2&automat=m4"), { automat: null }).toString()).toBe(
      "period=7d&butik=s2",
    );
  });
  it("carriedQuery bär bara skalets parametrar", () => {
    expect(carriedQuery(sp("period=7d&sort=x&butik=s1"))).toBe("?period=7d&butik=s1");
    expect(carriedQuery(sp("sort=x"))).toBe("");
  });
  it("parseIsoDate avvisar omöjliga datum", () => {
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
    expect(parseIsoDate("2026-02-29")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toBeNull();
  });
});

describe("describePeriod", () => {
  it("kort period och jämförelse", () => {
    const p = parsePeriod(sp("period=7d"), { now: NOW });
    const desc = describePeriod(p);
    const plain = (t: string | null) => t?.replace(/\u00a0/g, " ") ?? null;
    expect({
      ...desc,
      rangeLabel: plain(desc.rangeLabel),
      comparisonLabel: plain(desc.comparisonLabel),
    }).toEqual({
      rangeLabel: "27 okt. – 2 nov.",
      comparisonLabel: "20–26 okt.",
      days: 7,
    });
  });
  it("allt", () => {
    expect(describePeriod(parsePeriod(sp("period=allt"), { now: NOW }))).toEqual({
      rangeLabel: "All data",
      comparisonLabel: null,
      days: null,
    });
  });
});
