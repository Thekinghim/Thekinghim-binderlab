import { describe, expect, it } from "vitest";

import type { AccountantReport } from "@/reports";
import { DEFAULT_PLAN } from "@/server/bokforing/plan";

import { DEFAULT_MAPPING, mappingInputSchema, parseMapping } from "./mapping";
import {
  assertBalanced,
  cogsVoucher,
  fixedCostsVoucher,
  idemKey,
  payoutVoucher,
  salesVoucher,
  settlementPaidVoucher,
  storeShareVoucher,
  voucherFingerprint,
  voucherMarker,
  type DesiredVoucher,
} from "./vouchers";

interface MachineFig {
  name: string;
  grossOre: number;
  vatOre?: number;
}

/** En bokföringsrapport med bara det verifikaten läser. */
function report(o: {
  machines: MachineFig[];
  vatRateBp?: number;
  costOre?: number;
  unpricedOrders?: number;
  profitSplitUnpricedOrders?: number;
  stores?: { name: string; commissionOre: number; rentOre: number }[];
}): AccountantReport {
  const machines = o.machines.map((m, i) => ({
    kind: "machine",
    machineId: `m${i}`,
    name: m.name,
    grossOre: m.grossOre,
    vatOre: m.vatOre ?? 0,
    netOre: m.grossOre - (m.vatOre ?? 0),
  }));
  const gross = machines.reduce((s, m) => s + m.grossOre, 0);
  const vat = machines.reduce((s, m) => s + m.vatOre, 0);
  return {
    vatRateBp: o.vatRateBp ?? 0,
    totals: {
      grossOre: gross,
      vatOre: vat,
      netOre: gross - vat,
      costOre: o.costOre ?? 0,
      unpricedOrders: o.unpricedOrders ?? 0,
    },
    machines,
    stores: (o.stores ?? []).map((s, i) => ({
      kind: "store",
      storeId: `s${i}`,
      name: s.name,
      commissionOre: s.commissionOre,
      rentOre: s.rentOre,
      compensationOre: s.commissionOre + s.rentOre,
    })),
    profitSplitUnpricedOrders: o.profitSplitUnpricedOrders ?? 0,
  } as unknown as AccountantReport;
}

const sum = (v: DesiredVoucher, side: "debit" | "credit") =>
  v.rows
    .filter((r) => (side === "debit" ? r.amountOre > 0 : r.amountOre < 0))
    .reduce((s, r) => s + Math.abs(r.amountOre), 0);

const NO_VMB = { enabled: false, vatOre: 0 };

