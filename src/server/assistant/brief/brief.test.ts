import { describe, expect, it } from "vitest";

import type { AnalyticsOrder } from "@/analytics/todos/types";
import type { EconomicsSources, IsoDate, Period, ProfitabilityInput } from "@/domain";
import { NBSP } from "@/lib/format";

import { BRIEF_MAX_CHARS, briefUserMessage, checkBrief } from "./check";
import { buildBriefFacts, fallbackLines, type BriefFactsInput } from "./facts";

const TODAY = "2026-11-03" as IsoDate; // tisdag; i går = måndag 2 nov.
const Y = "2026-11-02" as IsoDate;
const W = "2026-10-26" as IsoDate;

const SOURCES: EconomicsSources = {
  prices: [{ titleId: "A", unitCostOre: 5000, validFrom: "2026-01-01" }],
  agreements: [],
  placements: [],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
};

let seq = 0;
function order(machineId: string, date: IsoDate, amountOre: number): AnalyticsOrder {
  seq += 1;
  return {
    id: `o${seq}`,
    externalId: `x${seq}`,
    titleId: "A",
    machineId,
    businessDate: date,
    amountOre,
    orderedAt: `${date}T12:00:00Z`,
  };
}

function day(date: IsoDate, orders: AnalyticsOrder[]): ProfitabilityInput {
  const period: Period = { start: date, end: date };
  return { ...SOURCES, orders, period };
}

function input(overrides: Partial<BriefFactsInput> = {}): BriefFactsInput {
  return {
    today: TODAY,
    yesterday: day(Y, [order("M1", Y, 10000), order("M1", Y, 10000), order("M2", Y, 9000)]),
    weekBefore: day(W, [order("M1", W, 10000), order("M2", W, 10000)]),
    machines: [
      { id: "M1", name: "Sega gubben", code: "BL-001" },
      { id: "M2", name: "Ica Nära", code: "BL-002" },
    ],
    todos: [
      { title: "Fyll på Surging Sparks i BL-002 (2 pack kvar)", level: "now" },
      { title: "Lägg in inköpspris för Prismatic", level: "soon" },
    ],
    ...overrides,
  };
}

describe("buildBriefFacts", () => {
  it("räknar gårdagen mot samma veckodag veckan före, med bästa automaten", () => {
    const f = buildBriefFacts(input());
    expect(f.datum).toBe(Y);
    expect(f.veckodag).toBe("måndag");
    expect(f.igar.intakt).toBe(`290${NBSP}kr`);
    expect(f.igar.vinst).toBe(`140${NBSP}kr`);
    expect(f.igar.kop).toBe(3);
    // 290 mot 200 kr = +45 %
    expect(f.igar.motForraVeckan).toBe(`+45${NBSP}%`);
    expect(f.igar.bastaAutomat).toEqual({ namn: "BL-001 Sega gubben", intakt: `200${NBSP}kr` });
    expect(f.fel).toEqual(["Fyll på Surging Sparks i BL-002 (2 pack kvar)"]);
    expect(f.gorIdag).toHaveLength(2);
    expect(f.attGora).toEqual({ totalt: 2, nu: 1 });
  });

  it("utan försäljning veckan före: ingen jämförelse", () => {
    const f = buildBriefFacts(input({ weekBefore: day(W, []) }));
    expect(f.igar.motForraVeckan).toBeNull();
  });

  it("utan försäljning i går och utan punkter: fasta rader utan tal", () => {
    const f = buildBriefFacts(input({ yesterday: day(Y, []), todos: [] }));
    expect(f.igar.kop).toBe(0);
    expect(f.igar.bastaAutomat).toBeNull();
    expect(fallbackLines(f)).toEqual({
      yesterday: "Ingen försäljning i går.",
      problem: "Inget akut.",
      today: "Inget att göra.",
    });
  });
});

describe("fallbackLines", () => {
  it("bygger tre korta rader ur underlaget", () => {
    const lines = fallbackLines(buildBriefFacts(input()));
    expect(lines.yesterday).toBe(
      `290${NBSP}kr på 3 köp, 140${NBSP}kr i vinst (+45${NBSP}% mot förra måndag).`,
    );
    expect(lines.problem).toBe("Fyll på Surging Sparks i BL-002 (2 pack kvar).");
    expect(lines.today).toBe("Fyll på Surging Sparks i BL-002 (2 pack kvar).");
  });
});

describe("checkBrief", () => {
  const facts = buildBriefFacts(input());

  it("godtar rader med tal ur underlaget", () => {
    const r = checkBrief(
      {
        igar: "290 kr på 3 köp, +45 % mot förra måndagen.",
        fel: "BL-002 har bara 2 pack Surging Sparks kvar.",
        gor_idag: "Fyll på Surging Sparks i BL-002.",
      },
      facts,
    );
    expect(r.rejected).toEqual([]);
    expect(r.lines.yesterday).toBe("290 kr på 3 köp, +45 % mot förra måndagen.");
  });

  it("byter en rad med påhittat tal mot den fasta raden", () => {
    const r = checkBrief(
      {
        igar: "Rekorddag med 1 200 kr.",
        fel: "Inget akut.",
        gor_idag: "Fyll på BL-002.",
      },
      facts,
    );
    expect(r.rejected).toEqual([{ line: "yesterday", reason: "tal utanför underlaget: 1 200" }]);
    expect(r.lines.yesterday).toBe(fallbackLines(facts).yesterday);
    expect(r.lines.problem).toBe("Inget akut.");
  });

  it("byter för långa rader och rader med rubrik", () => {
    const r = checkBrief(
      { igar: "x".repeat(BRIEF_MAX_CHARS + 1), fel: "Fel: inget", gor_idag: "" },
      facts,
    );
    expect(r.rejected.map((x) => x.reason)).toEqual(["för lång", "fel form", "tom"]);
    expect(r.lines).toEqual(fallbackLines(facts));
  });

  it("byter rader med radbrytning, men behåller hårda mellanslag", () => {
    const r = checkBrief(
      { igar: `290${NBSP}kr på 3 köp.`, fel: "Rad ett\nRad två", gor_idag: "Fyll på BL-002." },
      facts,
    );
    expect(r.lines.yesterday).toBe(`290${NBSP}kr på 3 köp.`);
    expect(r.rejected).toEqual([{ line: "problem", reason: "fel form" }]);
  });

  it("fel format: tre fasta rader", () => {
    const r = checkBrief({ rader: [] }, facts);
    expect(r.lines).toEqual(fallbackLines(facts));
    expect(r.rejected).toHaveLength(3);
  });

  it("underlaget skickas inom <underlag>", () => {
    expect(briefUserMessage(facts)).toContain("<underlag>");
    expect(briefUserMessage(facts)).toContain('"veckodag":"måndag"');
  });
});
