/**
 * Den gemensamma periodmodellen: I går, Förra månaden, eget intervall (?from/?to och
 * ?fran/?till), gränser (två år, framtid, skräp), sommartid i Europe/Stockholm, namn,
 * jämförelsetexter, diagrammets upplösning och kakan som bär valet mellan sidor.
 */
import { describe, expect, it } from "vitest";

import {
  carriedQuery,
  chartUnitFor,
  compareText,
  DEFAULT_PERIOD,
  describePeriod,
  hasPeriodParam,
  isSingleDay,
  MAX_RANGE_DAYS,
  parsePeriod,
  periodCookieFromUrl,
  periodCookieValue,
  periodFromCookie,
  periodName,
  periodNameCompact,
  periodNameInline,
  periodQuery,
  periodRedirect,
  toIsoDate,
  withPeriod,
  withPeriodHref,
  type DateRange,
} from "./period-state";

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const NOW = d(2026, 11, 22, 10);
const iso = (r: DateRange | null) => (r ? `${toIsoDate(r.start)}/${toIsoDate(r.end)}` : null);
const sp = (q: string) => new URLSearchParams(q);
const plain = (t: string | null) => t?.replace(/\u2060/g, "").replace(/\u00a0/g, " ") ?? null;

describe("I går", () => {
  it("är gårdagen, jämförs med dagen innan", () => {
    const p = parsePeriod(sp("period=igar"), { now: NOW });
    expect(p.key).toBe("igar");
    expect(iso(p.range)).toBe("2026-11-21/2026-11-21");
    expect(iso(p.previous)).toBe("2026-11-20/2026-11-20");
    expect(isSingleDay(p)).toBe(true);
    expect(periodName(p)).toBe("I går");
    expect(periodNameInline(p)).toBe("i går");
    expect(compareText(p)).toBe("mot dagen innan");
  });
  it("räknas i bolagets tidszon: 00:30 i Stockholm är redan nästa dag", () => {
    // 23:30 UTC 24 okt = 01:30 25 okt (CEST, sista sommartidsdygnet).
    const late = new Date(Date.UTC(2026, 9, 24, 23, 30));
    expect(
      iso(parsePeriod(sp("period=igar"), { now: late, timeZone: "Europe/Stockholm" }).range),
    ).toBe("2026-10-24/2026-10-24");
    expect(iso(parsePeriod(sp("period=igar"), { now: late, timeZone: "UTC" }).range)).toBe(
      "2026-10-23/2026-10-23",
    );
  });
  it("dagen efter sommartidens början (29 mars, 23 timmar) är en hel dag", () => {
    const now = new Date(Date.UTC(2026, 2, 30, 6)); // 08:00 30 mars i Stockholm
    const p = parsePeriod(sp("period=igar"), { now, timeZone: "Europe/Stockholm" });
    expect(iso(p.range)).toBe("2026-03-29/2026-03-29");
    expect(iso(p.previous)).toBe("2026-03-28/2026-03-28");
    expect(describePeriod(p).days).toBe(1);
  });
  it("vid årsskiftet: i går är 31 december", () => {
    const p = parsePeriod(sp("period=igar"), { now: d(2027, 1, 1, 9) });
    expect(iso(p.range)).toBe("2026-12-31/2026-12-31");
    expect(iso(p.previous)).toBe("2026-12-30/2026-12-30");
  });
});

describe("Förra månaden", () => {
  it("hela förra månaden, jämförs med månaden innan", () => {
    const p = parsePeriod(sp("period=forra-manaden"), { now: NOW });
    expect(iso(p.range)).toBe("2026-10-01/2026-10-31");
    expect(iso(p.previous)).toBe("2026-09-01/2026-09-30");
    expect(periodName(p)).toBe("Förra månaden");
    expect(compareText(p)).toBe("mot månaden innan");
  });
  it("den 31 mars: februari (skottår), jämförs med januari", () => {
    const p = parsePeriod(sp("period=forra-manaden"), { now: d(2028, 3, 31, 12) });
    expect(iso(p.range)).toBe("2028-02-01/2028-02-29");
    expect(iso(p.previous)).toBe("2028-01-01/2028-01-31");
  });
  it("i januari: december året innan", () => {
    const p = parsePeriod(sp("period=forra-manaden"), { now: d(2027, 1, 15) });
    expect(iso(p.range)).toBe("2026-12-01/2026-12-31");
    expect(iso(p.previous)).toBe("2026-11-01/2026-11-30");
  });
  it("över sommartidens slut (oktober) blir det 31 hela dagar", () => {
    expect(describePeriod(parsePeriod(sp("period=forra-manaden"), { now: NOW })).days).toBe(31);
  });
});

