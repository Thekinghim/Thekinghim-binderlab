import { describe, expect, it } from "vitest";

import { paceTone, periodIncludesToday, todayPace, type TodayPaceInput } from "./pace";

const TZ = "Europe/Stockholm";

/** Order med brutto 125 kr (netto 100 kr vid 25 % moms) om inget annat anges. */
function o(businessDate: string, orderedAt: string | undefined, grossOre = 12_500) {
  return { businessDate, orderedAt, amountOre: grossOre };
}

function input(p: Partial<TodayPaceInput>): TodayPaceInput {
  return {
    orders: [],
    // Tisdag 3 nov 2026, kl. 14:20 svensk vintertid (+01:00).
    today: "2026-11-03",
    cutoffMs: Date.parse("2026-11-03T13:20:00Z"),
    timeZone: TZ,
    vatRateBp: 2_500,
    dataStart: "2026-01-01",
    ...p,
  };
}

// Tre tisdagar bakåt: 27 okt (CET), 20 okt och 13 okt (CEST, +02:00).
const BASE = [
  // 27 okt: 1 order före 14:20, 1 efter.
  o("2026-10-27", "2026-10-27T09:00:00Z"),
  o("2026-10-27", "2026-10-27T17:00:00Z"),
  // 20 okt: 2 före (10:00 och 14:10 lokal tid), 1 efter (14:30 lokal tid).
  o("2026-10-20", "2026-10-20T08:00:00Z"),
  o("2026-10-20", "2026-10-20T12:10:00Z"),
  o("2026-10-20", "2026-10-20T12:30:00Z"),
  // 13 okt: 3 före.
  o("2026-10-13", "2026-10-13T06:00:00Z"),
  o("2026-10-13", "2026-10-13T07:00:00Z"),
  o("2026-10-13", "2026-10-13T11:00:00Z"),
];

