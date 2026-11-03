import { describe, expect, it } from "vitest";

import { ADVISOR_TOOL, checkSuggestions, revenueSek } from "./grounding";
import { budgetFrom, costOre, dayStart, monthStart } from "./pricing";

const SNAPSHOT = {
  nyckeltal: { d30: { intakt: "69 094 kr", vinst: "20 254 kr", marginal: "29,3 %" } },
  lager: {
    riskUnderSjuDagar: [
      {
        automat: "Automat 03 (NA-03)",
        titel: "Surging Sparks",
        iLager: 1,
        saltPerDag: "1,6",
        dagarKvar: 0,
      },
    ],
  },
  butiker: [{ butik: "Kortkammaren", butiksandel: "14,1 %" }],
};

const ok = {
  titel: "Fyll på Surging Sparks",
  varfor: "Automat 03 (NA-03) har 1 pack kvar och säljer 1,6 pack per dag.",
  atgard: "Fyll på Surging Sparks i NA-03 i dag.",
  effekt_kr_per_manad: 1500,
  sakerhet: "hog",
};

const check = (forslag: unknown[]) =>
  checkSuggestions({ forslag }, SNAPSHOT, { maxEffectSek: revenueSek("69 094 kr") });

describe("checkSuggestions (grounding)", () => {
  it("godtar ett förslag vars tal finns i underlaget", () => {
    const r = check([ok]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual([
      {
        rank: 1,
        title: "Fyll på Surging Sparks",
        why: ok.varfor,
        action: ok.atgard,
        effectSekMonth: 1500,
        confidence: "high",
      },
    ]);
  });

  it("kastar förslag med tal som inte finns i underlaget", () => {
    const r = check([
      { ...ok, varfor: "Automat 03 har 12 pack kvar och säljer 2,5 pack per dag." },
    ]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.reason).toMatch(/tal utanför underlaget: 12, 2,5/);
  });

  it("kastar en uträknad skillnad och en avrundning", () => {
    const diff = check([{ ...ok, varfor: "Kortkammaren tar 11,7 procentenheter mer än snittet." }]);
    expect(diff.accepted).toEqual([]);
    const rounded = check([{ ...ok, varfor: "Intäkten var ca 69 000 kr senaste 30 dagarna." }]);
    expect(rounded.accepted).toEqual([]);
  });

  it("tecknet räknas: en vinst skriven som förlust kastas", () => {
    const r = check([{ ...ok, varfor: "Vinsten var −20 254 kr de senaste 30 dagarna." }]);
    expect(r.accepted).toEqual([]);
  });

  it("kräver minst ett tal i motiveringen", () => {
    const r = check([{ ...ok, varfor: "Den säljer bra.", atgard: "Fyll på." }]);
    expect(r.rejected[0]!.reason).toBe("motiveringen saknar tal");
  });

  it("rubrik högst 8 ord, effekt heltal ≥ 0 och högst månadens vinst", () => {
    expect(
      check([{ ...ok, titel: "ett två tre fyra fem sex sju åtta nio" }]).rejected[0]!.reason,
    ).toMatch(/8 ord/);
    expect(check([{ ...ok, effekt_kr_per_manad: -5 }]).rejected[0]!.reason).toMatch(/heltal/);
    expect(check([{ ...ok, effekt_kr_per_manad: 12.5 }]).rejected[0]!.reason).toMatch(/heltal/);
    expect(check([{ ...ok, effekt_kr_per_manad: 70_000 }]).rejected[0]!.reason).toMatch(/vinst/);
  });

  it("högst fem förslag, dubbletter och fel format kastas, rangordning 1–n", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...ok,
      titel: `Förslag nummer ${["ett", "två", "tre", "fyra", "fem", "sex", "sju"][i]}`,
    }));
    const r = check([
      ...many.slice(0, 2),
      { ...ok, titel: many[0]!.titel },
      { nonsens: true },
      ...many.slice(2),
    ]);
    expect(r.accepted.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "dubblett",
      "fel format",
      "fler än fem",
      "fler än fem",
    ]);
  });

  it("fel format på hela svaret", () => {
    expect(checkSuggestions("hej", SNAPSHOT, { maxEffectSek: 1 }).rejected).toEqual([
      { title: "(svaret)", reason: "fel format" },
    ]);
  });

  it("verktygets schema är strikt och kräver alla fält", () => {
    expect(ADVISOR_TOOL.strict).toBe(true);
    const item = ADVISOR_TOOL.input_schema.properties.forslag.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["titel", "varfor", "atgard", "effekt_kr_per_manad", "sakerhet"]);
  });
});

describe("pricing", () => {
  it("kostnad per modell i öre, uppåt avrundad; okänd modell räknas dyrast", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(costOre("claude-sonnet-5-5", usage, 11)).toBe(2200); // 2 USD * 11 = 22 kr
    expect(costOre("claude-opus-5-5", usage, 11)).toBe(4400);
    expect(costOre("okand", usage, 11)).toBe(11_000);
    expect(
      costOre(
        "claude-sonnet-5-5",
        { inputTokens: 6, outputTokens: 468, cacheReadTokens: 5499, cacheWriteTokens: 0 },
        11,
      ),
    ).toBe(7);
  });

  it("tak och växelkurs ur miljön, standard 300 kr och 11", () => {
    expect(budgetFrom({})).toEqual({ budgetOre: 30_000, usdSek: 11 });
    expect(budgetFrom({ AI_MONTHLY_BUDGET_SEK: "50", AI_USD_SEK: "10,5" })).toEqual({
      budgetOre: 5000,
      usdSek: 10.5,
    });
    expect(budgetFrom({ AI_MONTHLY_BUDGET_SEK: "-1" }).budgetOre).toBe(30_000);
  });

  it("månadens och dagens början i svensk tid", () => {
    expect(monthStart(new Date("2026-11-03T08:00:00Z")).toISOString()).toBe(
      "2026-10-31T23:00:00.000Z",
    );
    expect(monthStart(new Date("2026-10-31T23:30:00Z")).toISOString()).toBe(
      "2026-10-31T23:00:00.000Z",
    );
    expect(monthStart(new Date("2026-07-15T12:00:00Z")).toISOString()).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    expect(dayStart(new Date("2026-11-03T08:00:00Z")).toISOString()).toBe(
      "2026-11-02T23:00:00.000Z",
    );
  });
});