describe("eget intervall", () => {
  it("?fran=&till= läses som ?from=&to=", () => {
    const p = parsePeriod(sp("fran=2026-11-14&till=2026-11-20"), { now: NOW });
    expect(p.key).toBe("eget");
    expect(iso(p.range)).toBe("2026-11-14/2026-11-20");
    expect(iso(p.previous)).toBe("2026-11-07/2026-11-13");
    expect(plain(periodName(p))).toBe("14–20 nov.");
    expect(compareText(p)).toBe("mot 7 dagar innan");
  });
  it("en dag: jämförs med dagen innan; i går heter I går", () => {
    const one = parsePeriod(sp("from=2026-11-10&to=2026-11-10"), { now: NOW });
    expect(compareText(one)).toBe("mot dagen innan");
    expect(iso(one.previous)).toBe("2026-11-09/2026-11-09");
    expect(periodName(parsePeriod(sp("from=2026-11-21&to=2026-11-21"), { now: NOW }))).toBe(
      "I går",
    );
  });
  it("högst två år; längre ger standardvalet", () => {
    const max = parsePeriod(sp("from=2024-11-22&to=2026-11-22"), { now: NOW });
    expect(describePeriod(max).days).toBe(MAX_RANGE_DAYS);
    expect(max.key).toBe("eget");
    expect(parsePeriod(sp("from=2024-11-21&to=2026-11-22"), { now: NOW }).key).toBe(DEFAULT_PERIOD);
  });
  it("skräp kraschar aldrig utan ger standardvalet", () => {
    for (const q of [
      "from=x&to=y",
      "fran=2026-13-40",
      "from=2027-01-01&to=2027-01-05",
      "period=igår",
      "period=forra_manaden",
      "from=&to=",
      "till=2026-11-01",
      // En start i framtiden utan slut, och ett slut som inte är ett datum.
      "from=2026-11-23",
      "from=2026-10-01&to=garbage",
    ]) {
      expect(parsePeriod(sp(q), { now: NOW }).key, q).toBe(DEFAULT_PERIOD);
    }
  });
  it("en dag som är i dag eller i går är förvalet (ingen halv dag mot en hel)", () => {
    const today = parsePeriod(sp("from=2026-11-22&to=2026-11-22"), { now: NOW });
    expect(today.key).toBe("idag");
    expect(compareText(today)).toBe("mot i går");
    expect(parsePeriod(sp("from=2026-11-21&to=2026-11-21"), { now: NOW }).key).toBe("igar");
    expect(parsePeriod(sp("from=2026-11-20&to=2026-11-20"), { now: NOW }).key).toBe("eget");
  });
  it("telefonens korta namn visar slutet på ett långt intervall", () => {
    const p = parsePeriod(sp("from=2025-12-28&to=2026-01-03"), { now: NOW });
    expect(periodNameCompact(p)).toBe("28/12–3/1");
    expect(periodNameCompact(parsePeriod(sp("period=igar"), { now: NOW }))).toBe("I går");
    // Korta namn står kvar ("10 nov.").
    const one = parsePeriod(sp("from=2026-11-10&to=2026-11-10"), { now: NOW });
    expect(periodNameCompact(one)).toBe(periodName(one));
  });
  it("slut i framtiden kapas vid i dag", () => {
    expect(iso(parsePeriod(sp("from=2026-11-20&to=2026-12-31"), { now: NOW }).range)).toBe(
      "2026-11-20/2026-11-22",
    );
  });
  it("över sommartidens slut: hela dagar och lika lång jämförelse", () => {
    const p = parsePeriod(sp("from=2026-10-20&to=2026-10-30"), { now: NOW });
    expect(describePeriod(p).days).toBe(11);
    expect(iso(p.previous)).toBe("2026-10-09/2026-10-19");
  });
  it("withPeriod tar bort ?fran/?till och skriver ?from/?to", () => {
    const next = withPeriod(sp("fran=2026-11-01&till=2026-11-02&butik=s1"), { key: "igar" });
    expect(next.toString()).toBe("butik=s1&period=igar");
  });
});