describe("todayPace", () => {
  it("jämför med samma klockslag samma veckodag och räknar prognos", () => {
    const orders = [
      ...BASE,
      // I dag: 3 order före 14:20 och en efter (ännu inte synkad tid räknas inte).
      o("2026-11-03", "2026-11-03T07:00:00Z"),
      o("2026-11-03", "2026-11-03T10:00:00Z"),
      o("2026-11-03", "2026-11-03T13:15:00Z"),
      o("2026-11-03", "2026-11-03T13:40:00Z"),
    ];
    const r = todayPace(input({ orders }))!;
    expect(r).not.toBeNull();
    expect(r.clock).toBe("14:20");
    expect(r.weekday).toBe(2);
    expect(r.comparisonDays).toBe(3);
    expect(r.soFarOre).toBe(30_000);
    // Hittills: 1 + 2 + 3 = 6 order à 100 kr över 3 dagar = 200 kr.
    expect(r.baselineSoFarOre).toBe(20_000);
    expect(r.deltaBp).toBe(5_000);
    expect(r.tone).toBe("up");
    // Hela dagar: 2 + 3 + 3 = 8 order = 800 kr; prognos 300 × 800 / 600 = 400 kr.
    expect(r.projectionOre).toBe(40_000);
    expect(r.baselineFullOre).toBe(26_667);
    // Timserien för i dag går t.o.m. timme 14 (08:00, 11:00 och 14:15 lokal tid).
    expect(r.todayHourly).toHaveLength(15);
    expect(r.todayHourly[7]).toBe(0);
    expect(r.todayHourly[8]).toBe(10_000);
    expect(r.todayHourly[11]).toBe(20_000);
    expect(r.todayHourly[14]).toBe(30_000);
    expect(r.baselineHourly).toHaveLength(24);
    expect(r.baselineHourly[23]).toBe(r.baselineFullOre);
  });

  it("visar inget när färre än tre jämförelsedagar sålt före klockslaget", () => {
    // Kl. 08:30 lokal tid: bara 13 okt (08:00 lokal tid) hade sålt → inget brusigt −100 %.
    const early = Date.parse("2026-11-03T07:30:00Z");
    expect(todayPace(input({ orders: BASE, cutoffMs: early }))).toBeNull();
  });

  it("tar inte med dagar utan order eller före första datan", () => {
    const orders = [...BASE, o("2026-11-03", "2026-11-03T07:00:00Z")];
    // 6 okt, 29 sep … har inga order: snittet är fortfarande över tre dagar.
    expect(todayPace(input({ orders }))!.comparisonDays).toBe(3);
    // Data först från 14 okt: bara två dagar kvar → null.
    expect(todayPace(input({ orders, dataStart: "2026-10-14" }))).toBeNull();
  });

  it("ger null med färre än tre jämförelsedagar", () => {
    const orders = BASE.filter((x) => x.businessDate !== "2026-10-13");
    expect(todayPace(input({ orders }))).toBeNull();
  });

  it("ger null när jämförelsedagarna inte sålt något vid klockslaget", () => {
    const orders = [
      o("2026-10-27", "2026-10-27T17:00:00Z"),
      o("2026-10-20", "2026-10-20T17:00:00Z"),
      o("2026-10-13", "2026-10-13T17:00:00Z"),
    ];
    expect(todayPace(input({ orders }))).toBeNull();
  });

  it("ger null när senaste synken var före i dag", () => {
    const r = todayPace(input({ orders: BASE, cutoffMs: Date.parse("2026-11-02T20:00:00Z") }));
    expect(r).toBeNull();
  });

  it("räknar order utan betaltid i hela dagen men inte i hittills", () => {
    const orders = [
      ...BASE,
      o("2026-10-27", undefined),
      o("2026-10-20", "inte en tid"),
      o("2026-11-03", undefined),
      o("2026-11-03", "2026-11-03T07:00:00Z"),
    ];
    const r = todayPace(input({ orders }))!;
    expect(r.soFarOre).toBe(10_000);
    expect(r.baselineSoFarOre).toBe(20_000);
    expect(r.baselineFullOre).toBe(33_333);
    expect(r.deltaBp).toBe(-5_000);
    expect(r.tone).toBe("down");
    // 100 × 1000 / 600 = 166,67 kr.
    expect(r.projectionOre).toBe(16_667);
  });

  it("jämför väggtid över höstens sommartidsskifte (vintertid i dag)", () => {
    // Söndag 1 nov 14:20 CET = 13:20Z. 25 okt är skiftesdagen, 18 och 11 okt är CEST.
    const orders = [
      o("2026-10-25", "2026-10-25T13:10:00Z"), // 14:10 CET: med
      o("2026-10-18", "2026-10-18T12:15:00Z"), // 14:15 CEST: med
      o("2026-10-18", "2026-10-18T12:25:00Z"), // 14:25 CEST: inte med (fast 12:25Z < 13:20Z)
      o("2026-10-11", "2026-10-11T12:00:00Z"), // 14:00 CEST: med
      o("2026-11-01", "2026-11-01T12:00:00Z"),
    ];
    const r = todayPace(
      input({ orders, today: "2026-11-01", cutoffMs: Date.parse("2026-11-01T13:20:00Z") }),
    )!;
    expect(r.clock).toBe("14:20");
    expect(r.weekday).toBe(7);
    expect(r.baselineSoFarOre).toBe(10_000);
    expect(r.baselineFullOre).toBe(13_333);
  });

  it("jämför väggtid över vårens sommartidsskifte (sommartid i dag)", () => {
    // Söndag 29 mars 14:20 CEST = 12:20Z. 22, 15 och 8 mars är CET.
    const orders = [
      o("2026-03-22", "2026-03-22T13:10:00Z"), // 14:10 CET: med (fast 13:10Z > 12:20Z)
      o("2026-03-22", "2026-03-22T13:30:00Z"), // 14:30 CET: inte med
      o("2026-03-15", "2026-03-15T12:00:00Z"), // 13:00 CET: med
      o("2026-03-08", "2026-03-08T13:20:00Z"), // 14:20 CET: med (samma minut)
      o("2026-03-29", "2026-03-29T12:00:00Z"), // 14:00 CEST
      o("2026-03-29", "2026-03-29T12:30:00Z"), // 14:30 CEST: efter klockslaget
    ];
    const r = todayPace(
      input({ orders, today: "2026-03-29", cutoffMs: Date.parse("2026-03-29T12:20:00Z") }),
    )!;
    expect(r.clock).toBe("14:20");
    expect(r.soFarOre).toBe(10_000);
    expect(r.baselineSoFarOre).toBe(10_000);
    expect(r.deltaBp).toBe(0);
    expect(r.tone).toBe("neutral");
    expect(r.todayHourly).toHaveLength(15);
  });

  it("är ren: samma indata ger samma svar oavsett filter och ordning", () => {
    const orders = [...BASE, o("2026-11-03", "2026-11-03T07:00:00Z")];
    const a = todayPace(input({ orders }));
    const b = todayPace(input({ orders: [...orders].reverse() }));
    expect(b).toEqual(a);
    // Order på andra veckodagar påverkar inte.
    const c = todayPace(input({ orders: [...orders, o("2026-11-02", "2026-11-02T08:00:00Z")] }));
    expect(c).toEqual(a);
  });
});

describe("paceTone och periodIncludesToday", () => {
  it("gränserna +5 % och −15 %", () => {
    expect(paceTone(500)).toBe("up");
    expect(paceTone(499)).toBe("neutral");
    expect(paceTone(-1_499)).toBe("neutral");
    expect(paceTone(-1_500)).toBe("down");
  });
  it("perioden innehåller i dag", () => {
    expect(periodIncludesToday({ start: "2026-11-01", end: "2026-11-30" }, "2026-11-03")).toBe(
      true,
    );
    expect(periodIncludesToday({ start: "2026-10-01", end: "2026-10-31" }, "2026-11-03")).toBe(
      false,
    );
  });
});
