import { describe, expect, it } from "vitest";
import type { OrderLine, Placement, PurchasePrice, Settings, StoreAgreement } from "@/domain";
import {
  accrueFixedCosts,
  FIXED_UNALLOCATED_KEY,
  fixedCostOccurrences,
  profitabilityWithFixedCosts,
} from "./fixed-costs";
import type { FixedCost, FixedCostAllocationInput } from "./types";

const norm = (s: string) => s.replace(/ /g, " ").replace(/−/g, "-");

function cost(partial: Partial<FixedCost> & Pick<FixedCost, "id">): FixedCost {
  return {
    name: partial.id,
    amountOre: 100_000,
    interval: "month",
    start: "2026-01-01",
    end: null,
    ...partial,
  };
}

describe("fixedCostOccurrences", () => {
  it("månadsvis från 31 jan.: dagen kapas men glider inte (31 jan., 28 feb., 31 mars, 30 apr.)", () => {
    const occ = fixedCostOccurrences(cost({ id: "c", start: "2026-01-31" }), "2026-04-30");
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(occ[0]!.coverage).toEqual({ start: "2026-01-31", end: "2026-02-27" });
    expect(occ[1]!.coverage).toEqual({ start: "2026-02-28", end: "2026-03-30" });
  });

  it("kvartal och år", () => {
    expect(
      fixedCostOccurrences(
        cost({ id: "q", interval: "quarter", start: "2026-02-15" }),
        "2026-12-31",
      ).map((o) => o.date),
    ).toEqual(["2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15"]);
    expect(
      fixedCostOccurrences(
        cost({ id: "y", interval: "year", start: "2024-02-29" }),
        "2027-03-01",
      ).map((o) => o.date),
    ).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28"]);
  });

  it("slutdatum: sista betalningen ≤ slut och dess dagar kortas till slutet", () => {
    const occ = fixedCostOccurrences(
      cost({ id: "c", start: "2026-01-15", end: "2026-03-20" }),
      "2026-12-31",
    );
    expect(occ.map((o) => o.date)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
    expect(occ[2]!.coverage).toEqual({ start: "2026-03-15", end: "2026-03-20" });
  });

  it("ogiltiga kostnader", () => {
    expect(() =>
      fixedCostOccurrences(cost({ id: "c", start: "2026-05-01", end: "2026-04-01" }), "2026-12-31"),
    ).toThrow(/slutar/);
    expect(() =>
      fixedCostOccurrences(
        cost({ id: "c", interval: "week" as unknown as FixedCost["interval"] }),
        "2026-12-31",
      ),
    ).toThrow(/month, quarter eller year/);
    expect(() => fixedCostOccurrences(cost({ id: "c", amountOre: 10.5 }), "2026-12-31")).toThrow(
      /heltal/,
    );
  });
});

describe("accrueFixedCosts", () => {
  it("kvartalskostnad 3 000 kr från 1 okt.: november = round(300 000 × 30 / 92) = 97 826 öre", () => {
    const a = accrueFixedCosts(
      [cost({ id: "q", amountOre: 300_000, interval: "quarter", start: "2026-10-01" })],
      { start: "2026-11-01", end: "2026-11-30" },
    );
    expect(a.totalOre).toBe(97_826);
    expect(a.sharedOre).toBe(97_826);
    expect(a.byCost[0]!.occurrences.map((o) => o.date)).toEqual(["2026-10-01"]);
    expect(a.evidence.fixedCostIds).toEqual(["q"]);
  });

  it("månadskostnad över ett helt år = 12 × beloppet", () => {
    const a = accrueFixedCosts([cost({ id: "m" })], { start: "2026-01-01", end: "2026-12-31" });
    expect(a.totalOre).toBe(1_200_000);
  });

  it("årskostnad som slutar 30 juni periodiseras på 181 dagar: januari = 205 525 öre", () => {
    const c = cost({ id: "y", amountOre: 1_200_000, interval: "year", end: "2026-06-30" });
    expect(accrueFixedCosts([c], { start: "2026-01-01", end: "2026-01-31" }).totalOre).toBe(
      205_525,
    );
    // Hela betalningen hamnar inom första halvåret.
    expect(accrueFixedCosts([c], { start: "2026-01-01", end: "2026-12-31" }).totalOre).toBe(
      1_200_000,
    );
  });

  it("kostnader före start eller efter slut ger 0 och tas inte med", () => {
    const a = accrueFixedCosts(
      [cost({ id: "late", start: "2027-01-01" }), cost({ id: "ended", end: "2026-03-31" })],
      { start: "2026-11-01", end: "2026-11-30" },
    );
    expect(a.totalOre).toBe(0);
    expect(a.byCost).toEqual([]);
  });

  it("delar upp gemensamma och automatens egna kostnader; dubbletter avvisas", () => {
    const a = accrueFixedCosts(
      [cost({ id: "a" }), cost({ id: "b", amountOre: 50_000, machineId: "m2" })],
      { start: "2026-11-01", end: "2026-11-30" },
    );
    expect([a.sharedOre, a.directOre, a.totalOre]).toEqual([100_000, 50_000, 150_000]);
    expect(() =>
      accrueFixedCosts([cost({ id: "a" }), cost({ id: "a" })], {
        start: "2026-11-01",
        end: "2026-11-30",
      }),
    ).toThrow(/två gånger/);
  });
});

describe("profitabilityWithFixedCosts", () => {
  const settings: Settings = { vatRateBp: 0, cardFeeBp: 0 };
  const prices: PurchasePrice[] = [{ titleId: "t1", unitCostOre: 2000, validFrom: "2026-01-01" }];
  const agreements: StoreAgreement[] = [
    {
      storeId: "s1",
      validFrom: "2026-01-01",
      validTo: null,
      commissionBp: 1000,
      monthlyRentOre: null,
    },
  ];
  const placements: Placement[] = [
    { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
    { machineId: "m2", storeId: "s1", from: "2026-01-01", to: null },
  ];
  const o = (id: string, machineId: string | null, date: string): OrderLine => ({
    id,
    externalId: id,
    titleId: "t1",
    machineId,
    businessDate: date,
    amountOre: 4900,
  });
  const orders = [
    o("a", "m1", "2026-11-02"),
    o("b", "m1", "2026-11-03"),
    o("c", "m1", "2026-11-04"),
    o("d", "m2", "2026-11-05"),
  ];
  const base: FixedCostAllocationInput = {
    orders,
    prices,
    agreements,
    placements,
    settings,
    period: { start: "2026-11-01", end: "2026-11-30" },
    fixedCosts: [cost({ id: "rent-storage", name: "Lagerhyra" })],
    machines: [
      { id: "m1", name: "Automat 1" },
      { id: "m2", name: "Automat 2" },
    ],
  };
  // Vinst m1 = 14 700 − 6 000 − 1 470 = 7 230; m2 = 4 900 − 2 000 − 490 = 2 410; totalt 9 640.

  it("efter intäkt: 14 700 : 4 900 = 3 : 1 → 75 000 och 25 000 öre", () => {
    const r = profitabilityWithFixedCosts(base, "revenue");
    expect(r.rows.map((x) => [x.key, x.profitOre, x.fixedCostOre, x.profitAfterFixedOre])).toEqual([
      ["m1", 7230, 75_000, -67_770],
      ["m2", 2410, 25_000, -22_590],
    ]);
    expect(r.rows[0]!.shareBp).toBe(7500);
    expect(r.totals).toEqual({
      revenueOre: 19_600,
      profitOre: 9640,
      fixedCostOre: 100_000,
      profitAfterFixedOre: -90_360,
      marginAfterFixedBp: -46_102,
    });
    expect(norm(r.summary)).toContain("Fasta kostnader 1 000 kr 1–30 nov. (1 st)");
    expect(norm(r.summary)).toContain("Automat 1 bär 750 kr (75 %)");
    expect(norm(r.summary)).toContain(
      "Går med förlust efter fasta kostnader: Automat 1 (-678 kr), Automat 2 (-226 kr)",
    );
  });

  it("lika: 50 000 var; automat utan försäljning men placerad får också sin del", () => {
    const r = profitabilityWithFixedCosts(
      {
        ...base,
        placements: [
          ...placements,
          { machineId: "m3", storeId: "s1", from: "2026-11-20", to: null },
        ],
      },
      "equal",
    );
    expect(r.rows.map((x) => [x.key, x.fixedCostOre])).toEqual([
      ["m1", 33_334],
      ["m2", 33_333],
      ["m3", 33_333],
    ]);
    const rev = profitabilityWithFixedCosts(
      {
        ...base,
        placements: [
          ...placements,
          { machineId: "m3", storeId: "s1", from: "2026-11-20", to: null },
        ],
      },
      "revenue",
    );
    expect(rev.rows.find((x) => x.key === "m3")!.fixedCostOre).toBe(0);
  });

  it("kostnad för en viss automat bärs av den", () => {
    const r = profitabilityWithFixedCosts(
      {
        ...base,
        fixedCosts: [...base.fixedCosts, cost({ id: "ins", amountOre: 50_000, machineId: "m2" })],
      },
      "equal",
    );
    const m2 = r.rows.find((x) => x.key === "m2")!;
    expect([m2.sharedFixedOre, m2.directFixedOre, m2.fixedCostOre]).toEqual([
      50_000, 50_000, 100_000,
    ]);
    expect(m2.evidence.fixedCostIds).toEqual(["ins", "rent-storage"]);
  });

  it("order utan automat och ej fördelad hyra följer med; raderna summerar till totalen", () => {
    const r = profitabilityWithFixedCosts(
      {
        ...base,
        orders: [...orders, o("e", null, "2026-11-06")],
        agreements: [{ ...agreements[0]!, monthlyRentOre: 30_000 }],
      },
      "revenue",
    );
    expect(r.rows.map((x) => x.kind)).toContain("no-machine");
    const sum = r.rows.reduce((s, x) => s + x.profitAfterFixedOre, 0);
    expect(sum).toBe(r.totals.profitAfterFixedOre);
    expect(r.rows.reduce((s, x) => s + x.fixedCostOre, 0)).toBe(100_000);
  });

  it("ingen automat: de gemensamma kostnaderna hamnar på en egen rad", () => {
    const r = profitabilityWithFixedCosts({ ...base, orders: [], placements: [] }, "revenue");
    expect(r.rows.map((x) => [x.key, x.profitAfterFixedOre])).toEqual([
      [FIXED_UNALLOCATED_KEY, -100_000],
    ]);
    expect(r.totals.profitAfterFixedOre).toBe(-100_000);
  });

  it("inga fasta kostnader och ogiltig metod", () => {
    const r = profitabilityWithFixedCosts({ ...base, fixedCosts: [] }, "revenue");
    expect(norm(r.summary)).toBe("Inga fasta kostnader i perioden (1–30 nov.). Vinst 96 kr.");
    expect(() => profitabilityWithFixedCosts(base, "x" as "equal")).toThrow(/revenue/);
  });
});