describe("jämförelsetexter och namn för förvalen", () => {
  it.each([
    ["period=idag", "I dag", "mot i går"],
    ["period=7d", "7 dagar", "mot förra 7 dagarna"],
    ["period=30d", "30 dagar", "mot förra 30 dagarna"],
    ["period=manad", "Denna månad", "mot samma dagar förra månaden"],
    ["period=allt", "Allt", null],
  ])("%s", (q, name, cmp) => {
    const p = parsePeriod(sp(q), { now: NOW });
    expect(periodName(p)).toBe(name);
    expect(compareText(p)).toBe(cmp);
  });
});

describe("diagrammets upplösning", () => {
  it("en dag per timme, en månad per dag, ett halvår per vecka, längre per månad", () => {
    expect(chartUnitFor(1)).toBe("hour");
    expect(chartUnitFor(2)).toBe("day");
    expect(chartUnitFor(31)).toBe("day");
    expect(chartUnitFor(32)).toBe("week");
    expect(chartUnitFor(183)).toBe("week");
    expect(chartUnitFor(184)).toBe("month");
    expect(chartUnitFor(731)).toBe("month");
  });
});

describe("valet mellan sidor", () => {
  it("kakan sparar förval och eget intervall, men inte standardvalet", () => {
    expect(periodCookieValue({ key: "igar" })).toBe("period=igar");
    expect(periodCookieValue({ key: DEFAULT_PERIOD })).toBeNull();
    expect(
      periodCookieValue({ key: "eget", range: { start: d(2026, 11, 20), end: d(2026, 11, 14) } }),
    ).toBe("from=2026-11-14&to=2026-11-20");
  });
  it("kakan läses bara när den är giltig", () => {
    expect(periodFromCookie("period=igar")?.toString()).toBe("period=igar");
    expect(periodFromCookie("from=2026-11-20&to=2026-11-14")?.toString()).toBe(
      "from=2026-11-14&to=2026-11-20",
    );
    for (const bad of [
      undefined,
      "",
      "period=30d",
      "period=evil",
      "from=2026-11-20",
      "from=2020-01-01&to=2026-11-01",
      "x".repeat(200),
      "%%%",
    ]) {
      expect(periodFromCookie(bad), String(bad)).toBeNull();
    }
  });
  it("?fran=hem är ingen period (Fyll på), ?fran=<datum> är det", () => {
    expect(hasPeriodParam(sp("fran=hem"))).toBe(false);
    expect(periodQuery(sp("fran=hem"))).toBe("");
    expect(parsePeriod(sp("fran=hem"), { now: NOW }).key).toBe(DEFAULT_PERIOD);
    expect(carriedQuery(sp("fran=hem&butik=s1"))).toBe("?butik=s1");
    expect(carriedQuery(sp("fran=2026-11-14&till=2026-11-20&butik=s1"))).toBe(
      "?from=2026-11-14&to=2026-11-20&butik=s1",
    );
  });
  it("kakan följer adressen på en periodsida (länk med ?period=idag)", () => {
    expect(periodCookieFromUrl("/pengar", sp("period=idag"))).toBe("period=idag");
    expect(periodCookieFromUrl("/pengar", sp("from=2026-11-20&to=2026-11-14"))).toBe(
      "from=2026-11-14&to=2026-11-20",
    );
    expect(periodCookieFromUrl("/pengar", sp("period=30d"))).toBeNull();
    expect(periodCookieFromUrl("/pengar", sp("butik=s1"))).toBeUndefined();
    expect(periodCookieFromUrl("/fyll-pa", sp("fran=hem"))).toBeUndefined();
    expect(periodCookieFromUrl("/rapporter", sp("fran=2026-10-01&till=2026-10-15"))).toBe(
      undefined,
    );
  });
  it("länkar till periodsidor får valet, andra lämnas", () => {
    expect(withPeriodHref("/lonsamhet?vy=title", "?period=igar")).toBe(
      "/lonsamhet?vy=title&period=igar",
    );
    expect(withPeriodHref("/order", "?period=igar")).toBe("/order?period=igar");
    expect(withPeriodHref("/automater#rangordning", "?period=7d")).toBe(
      "/automater?period=7d#rangordning",
    );
    expect(withPeriodHref("/pengar?period=idag", "?period=igar")).toBe("/pengar?period=idag");
    expect(withPeriodHref("/fyll-pa/abc?fran=hem", "?period=igar")).toBe("/fyll-pa/abc?fran=hem");
    expect(withPeriodHref("/pengar", "")).toBe("/pengar");
  });
  it("periodQuery bär bara periodvalet, med appens namn", () => {
    expect(periodQuery(sp("period=igar&butik=s1&sort=x"))).toBe("?period=igar");
    expect(periodQuery(sp("fran=2026-11-14&till=2026-11-20"))).toBe(
      "?from=2026-11-14&to=2026-11-20",
    );
    expect(periodQuery(sp("butik=s1"))).toBe("");
    expect(hasPeriodParam(sp("till=2026-01-01"))).toBe(true);
    expect(hasPeriodParam(sp("butik=s1&period="))).toBe(false);
  });
});

