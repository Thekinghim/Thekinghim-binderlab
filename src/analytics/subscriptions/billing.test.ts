import { describe, expect, it } from "vitest";

import {
  arrOf,
  customerStateOn,
  customerSummary,
  invoiceBasis,
  measureDay,
  mrrOn,
  platformHistory,
  platformTotals,
  sumByCurrency,
  vatTreatment,
  type BillingInput,
  type PlanPeriod,
  type PlatformCustomerInput,
} from "./billing";

const SE = { countryCode: "SE", vatNumber: null, trialEndsOn: null };

function plan(
  validFrom: string,
  validTo: string | null,
  pricePerMachineOre = 50_000,
  status: PlanPeriod["status"] = "active",
  currency = "SEK",
): PlanPeriod {
  return { validFrom, validTo, status, pricePerMachineOre, currency };
}

function machine(id: string, activeFrom: string, activeTo: string | null = null) {
  return { machineId: id, activeFrom, activeTo };
}

describe("fakturaunderlag", () => {
  it("hel månad: pris × automater, 25 % moms i Sverige", () => {
    const input: BillingInput = {
      periods: [plan("2026-01-01", null, 49_900)],
      machines: [machine("a", "2025-12-01"), machine("b", "2026-10-15")],
      customer: SE,
    };
    const b = invoiceBasis(input, "2026-11");
    expect(b.daysInMonth).toBe(30);
    expect(b.activeMachines).toBe(2);
    expect(b.machineDays).toBe(60);
    expect(b.billableMachineDays).toBe(60);
    expect(b.lines).toEqual([
      { currency: "SEK", pricePerMachineOre: 49_900, machineDays: 60, netOre: 99_800 },
    ]);
    expect(b.totals).toEqual([
      { currency: "SEK", netOre: 99_800, vatOre: 24_950, totalOre: 124_750 },
    ]);
    expect(b.vat.mode).toBe("se_vat");
  });

  it("automat som startar mitt i månaden: andel av dagarna, avrundat halva uppåt", () => {
    // 10 dagar av 31 i oktober: 50 000 × 10 / 31 = 16 129,03 → 16 129 öre.
    const b = invoiceBasis(
      {
        periods: [plan("2026-01-01", null)],
        machines: [machine("a", "2026-10-22")],
        customer: SE,
      },
      "2026-10",
    );
    expect(b.billableMachineDays).toBe(10);
    expect(b.lines[0]!.netOre).toBe(16_129);
    // 3 dagar av 30: 10 001 × 3 / 30 = 1 000,1 → 1 000; 5 dagar → 1 666,83 → 1 667.
    const half = invoiceBasis(
      {
        periods: [plan("2026-01-01", null, 10_001)],
        machines: [machine("a", "2026-11-26")],
        customer: SE,
      },
      "2026-11",
    );
    expect(half.lines[0]!.netOre).toBe(1_667);
  });

  it("automat som slutar: sista aktiva dagen räknas", () => {
    const b = invoiceBasis(
      {
        periods: [plan("2026-01-01", null, 30_000)],
        machines: [machine("a", "2025-01-01", "2026-11-15")],
        customer: SE,
      },
      "2026-11",
    );
    expect(b.billableMachineDays).toBe(15);
    expect(b.lines[0]!.netOre).toBe(15_000);
  });

  it("provperiod: inget debiteras till och med sista provdagen", () => {
    const b = invoiceBasis(
      {
        periods: [plan("2026-11-01", null, 30_000)],
        machines: [machine("a", "2026-01-01"), machine("b", "2026-01-01")],
        customer: { ...SE, trialEndsOn: "2026-11-10" },
      },
      "2026-11",
    );
    expect(b.trialMachineDays).toBe(20);
    expect(b.billableMachineDays).toBe(40);
    expect(b.totals[0]!.netOre).toBe(40_000);
  });

  it("pausad och avslutad plan debiteras inte; prisändring ger två rader", () => {
    const b = invoiceBasis(
      {
        periods: [
          plan("2026-01-01", "2026-11-10", 30_000),
          plan("2026-11-11", "2026-11-20", 30_000, "paused"),
          plan("2026-11-21", null, 60_000),
        ],
        machines: [machine("a", "2026-01-01")],
        customer: SE,
      },
      "2026-11",
    );
    expect(b.lines).toEqual([
      { currency: "SEK", pricePerMachineOre: 30_000, machineDays: 10, netOre: 10_000 },
      { currency: "SEK", pricePerMachineOre: 60_000, machineDays: 10, netOre: 20_000 },
    ]);
    expect(b.totals[0]!.netOre).toBe(30_000);
    expect(b.machineDays).toBe(30);
  });

  it("ingen plan eller inga automater: tomt underlag", () => {
    const b = invoiceBasis(
      { periods: [], machines: [machine("a", "2026-01-01")], customer: SE },
      "2026-11",
    );
    expect(b.lines).toEqual([]);
    expect(b.totals).toEqual([]);
    expect(b.activeMachines).toBe(1);
  });

  it("valutor blandas aldrig", () => {
    const b = invoiceBasis(
      {
        periods: [
          plan("2026-01-01", "2026-11-15", 40_000, "active", "DKK"),
          plan("2026-11-16", null, 40_000, "active", "EUR"),
        ],
        machines: [machine("a", "2026-01-01")],
        customer: { countryCode: "DK", vatNumber: "DK12345678", trialEndsOn: null },
      },
      "2026-11",
    );
    expect(b.totals.map((t) => [t.currency, t.netOre, t.vatOre])).toEqual([
      ["DKK", 20_000, 0],
      ["EUR", 20_000, 0],
    ]);
  });

  it("skottår: februari har 29 dagar", () => {
    const b = invoiceBasis(
      {
        periods: [plan("2028-01-01", null, 29_000)],
        machines: [machine("a", "2028-02-15")],
        customer: SE,
      },
      "2028-02",
    );
    expect(b.daysInMonth).toBe(29);
    expect(b.lines[0]!.netOre).toBe(15_000);
  });
});

