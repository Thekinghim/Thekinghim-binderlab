import { describe, expect, it } from "vitest";
import { buildLedger } from "./ledger";
import { profitability, vmbPreliminary } from "./profitability";
import { agreement, NO_TAX, order, placement, price, randomScenario } from "./testing/fixtures";
import type { GroupBy, ProfitabilityInput } from "./types";
import { vmbApplies, vmbChain, vmbVat } from "./vmb";

const VMB = { ...NO_TAX, vmb: true } as const;

describe("vmbVat (samlad VMB per månad)", () => {
  it("20 % av en positiv marginal, underskottet förs vidare", () => {
    expect(vmbVat({ salesInclVatOre: 64_700, purchasesOre: 42_500, carryInOre: 0 })).toMatchObject({
      marginOre: 22_200,
      vatOre: 4_440,
      baseOre: 17_760,
      carryOutOre: 0,
    });
    expect(vmbVat({ salesInclVatOre: 10_000, purchasesOre: 13_000, carryInOre: 0 })).toMatchObject({
      marginOre: -3_000,
      vatOre: 0,
      carryOutOre: 3_000,
    });
    const chain = vmbChain([
      { month: "2026-11", salesInclVatOre: 64_700, purchasesOre: 42_500 },
      { month: "2026-10", salesInclVatOre: 10_000, purchasesOre: 13_000 },
    ]);
    expect(chain.get("2026-11")).toMatchObject({ carryInOre: 3_000, vatOre: 3_840 });
  });

  it("gäller bara med VMB påslaget och momssats 0", () => {
    expect(vmbApplies(VMB)).toBe(true);
    expect(vmbApplies(NO_TAX)).toBe(false);
    expect(vmbApplies({ vatRateBp: 2_500, vmb: true })).toBe(false);
  });
});

describe("VMB-moms på vår vinst (liggaren)", () => {
  const split = agreement("s-1", "2026-01-01", null, {
    commissionBp: 5_000,
    commissionBase: "profit_after_costs",
    vmbBeforeSplit: true,
  });
  function input(extra: Partial<ProfitabilityInput> = {}): ProfitabilityInput {
    return {
      orders: [
        order({ id: "a", businessDate: "2026-11-02", amountOre: 19_900, titleId: "t-a" }),
        order({ id: "b", businessDate: "2026-11-03", amountOre: 19_900, titleId: "t-a" }),
        order({ id: "c", businessDate: "2026-11-20", amountOre: 24_900, titleId: "t-b" }),
      ],
      prices: [price("t-a", 13_000, "2026-01-01"), price("t-b", 16_500, "2026-01-01")],
      agreements: [split],
      placements: [placement("m-1", "s-1", "2026-01-01", null)],
      settings: VMB,
      period: { start: "2026-11-01", end: "2026-11-30" },
      ...extra,
    };
  }

  it("50/50: vår vinst = butikens andel; vattenfallet har steget VMB-moms", () => {
    const r = profitability(input(), "store");
    // 64 700 − 42 500 = 22 200 → VMB 4 440; butiken 8 880; vi 64 700 − 42 500 − 4 440 − 8 880.
    expect(r.totals).toMatchObject({
      revenueOre: 64_700,
      costOre: 42_500,
      vmbVatOre: 4_440,
      commissionOre: 8_880,
      profitOre: 8_880,
      marginBp: 1_372,
    });
    expect(r.waterfall.steps.map((s) => [s.key, s.valueOre])).toEqual([
      ["revenue", 64_700],
      ["vmb", -4_440],
      ["cost", -42_500],
      ["fees", 0],
      ["compensation", -8_880],
      ["profit", 8_880],
    ]);
    expect(r.vmb).toMatchObject({ applies: true, vatOre: 4_440, partial: false });
  });

  it("fördelas på orderna efter marginalen (belopp − inköp), exakt på öret", () => {
    const ledger = buildLedger(input());
    // Vikter 6 900 : 6 900 : 8 400 av 22 200.
    expect(ledger.entries.map((e) => e.vmbVatOre)).toEqual([1_380, 1_380, 1_680]);
    const byTitle = profitability(input(), "title");
    expect(byTitle.rows.map((row) => [row.key, row.vmbVatOre])).toEqual([
      ["t-a", 2_760],
      ["t-b", 1_680],
    ]);
  });

  it("utan VMB (standard) eller med moms: ingen VMB-moms och inget steg", () => {
    for (const settings of [NO_TAX, { vatRateBp: 2_500, cardFeeBp: 0, vmb: true }]) {
      const r = profitability(input({ settings }), "title");
      expect(r.totals.vmbVatOre).toBe(0);
      expect(r.vmb.applies).toBe(false);
      expect(r.waterfall.steps.some((s) => s.key === "vmb")).toBe(false);
    }
  });

  it("återbetalningar sänker marginalen; ett underskott förs till nästa månad i perioden", () => {
    const refunds = [{ machineId: null, refundedOn: "2026-10-20", amountOre: 5_000 }];
    const r = profitability(
      input({
        refunds,
        period: { start: "2026-10-01", end: "2026-11-30" },
        orders: [
          ...input().orders,
          order({ id: "d", businessDate: "2026-10-05", amountOre: 10_000, titleId: "t-a" }),
        ],
      }),
      "month",
    );
    // Okt.: 10 000 − 5 000 − 13 000 = −8 000 → 0, underskott 8 000.
    // Nov.: 64 700 − 42 500 − 8 000 = 14 200 → 2 840.
    expect(r.vmb.months.map((m) => [m.month, m.refundsOre, m.marginOre, m.vatOre])).toEqual([
      ["2026-10", 5_000, -8_000, 0],
      ["2026-11", 0, 14_200, 2_840],
    ]);
    expect(r.rows.map((row) => [row.key, row.vmbVatOre])).toEqual([
      ["2026-10", 0],
      ["2026-11", 2_840],
    ]);
    expect(r.totals.vmbVatOre).toBe(2_840);
  });

  it("delmånad och en månad som inte är slut är preliminära", () => {
    const whole = profitability(input(), "title").vmb;
    expect(whole.partial).toBe(false);
    expect(vmbPreliminary(whole, "2026-12-01")).toBe(false);
    expect(vmbPreliminary(whole, "2026-11-30")).toBe(true);
    const part = profitability(
      input({ period: { start: "2026-11-01", end: "2026-11-10" } }),
      "title",
    );
    // Räknas på periodens marginal: 39 800 − 26 000 = 13 800 → 2 760.
    expect(part.vmb).toMatchObject({ partial: true, vatOre: 2_760 });
    expect(vmbPreliminary(part.vmb, "2027-01-01")).toBe(true);
    expect(
      vmbPreliminary(profitability(input({ settings: NO_TAX }), "title").vmb, "2026-11-05"),
    ).toBe(false);
  });
});

