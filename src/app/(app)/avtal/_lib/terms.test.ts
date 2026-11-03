import { describe, expect, it } from "vitest";

import { profitability } from "@/domain";
import { agreement, NO_TAX, order, placement, price } from "@/domain/testing/fixtures";
import type { ProfitabilityInput } from "@/domain";

import { checkTerms, DEFAULT_TERMS, guideTerms, presetDraft, termsPayload } from "./terms";

const NB = " ";

describe("snabbvalen", () => {
  it("50/50 vinst är förvalt: 50 % av vinsten efter kostnader, förlust ger 0", () => {
    expect(DEFAULT_TERMS).toMatchObject({
      preset: "split",
      share: "50",
      base: "profit_after_costs",
      rent: "",
      loss: "zero",
      vmb: false,
    });
    const c = checkTerms(DEFAULT_TERMS);
    expect(c.ok && c.plain.replace(/\s/g, " ")).toBe("50 % av vinsten efter kostnader");
  });

  it("Fast hyra och Procent av omsättning kräver sitt belopp", () => {
    expect(checkTerms(presetDraft("rent"))).toMatchObject({ ok: false, field: "rent" });
    expect(checkTerms(presetDraft("sales"))).toMatchObject({ ok: false, field: "share" });
    const rent = checkTerms({ ...presetDraft("rent"), rent: "1 500" });
    expect(rent.ok && rent.terms).toMatchObject({ shareBp: null, monthlyRentOre: 150_000 });
    expect(rent.ok && rent.plain).toBe(`Fast hyra 1${NB}500${NB}kr/mån`);
    const sales = checkTerms({ ...presetDraft("sales"), share: "12,5" });
    expect(sales.ok && sales.terms).toMatchObject({ shareBp: 1_250, base: "net_excl_vat" });
    expect(sales.ok && sales.plain.replace(/\s/g, " ")).toBe("12,5 % av omsättningen exkl. moms");
  });

  it("särskilda villkor behålls vid byte av snabbval och skickas med", () => {
    const d = { ...DEFAULT_TERMS, special: "Automaten står vid kassan." };
    const next = presetDraft("rent", d);
    expect(next.special).toBe("Automaten står vid kassan.");
    expect(termsPayload({ ...next, rent: "900" })).toEqual({
      share: "",
      base: "net_excl_vat",
      rent: "900",
      loss: "zero",
      vmbBeforeSplit: false,
      specialTerms: "Automaten står vid kassan.",
    });
    const c = checkTerms({ ...next, rent: "900" });
    expect(c.ok && c.specialTerms).toBe("Automaten står vid kassan.");
  });

  it("andel och hyra tillsammans, delad förlust och VMB i klartexten", () => {
    const c = checkTerms({
      ...DEFAULT_TERMS,
      share: "40",
      rent: "500",
      loss: "proportional",
      vmb: true,
    });
    expect(c.ok && c.terms).toEqual({
      shareBp: 4_000,
      base: "profit_after_costs",
      lossTreatment: "proportional",
      vmbBeforeSplit: true,
      monthlyRentOre: 50_000,
    });
    expect(c.ok && c.plain.replace(/\s/g, " ")).toBe(
      "40 % av vinsten efter kostnader + 500 kr/mån (delar förlust, VMB dras först)",
    );
  });

  it("felaktiga värden ger svensk text på rätt fält", () => {
    expect(checkTerms({ ...DEFAULT_TERMS, share: "120" })).toMatchObject({
      ok: false,
      field: "share",
    });
    expect(checkTerms({ ...DEFAULT_TERMS, preset: null, share: "", rent: "" })).toMatchObject({
      ok: false,
      message: "Ange andel, hyra eller båda.",
    });
    expect(checkTerms({ ...DEFAULT_TERMS, special: "x".repeat(2001) })).toMatchObject({
      ok: false,
      field: "special",
    });
  });

  it("guidens första sparning: andel → vinst/omsättning, annars hyra", () => {
    expect(guideTerms(DEFAULT_TERMS)).toEqual({ preset: "split", share: "50", rent: "" });
    expect(guideTerms({ ...presetDraft("sales"), share: "10" })).toEqual({
      preset: "sales",
      share: "10",
      rent: "",
    });
    expect(guideTerms({ ...presetDraft("rent"), rent: "1500" })).toEqual({
      preset: "rent",
      share: "",
      rent: "1500",
    });
  });
});

describe("andelen räknas rätt för varje modell (domänen)", () => {
  // November: 64 700 kr sålt, 42 500 kr inköp, inga avgifter.
  function input(terms: ReturnType<typeof checkTerms>): ProfitabilityInput {
    if (!terms.ok) throw new Error(terms.message);
    const t = terms.terms;
    return {
      orders: [
        order({ id: "a", businessDate: "2026-11-02", amountOre: 19_900, titleId: "t-a" }),
        order({ id: "b", businessDate: "2026-11-03", amountOre: 19_900, titleId: "t-a" }),
        order({ id: "c", businessDate: "2026-11-20", amountOre: 24_900, titleId: "t-b" }),
      ],
      prices: [price("t-a", 13_000, "2026-01-01"), price("t-b", 16_500, "2026-01-01")],
      agreements: [
        agreement("s-1", "2026-01-01", null, {
          commissionBp: t.shareBp,
          commissionBase: t.base,
          lossTreatment: t.lossTreatment,
          vmbBeforeSplit: t.vmbBeforeSplit,
          monthlyRentOre: t.monthlyRentOre,
        }),
      ],
      placements: [placement("m-1", "s-1", "2026-01-01", null)],
      settings: NO_TAX,
      period: { start: "2026-11-01", end: "2026-11-30" },
    };
  }
  const totals = (d: Parameters<typeof checkTerms>[0]) =>
    profitability(input(checkTerms(d)), "store").totals;

  it("50/50 vinst: hälften av (försäljning − inköp)", () => {
    expect(totals(DEFAULT_TERMS)).toMatchObject({ commissionOre: 11_100, rentOre: 0 });
  });

  it("procent av omsättning: 10 % av försäljningen exkl. moms", () => {
    expect(totals({ ...presetDraft("sales"), share: "10" })).toMatchObject({
      commissionOre: 6_470,
      rentOre: 0,
    });
  });

  it("fast hyra: hela månadens hyra, ingen andel", () => {
    expect(totals({ ...presetDraft("rent"), rent: "1500" })).toMatchObject({
      commissionOre: 0,
      rentOre: 150_000,
    });
  });

  it("andel och hyra: båda", () => {
    expect(totals({ ...DEFAULT_TERMS, rent: "500" })).toMatchObject({
      commissionOre: 11_100,
      rentOre: 50_000,
    });
  });
});