describe("moms", () => {
  it("Sverige och inget land: 25 %", () => {
    expect(vatTreatment({ countryCode: "SE", vatNumber: null }).rateBp).toBe(2500);
    expect(vatTreatment({ countryCode: null, vatNumber: null }).mode).toBe("se_vat");
  });
  it("EU med momsnummer: omvänd skattskyldighet", () => {
    const v = vatTreatment({ countryCode: "dk", vatNumber: "DK12345678" });
    expect(v).toMatchObject({ mode: "reverse_charge", rateBp: 0 });
    expect(v.note).toContain("DK12345678");
  });
  it("EU utan momsnummer: svensk moms och varning", () => {
    expect(vatTreatment({ countryCode: "FI", vatNumber: " " })).toMatchObject({
      mode: "missing_vat_number",
      rateBp: 2500,
    });
  });
  it("utanför EU: ingen moms", () => {
    expect(vatTreatment({ countryCode: "NO", vatNumber: "NO123456789" })).toMatchObject({
      mode: "outside_eu",
      rateBp: 0,
    });
  });
  it("utanför EU: noteringen hänvisar inte till en paragraf som inte gäller", () => {
    // "3 kap. 5 § ML" handlar inte om var en tjänst omsätts (och gamla ML är ersatt av
    // mervärdesskattelagen 2023:200). Bara direktivets huvudregel för B2B, art. 44.
    const note = vatTreatment({ countryCode: "US", vatNumber: null }).note;
    expect(note).not.toMatch(/kap\./);
    expect(note).toContain("art. 44");
  });
});

describe("MRR och ARR", () => {
  const input: BillingInput = {
    periods: [plan("2026-01-01", null, 49_900)],
    machines: [machine("a", "2025-01-01"), machine("b", "2026-06-01"), machine("c", "2026-12-01")],
    customer: SE,
  };
  it("MRR = pris × aktiva automater dagen, ARR = 12 × MRR", () => {
    const mrr = mrrOn(input, "2026-11-05");
    expect(mrr).toEqual({ currency: "SEK", amountOre: 99_800 });
    expect(arrOf(mrr)).toEqual({ currency: "SEK", amountOre: 1_197_600 });
    expect(mrrOn(input, "2026-12-01")!.amountOre).toBe(149_700);
  });
  it("ingen MRR i provperiod, paus eller utan plan", () => {
    expect(mrrOn({ ...input, customer: { ...SE, trialEndsOn: "2026-11-30" } }, "2026-11-05")).toBe(
      null,
    );
    expect(
      mrrOn({ ...input, periods: [plan("2026-01-01", null, 1, "paused")] }, "2026-11-05"),
    ).toBe(null);
    expect(mrrOn({ ...input, periods: [] }, "2026-11-05")).toBe(null);
  });
  it("summor per valuta, SEK först", () => {
    expect(
      sumByCurrency([
        { currency: "EUR", amountOre: 1 },
        null,
        { currency: "SEK", amountOre: 2 },
        { currency: "DKK", amountOre: 3 },
        { currency: "SEK", amountOre: 5 },
      ]),
    ).toEqual([
      { currency: "SEK", amountOre: 7 },
      { currency: "DKK", amountOre: 3 },
      { currency: "EUR", amountOre: 1 },
    ]);
  });
});