describe("avstämning: vyknappen Med VMB × avtalets Dra av VMB-moms före delning", () => {
  // 64 700 sålt, 42 500 inköp, 0 kortavgift: marginal 22 200, VMB-moms 4 440.
  const orders = [
    order({ id: "a", businessDate: "2026-11-02", amountOre: 19_900, titleId: "t-a" }),
    order({ id: "b", businessDate: "2026-11-03", amountOre: 19_900, titleId: "t-a" }),
    order({ id: "c", businessDate: "2026-11-20", amountOre: 24_900, titleId: "t-b" }),
  ];
  const input = (view: boolean, beforeSplit: boolean): ProfitabilityInput => ({
    orders,
    prices: [price("t-a", 13_000, "2026-01-01"), price("t-b", 16_500, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, {
        commissionBp: 5_000,
        commissionBase: "profit_after_costs",
        vmbBeforeSplit: beforeSplit,
      }),
    ],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: { ...NO_TAX, vmb: view },
    period: { start: "2026-11-01", end: "2026-11-30" },
  });
  const cases: [boolean, boolean, number, number, number][] = [
    // vy, avtal, butikens andel, VMB i vår vinst, vår vinst
    [false, true, 8_880, 0, 13_320],
    [true, true, 8_880, 4_440, 8_880],
    [false, false, 11_100, 0, 11_100],
    [true, false, 11_100, 4_440, 6_660],
  ];
  for (const [view, beforeSplit, share, vmb, profit] of cases) {
    it(`vy ${view ? "på" : "av"}, avtal ${beforeSplit ? "på" : "av"}: andel ${share}, vinst ${profit}`, () => {
      const r = profitability(input(view, beforeSplit), "store");
      const t = r.totals;
      expect([t.commissionOre, t.vmbVatOre, t.profitOre]).toEqual([share, vmb, profit]);
      // Vår vinst = försäljning − återbetalningar − inköp − kortavgifter − butikens andel
      //             (− VMB-moms bara med vyknappen), exakt på öret.
      expect(t.revenueOre - t.costOre - t.feesOre - t.compensationOre - t.vmbVatOre).toBe(
        t.profitOre,
      );
      // Butikens andel = 50 % × (vinst efter kostnader − VMB-moms om avtalet drar av den).
      const split = buildLedger(input(view, beforeSplit)).profitSplits[0]!.result;
      expect(split.vmbVatOre).toBe(beforeSplit ? 4_440 : 0);
      expect(split.storeShareOre).toBe(Math.round((22_200 - split.vmbVatOre) / 2));
      expect(r.waterfall.steps.some((st) => st.key === "vmb")).toBe(view);
    });
  }
});

