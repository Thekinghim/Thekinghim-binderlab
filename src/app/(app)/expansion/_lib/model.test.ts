import { describe, expect, it } from "vitest";

import { octoberSources } from "@/analytics/expansion/test-fixtures";
import { scenarioEvidence } from "@/analytics/expansion";
import { storeCompensation, type MachineInvestment } from "@/domain";

import {
  analyticsStage,
  defaultInvestment,
  evidenceLinks,
  leadInvestment,
  monthsIn,
  salesDeck,
  toAnalyticsLead,
  wholeMonths,
  type LeadRecord,
} from "./model";

const lead = (over: Partial<LeadRecord> = {}): LeadRecord => ({
  id: "l-1",
  name: "Ica Kvantum",
  stage: "meeting",
  stageChangedAt: "2026-11-01T10:00:00.000Z",
  storeType: "livs",
  city: "Malmö",
  openHoursPerWeek: 98,
  areaSqm: 400,
  address: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  notes: null,
  nextStep: null,
  nextStepOn: null,
  commissionBp: null,
  monthlyRentOre: null,
  purchaseOre: null,
  installationOre: null,
  storeId: null,
  archived: false,
  ...over,
});

describe("pipeline", () => {
  it("översätter stegen till analysens steg", () => {
    expect(analyticsStage("lead")).toBe("idea");
    expect(analyticsStage("contacted")).toBe("contacted");
    expect(analyticsStage("meeting")).toBe("negotiating");
    expect(analyticsStage("agreement")).toBe("signed");
    expect(analyticsStage("installed")).toBe("signed");
    expect(analyticsStage("lost")).toBe("rejected");
  });

  it("utan villkor och investering används platsernas avtal och standardinvesteringen", () => {
    const a = toAnalyticsLead(lead());
    expect(a.terms).toBeNull();
    expect(a.investment).toBeUndefined();
    expect(leadInvestment(lead())).toBeNull();
  });

  it("med en del av villkoren eller investeringen blir resten 0 respektive null", () => {
    const a = toAnalyticsLead(lead({ commissionBp: 1200, installationOre: 150_000 }));
    expect(a.terms).toEqual({ commissionBp: 1200, monthlyRentOre: null });
    expect(a.investment).toEqual({ purchaseOre: 0, installationOre: 150_000 });
  });
});

describe("standardinvestering", () => {
  const inv = (
    machineId: string,
    kind: MachineInvestment["kind"],
    amountOre: number,
    date = "2026-09-01",
  ): MachineInvestment => ({ machineId, kind, amountOre, date, depreciationMonths: 60 });

  it("snittet per automat, övrigt räknas till inköpet, avrundat till helt öre", () => {
    const d = defaultInvestment(
      [
        inv("m-1", "purchase", 3_990_000),
        inv("m-1", "installation", 250_000),
        inv("m-2", "purchase", 3_990_000),
        inv("m-3", "purchase", 3_490_000),
        inv("m-3", "other", 1),
      ],
      "2026-11-01",
    );
    // inköp (3 990 000 + 3 990 000 + 3 490 001) / 3 = 3 823 333,67 → 3 823 334
    // installation 250 000 / 3 = 83 333,33 → 83 333
    expect(d).toEqual({
      plan: { purchaseOre: 3_823_334, installationOre: 83_333 },
      machineIds: ["m-1", "m-2", "m-3"],
      totalOre: 3_906_667,
    });
  });

  it("investeringar efter dagen räknas inte, och utan investeringar blir det null", () => {
    expect(defaultInvestment([inv("m-1", "purchase", 100, "2026-12-01")], "2026-11-01")).toBe(null);
  });
});

describe("säljunderlag", () => {
  it("snittet per automat och månad av provision och hyra, minst tre butiker", () => {
    const input = octoberSources();
    const deck = salesDeck(input);
    // Fyra butiker med automat i oktober (s-1, s-2, s-3 hela månaden, s-4 12 dagar).
    expect(deck.status).toBe("ok");
    expect(deck.stores).toBe(4);
    // Automatmånader: 3 + 12/31 = 3,387… → 339 hundradelar.
    expect(deck.machineMonthsHundredths).toBe(339);
    // Provision 10 % på alla order, ingen hyra: s-1 62 × 490, s-2 31 × 490, s-3 31 × 490, s-4 12 × 490.
    const total = storeCompensation(input).totalOre;
    expect(total).toBe(136 * 490);
    // 66 640 öre / (3 + 12/31) månader = 66 640 × 31 / 105 = 19 674,67 → 19 675.
    expect(deck.compensationPerMonthOre).toBe(19_675);
    expect(deck.commissionPerMonthOre).toBe(19_675);
    expect(deck.rentPerMonthOre).toBe(0);
    // Försäljning 136 × 4 900 = 666 400 → × 31 / 105 = 196 746,67 → 196 747.
    expect(deck.salesPerMonthOre).toBe(196_747);
    expect(deck.compensationPerYearOre).toBe(236_096); // 66 640 × 31 × 12 / 105 = 236 096
    expect(deck.compensationShareBp).toBe(1000);
  });

  it("färre butiker än gränsen ger inga belopp", () => {
    const input = octoberSources();
    const deck = salesDeck(input, 5);
    expect(deck.status).toBe("too-few-stores");
    expect(deck.compensationPerMonthOre).toBeNull();
    expect(deck.salesPerMonthOre).toBeNull();
    expect(deck.stores).toBe(4);
  });
});

describe("månader", () => {
  it("månaderna en period berör, även över årsskiftet", () => {
    expect(monthsIn({ start: "2026-11-20", end: "2027-02-03" })).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(wholeMonths({ start: "2026-11-20", end: "2027-02-03" })).toEqual({
      start: "2026-11-01",
      end: "2027-02-28",
    });
    expect(wholeMonths({ start: "2026-12-05", end: "2026-12-06" })).toEqual({
      start: "2026-12-01",
      end: "2026-12-31",
    });
  });
});

describe("underlag", () => {
  it("länkar till Lönsamhet för samma period, per butik och automat", () => {
    const e = scenarioEvidence({
      rule: "x",
      period: { start: "2026-10-01", end: "2026-10-31" },
      storeIds: ["s-1"],
      machineIds: ["m-1"],
      orderIds: ["o-1"],
    });
    const links = evidenceLinks(e, {
      stores: (id) => `Butik ${id}`,
      machines: (id) => `Automat ${id}`,
    });
    expect(links).toEqual([
      {
        label: "Butik s-1",
        href: "/lonsamhet?from=2026-10-01&to=2026-10-31&butik=s-1&grupp=automat",
      },
      {
        label: "Automat m-1",
        href: "/lonsamhet?from=2026-10-01&to=2026-10-31&automat=m-1&grupp=titel",
      },
      { label: "Per dag", href: "/lonsamhet?from=2026-10-01&to=2026-10-31&grupp=dag" },
    ]);
  });
});