describe("kundens läge, historik och churn", () => {
  const paying: PlatformCustomerInput = {
    id: "k1",
    name: "Kund 1",
    periods: [plan("2026-01-01", null, 50_000)],
    machines: [machine("a", "2025-01-01"), machine("b", "2025-01-01")],
    customer: SE,
  };
  const churner: PlatformCustomerInput = {
    id: "k2",
    name: "Kund 2",
    periods: [plan("2026-01-01", "2026-09-14", 50_000), plan("2026-09-15", null, 50_000, "ended")],
    machines: [machine("x", "2025-01-01")],
    customer: SE,
  };
  const trial: PlatformCustomerInput = {
    id: "k3",
    name: "Kund 3",
    periods: [plan("2026-11-01", null, 40_000, "active", "DKK")],
    machines: [machine("y", "2026-10-01")],
    customer: { countryCode: "DK", vatNumber: "DK1", trialEndsOn: "2026-11-30" },
  };
  const none: PlatformCustomerInput = {
    id: "k4",
    name: "Kund 4",
    periods: [],
    machines: [machine("z", "2026-01-01")],
    customer: { countryCode: null, vatNumber: null, trialEndsOn: null },
  };

  it("läget", () => {
    expect(customerStateOn(paying, "2026-11-05")).toBe("active");
    expect(customerStateOn(churner, "2026-11-05")).toBe("ended");
    expect(customerStateOn(trial, "2026-11-05")).toBe("trial");
    expect(customerStateOn(trial, "2026-10-05")).toBe("none");
    expect(customerStateOn(none, "2026-11-05")).toBe("none");
  });

  it("mätdag: sista dagen eller i dag", () => {
    expect(measureDay("2026-10", "2026-11-05")).toBe("2026-10-31");
    expect(measureDay("2026-11", "2026-11-05")).toBe("2026-11-05");
    expect(measureDay("2026-12", "2026-11-05")).toBe(null);
  });

  it("historik: MRR per månad, fakturerat och churn i september", () => {
    const h = platformHistory([paying, churner, trial, none], "2026-11-05", 4);
    expect(h.map((m) => m.month)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
    const aug = h[0]!;
    expect(aug.mrr).toEqual([{ currency: "SEK", amountOre: 150_000 }]);
    expect(aug.invoiced).toEqual([{ currency: "SEK", amountOre: 150_000 }]);
    expect(aug.churned).toBe(0);
    const sep = h[1]!;
    expect(sep.activeAtStart).toBe(2);
    expect(sep.churned).toBe(1);
    expect(sep.churnBp).toBe(5000);
    // 14 dagar av 30 för kund 2: 50 000 × 14 / 30 = 23 333.
    expect(sep.invoiced).toEqual([{ currency: "SEK", amountOre: 100_000 + 23_333 }]);
    expect(sep.mrr).toEqual([{ currency: "SEK", amountOre: 100_000 }]);
    const nov = h[3]!;
    expect(nov.partial).toBe(true);
    expect(nov.payingCustomers).toBe(1);
    expect(nov.churned).toBe(0);
  });

  it("sammanfattning och totaler", () => {
    const today = "2026-11-05";
    const s = [paying, churner, trial, none].map((c) => customerSummary(c, today));
    expect(s[0]).toMatchObject({
      state: "active",
      machinesNow: 2,
      activeMachinesThisMonth: 2,
      mrr: { currency: "SEK", amountOre: 100_000 },
      arr: { currency: "SEK", amountOre: 1_200_000 },
      startedOn: "2026-01-01",
    });
    expect(s[1]!.plan?.status).toBe("ended");
    expect(s[2]!.trialEndsOn).toBe("2026-11-30");
    const t = platformTotals(s);
    expect(t).toEqual({
      mrr: [{ currency: "SEK", amountOre: 100_000 }],
      arr: [{ currency: "SEK", amountOre: 1_200_000 }],
      payingCustomers: 1,
      trialCustomers: 1,
      pausedCustomers: 0,
      customers: 4,
      billableMachines: 2,
      machines: 5,
    });
  });

  it("betalande kund = MRR över 0 (aktiv plan utan automater eller med pris 0 räknas inte)", () => {
    const today = "2026-11-05";
    const noMachines: PlatformCustomerInput = { ...paying, id: "k5", machines: [] };
    const free: PlatformCustomerInput = {
      ...paying,
      id: "k6",
      periods: [plan("2026-01-01", null, 0)],
    };
    const s = [paying, noMachines, free].map((c) => customerSummary(c, today));
    expect(platformTotals(s).payingCustomers).toBe(1);
    const h = platformHistory([paying, noMachines, free], today, 2);
    expect(h.map((m) => m.payingCustomers)).toEqual([1, 1]);
  });
});