describe("exempelmånaden (oktober 2026), räknad för hand", () => {
  // Försäljning 76 245,00. Nayax: kortavgift 3 049,80, bankavgift 40,00, engångsavgift
  // (Onboarding fee) 824,72. Utbetalt 72 330,48.
  //   76 245,00 − 3 049,80 − 40,00 − 824,72 = 72 330,48
  const october = report({ machines: [{ name: "Automat 1", grossOre: 7_624_500 }] });

  it("försäljningen: D 1580 76 245,00 / K 3000 76 245,00", () => {
    const v = salesVoucher(
      { month: "2026-10", report: october, refundsOre: 0, vmb: NO_VMB },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.date).toBe("2026-10-31");
    expect(v.hold).toBeNull();
    expect(v.rows).toEqual([
      { account: "1580", amountOre: 7_624_500, text: "Försäljning automater oktober 2026" },
      { account: "3000", amountOre: -7_624_500, text: "Försäljning Automat 1 oktober 2026" },
    ]);
    expect(sum(v, "debit")).toBe(7_624_500);
    expect(sum(v, "credit")).toBe(7_624_500);
  });

  it("utbetalningen: bank, kortavgift, bankavgift och engångsavgift som egna rader", () => {
    const v = payoutVoucher(
      {
        id: "p1",
        reference: "Nayax 2026-10",
        period: { start: "2026-10-01", end: "2026-10-31" },
        paidOn: "2026-11-16",
        amountOre: 7_233_048,
        cardFeeOre: 304_980,
        deductions: [
          { kind: "bank_fee", reason: null, amountOre: 4_000 },
          { kind: "adjustment", reason: "Onboarding fee", amountOre: 82_472 },
        ],
        manual: false,
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.date).toBe("2026-11-16");
    expect(v.hold).toBeNull();
    expect(v.rows).toEqual([
      { account: "1930", amountOre: 7_233_048, text: "Utbetalt Nayax 2026-10" },
      { account: "6040", amountOre: 304_980, text: "Kortavgift Nayax 2026-10" },
      { account: "6570", amountOre: 4_000, text: "Bankavgift Nayax" },
      { account: "6590", amountOre: 82_472, text: "Justering Nayax: Onboarding fee" },
      { account: "1580", amountOre: -7_624_500, text: "Avräkning Nayax 2026-10" },
    ]);
    // Debet 72 330,48 + 3 049,80 + 40,00 + 824,72 = 76 245,00 = kredit.
    expect(sum(v, "debit")).toBe(7_233_048 + 304_980 + 4_000 + 82_472);
    expect(sum(v, "debit")).toBe(7_624_500);
    expect(sum(v, "credit")).toBe(7_624_500);
  });

  it("efter båda verifikaten står 0 kr kvar på avräkningskontot 1580", () => {
    const s = salesVoucher(
      { month: "2026-10", report: october, refundsOre: 0, vmb: NO_VMB },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    const p = payoutVoucher(
      {
        id: "p1",
        reference: "Nayax 2026-10",
        period: { start: "2026-10-01", end: "2026-10-31" },
        paidOn: "2026-11-16",
        amountOre: 7_233_048,
        cardFeeOre: 304_980,
        deductions: [
          { kind: "bank_fee", reason: null, amountOre: 4_000 },
          { kind: "adjustment", reason: "Onboarding fee", amountOre: 82_472 },
        ],
        manual: false,
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    const on1580 = [...s.rows, ...p.rows]
      .filter((r) => r.account === "1580")
      .reduce((n, r) => n + r.amountOre, 0);
    expect(on1580).toBe(0);
  });
});

describe("försäljning", () => {
  it("en rad per automat, återbetalningar som egen rad", () => {
    const v = salesVoucher(
      {
        month: "2026-11",
        report: report({
          machines: [
            { name: "A", grossOre: 500_000 },
            { name: "B", grossOre: 300_000 },
          ],
        }),
        refundsOre: 9_900,
        vmb: NO_VMB,
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["1580", 790_100],
      ["3000", -500_000],
      ["3000", -300_000],
      ["3000", 9_900],
    ]);
    assertBalanced(v.rows);
  });

  it("momsen följer momssatsen i Inställningar: 25 % ger utgående moms på 2611", () => {
    const v = salesVoucher(
      {
        month: "2026-11",
        report: report({
          vatRateBp: 2500,
          machines: [{ name: "A", grossOre: 125_000, vatOre: 25_000 }],
        }),
        refundsOre: 12_500,
        vmb: NO_VMB,
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["1580", 112_500],
      ["3000", -100_000],
      ["2611", -25_000],
      ["3000", 10_000],
      ["2611", 2_500],
    ]);
    assertBalanced(v.rows);
  });

  it("momssats 0 ger ingen momsrad alls", () => {
    const v = salesVoucher(
      {
        month: "2026-11",
        report: report({ machines: [{ name: "A", grossOre: 125_000 }] }),
        refundsOre: 0,
        vmb: NO_VMB,
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.some((r) => r.account === "2611" || r.account === "2616")).toBe(false);
  });

  it("VMB på (momssats 0): som månadspaketet, 3211 och 2616", () => {
    const v = salesVoucher(
      {
        month: "2026-11",
        report: report({ machines: [{ name: "A", grossOre: 100_000 }] }),
        refundsOre: 0,
        vmb: { enabled: true, vatOre: 4_000 },
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["1580", 100_000],
      ["3211", -96_000],
      ["2616", -4_000],
    ]);
  });

  it("moms och VMB samtidigt stoppas: appen väljer inte åt ägaren", () => {
    const v = salesVoucher(
      {
        month: "2026-11",
        report: report({
          vatRateBp: 2500,
          machines: [{ name: "A", grossOre: 125_000, vatOre: 25_000 }],
        }),
        refundsOre: 0,
        vmb: { enabled: true, vatOre: 0 },
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows).toEqual([]);
    expect(v.hold?.code).toBe("vat_conflict");
  });

  it("moms utan valt momskonto stoppas", () => {
    const mapping = parseMapping({ accounts: { vat_out: null } });
    const v = salesVoucher(
      {
        month: "2026-11",
        report: report({
          vatRateBp: 2500,
          machines: [{ name: "A", grossOre: 125_000, vatOre: 25_000 }],
        }),
        refundsOre: 0,
        vmb: NO_VMB,
      },
      DEFAULT_PLAN,
      mapping,
    )!;
    expect(v.hold?.code).toBe("unmapped_account");
  });

  it("en månad utan försäljning ger inget verifikat", () => {
    expect(
      salesVoucher(
        { month: "2026-11", report: report({ machines: [] }), refundsOre: 0, vmb: NO_VMB },
        DEFAULT_PLAN,
        DEFAULT_MAPPING,
      ),
    ).toBeNull();
  });
});

describe("utbetalning", () => {
  const base = {
    id: "p",
    reference: "Nayax 2026-11",
    period: { start: "2026-11-01", end: "2026-11-30" },
    paidOn: "2026-12-15",
    amountOre: 96_000,
    cardFeeOre: 4_000,
    deductions: [],
    manual: false,
  } as const;

  it("inskriven för hand: bara banken mot avräkningen, avgifterna gissas inte", () => {
    const v = payoutVoucher(
      { ...base, cardFeeOre: 0, manual: true },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["1930", 96_000],
      ["1580", -96_000],
    ]);
    expect(v.description).toContain("avgifter okända");
  });

  it("ett avdrag utan valt konto (moms, innehållet, Nayax Capital) stoppar verifikatet", () => {
    for (const kind of ["vat", "rolling", "capital"] as const) {
      const v = payoutVoucher(
        { ...base, deductions: [{ kind, reason: null, amountOre: 1_000 }] },
        DEFAULT_PLAN,
        DEFAULT_MAPPING,
      )!;
      expect(v.rows).toEqual([]);
      expect(v.hold?.code).toBe("unmapped_account");
    }
    const mapped = payoutVoucher(
      { ...base, deductions: [{ kind: "vat", reason: null, amountOre: 1_000 }] },
      DEFAULT_PLAN,
      parseMapping({ accounts: { payout_vat: "2641" } }),
    )!;
    expect(mapped.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["1930", 96_000],
      ["6040", 4_000],
      ["2641", 1_000],
      ["1580", -101_000],
    ]);
  });

  it("ett negativt belopp bokförs inte automatiskt", () => {
    expect(
      payoutVoucher({ ...base, amountOre: -1 }, DEFAULT_PLAN, DEFAULT_MAPPING)?.hold?.code,
    ).toBe("unclear_payout");
  });
});

describe("butikernas andel, betalning, inköpsvärde och fasta kostnader", () => {
  it("andel och hyra per butik som skuld", () => {
    const v = storeShareVoucher(
      "2026-10",
      report({
        machines: [{ name: "A", grossOre: 1 }],
        stores: [
          { name: "Butik Ett", commissionOre: 820_000, rentOre: 50_000 },
          { name: "Butik Två", commissionOre: 0, rentOre: 0 },
        ],
      }),
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["6090", 820_000],
      ["5010", 50_000],
      ["2990", -870_000],
    ]);
    expect(v.hold).toBeNull();
  });

  it("väntar när order hos en butik med vinstdelning saknar inköpspris", () => {
    const v = storeShareVoucher(
      "2026-10",
      report({
        machines: [],
        profitSplitUnpricedOrders: 3,
        stores: [{ name: "Butik", commissionOre: 100, rentOre: 0 }],
      }),
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.hold).toEqual({
      code: "missing_cost",
      detail: "3 order saknar inköpspris, så butikens andel för oktober 2026 är inte klar.",
    });
  });

  it("betald avräkning: skulden mot banken", () => {
    const v = settlementPaidVoucher(
      {
        id: "s1",
        storeName: "Butik Ett",
        month: "2026-10",
        amountOre: 870_000,
        paidOn: "2026-11-20",
      },
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.date).toBe("2026-11-20");
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["2990", 870_000],
      ["1930", -870_000],
    ]);
    expect(
      settlementPaidVoucher(
        { id: "s2", storeName: "B", month: "2026-10", amountOre: 0, paidOn: "2026-11-20" },
        DEFAULT_PLAN,
        DEFAULT_MAPPING,
      ),
    ).toBeNull();
  });

  it("inköpsvärde: D 4960 / K 1460, väntar på saknade inköpspriser", () => {
    const v = cogsVoucher(
      "2026-10",
      report({ machines: [], costOre: 4_950_000 }),
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["4960", 4_950_000],
      ["1460", -4_950_000],
    ]);
    expect(
      cogsVoucher(
        "2026-10",
        report({ machines: [], costOre: 100, unpricedOrders: 2 }),
        DEFAULT_PLAN,
        DEFAULT_MAPPING,
      )?.hold?.code,
    ).toBe("missing_cost");
  });

  it("fasta kostnader: en rad per kostnad mot skuld", () => {
    const v = fixedCostsVoucher(
      "2026-10",
      [
        { name: "Försäkring", amountOre: 30_000 },
        { name: "Awish", amountOre: 49_900 },
        { name: "Vilande", amountOre: 0 },
      ],
      DEFAULT_PLAN,
      DEFAULT_MAPPING,
    )!;
    expect(v.rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["6990", 30_000],
      ["6990", 49_900],
      ["2990", -79_900],
    ]);
  });
});