describe("proxyns omdirigering", () => {
  it("?fran/?till skrivs aldrig om (Fyll på:s retur och Rapporters egna datum)", () => {
    expect(periodRedirect("/fyll-pa/abc", sp("fran=hem"), undefined)).toBeNull();
    expect(periodRedirect("/fyll-pa", sp("fran=automater&rutt=1"), "period=igar")).toBeNull();
    expect(
      periodRedirect(
        "/rapporter",
        sp("typ=butik&manad=2026-10&butiken=x&fran=2026-10-01&till=2026-10-15"),
        "period=igar",
      ),
    ).toBeNull();
    // På en periodsida är ?fran=<datum> ett val: ingen kaka läggs på.
    expect(
      periodRedirect("/pengar", sp("fran=2026-11-14&till=2026-11-20&butik=s1"), "period=igar"),
    ).toBeNull();
  });
  it("Next:s _rsc följer aldrig med i omdirigeringen", () => {
    expect(periodRedirect("/pengar", sp("_rsc=7pN0Py"), "period=igar")).toBe("/pengar?period=igar");
    expect(periodRedirect("/butiker", sp("sort=v&_rsc=abc"), "period=igar")).toBe(
      "/butiker?sort=v&period=igar",
    );
  });
  it("alla sidor med periodtal får valet, även /order och /ekonomi", () => {
    for (const path of ["/order", "/ekonomi", "/lager", "/automater/svinn", "/inkorg"]) {
      expect(periodRedirect(path, sp(""), "period=igar"), path).toBe(`${path}?period=igar`);
    }
  });
  it("en periodsida utan val får kakans val", () => {
    expect(periodRedirect("/pengar", sp(""), "period=igar")).toBe("/pengar?period=igar");
    expect(periodRedirect("/", sp("butik=s1"), "from=2026-11-14&to=2026-11-20")).toBe(
      "/?butik=s1&from=2026-11-14&to=2026-11-20",
    );
  });
  it("ingen omdirigering med eget val, på andra sidor eller med trasig kaka", () => {
    expect(periodRedirect("/pengar", sp("period=7d"), "period=igar")).toBeNull();
    expect(periodRedirect("/rutt", sp(""), "period=igar")).toBeNull();
    expect(periodRedirect("/automater/abc", sp(""), "period=igar")).toBeNull();
    expect(periodRedirect("/pengar", sp(""), "period=hack")).toBeNull();
    expect(periodRedirect("/pengar", sp(""), undefined)).toBeNull();
  });
});