describe("VMB i 200 slumpade scenarier", () => {
  const groups: GroupBy[] = ["title", "machine", "store", "day", "week", "month"];
  for (let seed = 1; seed <= 200; seed++) {
    it(`scenario ${seed}: raderna summerar, månaderna följer vmbChain, allt stämmer mot försäljningen`, () => {
      const base = randomScenario(seed);
      const refunds = base.orders.slice(0, 3).map((o, i) => ({
        machineId: o.machineId,
        refundedOn: o.businessDate,
        amountOre: (i + 1) * 1_000,
      }));
      const inp: ProfitabilityInput = {
        ...base,
        refunds,
        settings: { ...base.settings, vatRateBp: 0, vmb: true },
      };
      const ledger = buildLedger(inp);
      // Månaderna = vmbChain på månadens prissatta försäljning − återbetalningar och inköp.
      const months = new Map<string, { sales: number; purchases: number }>();
      for (const m of ledger.vmb) months.set(m.month, { sales: 0, purchases: 0 });
      for (const e of ledger.entries) {
        if (!e.priced) continue;
        const m = months.get(e.month)!;
        m.sales += e.grossOre;
        m.purchases += e.costOre;
      }
      for (const r of refunds) {
        if (r.refundedOn < inp.period.start || r.refundedOn > inp.period.end) continue;
        months.get(r.refundedOn.slice(0, 7))!.sales -= r.amountOre;
      }
      const chain = vmbChain(
        [...months].map(([month, m]) => ({
          month,
          salesInclVatOre: m.sales,
          purchasesOre: m.purchases,
        })),
      );
      for (const m of ledger.vmb) expect(m.vatOre).toBe(chain.get(m.month)!.vatOre);
      const vmbTotal = ledger.vmb.reduce((a, m) => a + m.vatOre, 0);

      for (const g of groups) {
        const r = profitability(inp, g);
        expect(r.totals.vmbVatOre).toBe(vmbTotal);
        expect(r.rows.reduce((a, row) => a + row.vmbVatOre, 0)).toBe(vmbTotal);
        expect(r.rows.reduce((a, row) => a + row.profitOre, 0)).toBe(r.totals.profitOre);
        // Försäljning (prissatt) = vinst + butiksersättning + VMB + inköp + avgifter.
        const t = r.totals;
        expect(t.profitOre + t.compensationOre + t.vmbVatOre + t.costOre + t.feesOre).toBe(
          t.revenueOre,
        );
        expect(r.waterfall.steps.filter((s) => !s.total).reduce((a, s) => a + s.valueOre, 0)).toBe(
          t.profitOre,
        );
      }
    });
  }
});

describe("filtrerad vy (butik/automat) med VMB", () => {
  // Butik s-2 säljer under inköpspris: organisationens marginal och VMB-moms blir lägre än
  // butik s-1:s egen. Butikens sida (filtrerad) ska visa samma VMB-moms som butikens rad.
  const all: ProfitabilityInput = {
    orders: [
      order({
        id: "a",
        businessDate: "2026-10-02",
        amountOre: 19_900,
        titleId: "t-a",
        machineId: "m-1",
      }),
      order({
        id: "b",
        businessDate: "2026-10-03",
        amountOre: 10_000,
        titleId: "t-b",
        machineId: "m-2",
      }),
    ],
    prices: [price("t-a", 13_000, "2026-01-01"), price("t-b", 16_500, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, {}),
      agreement("s-2", "2026-01-01", null, {}),
    ],
    placements: [
      placement("m-1", "s-1", "2026-01-01", null),
      placement("m-2", "s-2", "2026-01-01", null),
    ],
    settings: VMB,
    period: { start: "2026-10-01", end: "2026-10-31" },
  };
  const only: ProfitabilityInput = {
    ...all,
    orders: [all.orders[0]!],
    agreements: [all.agreements[0]!],
    placements: [all.placements[0]!],
  };

  it("utan vmbByOrder räknas urvalets egen marginal (skiljer sig från raden)", () => {
    const row = profitability(all, "store").rows.find((r) => r.key === "s-1")!;
    // Organisationen: 29 900 − 29 500 = 400 → 80; allt på order a.
    expect(row.vmbVatOre).toBe(80);
    expect(profitability(only, "store").totals.vmbVatOre).toBe(1_380);
  });

  it("med vmbByOrder från den ofiltrerade liggaren: samma VMB-moms och vinst som raden", () => {
    const shares = new Map(buildLedger(all).entries.map((e) => [e.order.id, e.vmbVatOre]));
    const row = profitability(all, "store").rows.find((r) => r.key === "s-1")!;
    const filtered = profitability({ ...only, vmbByOrder: shares }, "store");
    expect(filtered.totals.vmbVatOre).toBe(row.vmbVatOre);
    expect(filtered.totals.profitOre).toBe(row.profitOre);
    expect(filtered.vmb.vatOre).toBe(row.vmbVatOre);
  });
});