describe("nycklar och mappning", () => {
  it("nyckeln är stabil och fingeravtrycket följer innehållet", () => {
    expect(idemKey("sales", "2026-10", 1)).toBe("sales:2026-10:v1");
    const rows = [
      { account: "1580", amountOre: 100, text: "a" },
      { account: "3000", amountOre: -100, text: "a" },
    ];
    const a = voucherFingerprint({ date: "2026-10-31", rows });
    expect(voucherFingerprint({ date: "2026-10-31", rows: [...rows] })).toBe(a);
    expect(voucherFingerprint({ date: "2026-10-30", rows })).not.toBe(a);
    expect(
      voucherFingerprint({
        date: "2026-10-31",
        rows: [rows[0]!, { ...rows[1]!, account: "3001" }],
      }),
    ).not.toBe(a);
    expect(voucherMarker("org-1", "sales:2026-10:v1")).toMatch(/^\[BL-[0-9a-f]{16}\]$/);
    expect(voucherMarker("org-1", "sales:2026-10:v1")).not.toBe(
      voucherMarker("org-2", "sales:2026-10:v1"),
    );
    expect(voucherMarker("org-1", "sales:2026-10:v1")).not.toBe(
      voucherMarker("org-1", "sales:2026-10:v2"),
    );
  });

  it("mappningen: förslag enligt BAS, inköpsvärde och fasta kostnader av från början", () => {
    expect(DEFAULT_MAPPING.accounts).toMatchObject({
      bank: "1930",
      bank_fees: "6570",
      other_fees: "6590",
      vat_out: "2611",
      payout_vat: null,
      payout_reserve: null,
      payout_capital: null,
    });
    expect(DEFAULT_MAPPING.kinds).toEqual({
      sales: true,
      payout: true,
      store_share: true,
      settlement_paid: true,
      cogs: false,
      fixed_costs: false,
    });
    expect(
      parseMapping({ accounts: { bank: "1940", bank_fees: "abc" }, kinds: { cogs: true } }),
    ).toMatchObject({ accounts: { bank: "1940", bank_fees: "6570" }, kinds: { cogs: true } });
    expect(parseMapping(null)).toEqual(DEFAULT_MAPPING);
    expect(
      mappingInputSchema.safeParse({
        accounts: { ...DEFAULT_MAPPING.accounts, payout_vat: "", bank: "12" },
        kinds: DEFAULT_MAPPING.kinds,
      }).success,
    ).toBe(false);
    const ok = mappingInputSchema.parse({
      accounts: { ...DEFAULT_MAPPING.accounts, payout_vat: "" },
      kinds: DEFAULT_MAPPING.kinds,
    });
    expect(ok.accounts.payout_vat).toBeNull();
  });
});
