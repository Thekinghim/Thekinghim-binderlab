/**
 * Ägarens regel: vår vinst och marginal är FÖRE butikernas andel som standard. Andelen dras
 * (och visas som "Butikernas andel" / "Vår del") bara med vyknappen "Visa butikernas andel"
 * eller när en butik är vald. Flaggan kommer från indata (Settings.deductStoreShare, satt av
 * loadDomainInputFor), så nyckeltal, vattenfall, tabell och utveckling följer samma regel.
 */
import { describe, expect, it } from "vitest";

import type { ProfitabilityInput } from "@/domain";

import { profitBridgeModel } from "@/components/charts/profit-bridge";
import { formatPercent, formatSek } from "@/lib/format";

import { compensationBreakdownLabel } from "../_components/breakdown";
import { bridgeSteps, TO_STORES_LABEL } from "../_components/bridge";
import { marginMarkerText } from "../_components/profit-trend-chart";
import { columnsFor } from "../_components/profit-table";
import { trendNotes } from "../_components/sections";
import { lonsamhetHeadline } from "./headline";
import { buildLonsamhetModel, type LonsamhetInput } from "./model";

const PERIOD = { start: "2026-10-14", end: "2026-11-03" };

/** Sega gubben: 50 % av vinsten, kortavgift 2,5 %, ingen hyra. */
function segaGubben(
  scope = { storeId: null as string | null, machineId: null as string | null },
  deductStoreShare = false,
) {
  const current: ProfitabilityInput = {
    period: PERIOD,
    orders: Array.from({ length: 10 }, (_, i) => ({
      id: `o${i}`,
      externalId: String(i),
      titleId: "A",
      machineId: "m1",
      businessDate: "2026-10-20",
      amountOre: 17_500,
    })),
    prices: [{ titleId: "A", unitCostOre: 14_000, validFrom: "2026-01-01" }],
    agreements: [
      {
        storeId: "s1",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 5_000,
        monthlyRentOre: null,
        commissionBase: "profit_after_costs",
      },
    ],
    placements: [{ machineId: "m1", storeId: "s1", from: "2026-01-01", to: null }],
    settings: { vatRateBp: 0, cardFeeBp: 250, deductStoreShare },
  };
  const input: LonsamhetInput = {
    current,
    previous: null,
    titles: [
      { id: "A", name: "30th Celebration", series: null, mergedIntoId: null, archived: false },
    ],
    machines: [
      {
        id: "m1",
        code: "BL-001",
        name: "Automat 1",
        serial: null,
        storeId: "s1",
        isExample: false,
        archived: false,
        activeFrom: null,
        activeTo: null,
      },
    ],
    stores: [
      {
        id: "s1",
        name: "Sega gubben",
        address: null,
        contactName: null,
        email: null,
        phone: null,
        isExample: false,
        archived: false,
      },
    ],
    scope,
  };
  return input;
}

const OPTS = { today: "2026-11-04" };

/** Summan av utvecklingens staplar (dag, vecka, månad) plus hyra som ingen dag bär. */
function trendSum(m: ReturnType<typeof buildLonsamhetModel>, key: "day" | "week" | "month") {
  const t = m.trend[key];
  return t.buckets.reduce((n, b) => n + b.profitOre, 0) + t.unallocatedProfitOre;
}

describe("Lönsamhet: vår vinst före butikernas andel som standard", () => {
  it("räknar vinst och marginal före andelen, utan steg, kolumn eller nyckeltal för den", () => {
    const m = buildLonsamhetModel(segaGubben(), OPTS);
    const t = m.totals;
    expect(m.showStoreShare).toBe(false);
    expect(t.compensationOre).toBeGreaterThan(0);
    // Vår vinst = intäkt − inköp − avgifter (butikens andel dras inte).
    expect(t.profitOre).toBe(t.revenueOre - t.costOre - t.feesOre);
    expect(m.bridge.profitBeforeShareOre).toBe(t.profitOre);
    expect(m.kpis.map((k) => k.id)).toEqual(["profit", "margin", "revenue", "orders"]);
    expect(m.kpis[0]).toMatchObject({ label: "Vår vinst", value: t.profitOre });
    expect(m.kpis[1]).toMatchObject({
      label: "Vår marginal",
      value: Math.round((t.profitOre * 10_000) / t.revenueOre),
    });
    // Vattenfallet: Intäkt → Inköp → Avgifter → Vår vinst. Avgifterna är bara avgifter.
    const steps = bridgeSteps(m.bridge);
    expect(steps.storeShareOre).toBeNull();
    expect(steps.feesOre).toBe(m.bridge.feesOre);
    expect(steps.profitLabel).toBe("Vår vinst");
    const b = m.bridge;
    expect(b.revenueOre - b.costOre - steps.feesOre).toBe(b.profitOre);
    // Tabellen: ingen kolumn för andelen; vinsten heter Vår vinst.
    const cols = columnsFor("title", m.views.title, m.totals, false, null, m.showStoreShare);
    expect(cols.map((c) => c.key)).not.toContain("compensation");
    expect(cols.find((c) => c.key === "profit")?.header).toBe("Vår vinst");
    expect(cols.find((c) => c.key === "margin")?.header).toBe("Vår marginal");
    // Utvecklingen per dag, vecka och månad går ihop med nyckeltalet.
    for (const k of ["day", "week", "month"] as const) expect(trendSum(m, k)).toBe(t.profitOre);
    expect(m.headline.title).toMatch(/^Vår vinst /);
  });

  it("drar butikens andel med vyknappen: Butikernas andel och Vår del", () => {
    const off = buildLonsamhetModel(segaGubben(), OPTS);
    const on = buildLonsamhetModel(segaGubben(undefined, true), OPTS);
    expect(on.showStoreShare).toBe(true);
    // Vår del = vinsten före andelen − butikernas andel (50 % av vinsten efter kostnader).
    expect(on.totals.profitOre).toBe(off.totals.profitOre - on.totals.compensationOre);
    expect(on.totals.compensationOre).toBe(Math.round(off.totals.profitOre / 2));
    expect(on.bridge.profitBeforeShareOre).toBe(off.totals.profitOre);
    expect(on.kpis[0]).toMatchObject({ label: "Vår del", value: on.totals.profitOre });
    expect(on.kpis[1]?.label).toBe("Marginal efter andel");
    expect(on.kpis.find((k) => k.id === "compensation")).toMatchObject({
      label: "Butikernas andel",
      value: on.totals.compensationOre,
    });
    const steps = bridgeSteps(on.bridge);
    expect(steps).toEqual({
      feesOre: on.bridge.feesOre,
      storeShareOre: on.bridge.compensationOre,
      storeShareLabel: TO_STORES_LABEL,
      // Kort etikett när platsen inte räcker: fortfarande alla butiker, inte "Till butiken".
      storeShareShort: TO_STORES_LABEL,
      profitLabel: "Vår del",
      marginBp: on.bridge.marginBp,
    });
    const cols = columnsFor(
      "title",
      on.views.title,
      on.totals,
      false,
      null,
      true,
      "Butikernas andel",
    );
    expect(cols.find((c) => c.key === "compensation")?.header).toBe("Butikernas andel");
    expect(cols.find((c) => c.key === "profit")?.header).toBe("Vår del");
    for (const k of ["day", "week", "month"] as const) {
      expect(trendSum(on, k)).toBe(on.totals.profitOre);
    }
    expect(on.headline.title).toMatch(/^Vår del /);
    expect(on.headline.aside).toMatch(/^Butikernas andel: /);
  });

  it("drar och namnger butikens andel med villkoren när en butik är vald", () => {
    // Laddaren sätter flaggan när en butik är vald (loadDomainInputFor).
    const m = buildLonsamhetModel(segaGubben({ storeId: "s1", machineId: null }, true), OPTS);
    expect(m.showStoreShare).toBe(true);
    expect(m.bridge.storeShareLabel).toBe("Sega gubben 50\u00a0% av vinsten");
    expect(bridgeSteps(m.bridge).storeShareLabel).toBe("Sega gubben 50\u00a0% av vinsten");
    expect(m.kpis.find((k) => k.id === "compensation")?.label).toBe("Butikens andel");
    expect(m.headline.aside).toMatch(/^Sega gubben 50\u00a0% av vinsten: /);
  });

  it("nämner inte butikernas andel i förlustrubriken utan vyknappen", () => {
    const base = {
      days: 21,
      orders: 10,
      pricedOrders: 10,
      profitOre: -1_000,
      marginBp: -100,
      revenueOre: 100_000,
      costOre: 40_000,
      feesOre: 2_000,
      compensationOre: 59_000,
      unpricedShareBp: 0,
      top: null,
      previous: null,
    };
    expect(lonsamhetHeadline({ ...base, showStoreShare: true }).aside).toMatch(
      /^Butikernas andel tog/,
    );
    const off = lonsamhetHeadline({ ...base, showStoreShare: false }).aside;
    expect(off).toMatch(/^Inköpen tog/);
    expect(off).not.toMatch(/butik/i);
  });

  it("vattenfallet visar samma marginal som nyckeltalet och kortar inte alla butiker till en", () => {
    for (const share of [false, true]) {
      const m = buildLonsamhetModel(segaGubben(undefined, share), OPTS);
      const steps = bridgeSteps(m.bridge);
      const b = profitBridgeModel({
        revenue: m.bridge.revenueOre / 100,
        purchases: m.bridge.costOre / 100,
        fees: steps.feesOre / 100,
        storeCompensation: steps.storeShareOre === null ? undefined : steps.storeShareOre / 100,
        margin: steps.marginBp === null ? undefined : steps.marginBp / 10_000,
        labels: {
          storeCompensation: steps.storeShareLabel,
          storeCompensationShort: steps.storeShareShort,
          profit: steps.profitLabel,
        },
        format: formatSek,
      });
      const kpi = m.kpis.find((k) => k.id === "margin")!;
      // Samma tal som nyckeltalet (bp), inte en egen avrundning av kronorna.
      expect(b.text).toContain(`marginal ${formatPercent((kpi.value as number) / 10_000)}`);
      const store = b.steps.find((s) => s.label === TO_STORES_LABEL);
      if (share) {
        expect(store?.short).toBe(TO_STORES_LABEL);
        expect(store?.name).not.toMatch(/butikens/);
      } else expect(store).toBeUndefined();
    }
    // Med vald butik får det korta namnet vara "Till butiken".
    const one = buildLonsamhetModel(segaGubben({ storeId: "s1", machineId: null }, true), OPTS);
    expect(bridgeSteps(one.bridge).storeShareShort).toBe("Till butiken");
  });

  it("vattenfallet tar marginalen från nyckeltalets bp, inte en egen avrundning", () => {
    // 6 440,75 / 33 995 = 18,946 % = 1 895 bp: nyckeltalet visar 19,0 %, vattenfallet samma.
    const b = profitBridgeModel({
      revenue: 33_995,
      purchases: 21_113.5,
      fees: 0,
      storeCompensation: 6_440.75,
      margin: 1_895 / 10_000,
      format: formatSek,
    });
    expect(b.text).toContain("marginal 19,0\u00a0%");
  });

  it("utvecklingen säger periodens vinst och marginal, samma som nyckeltalen", () => {
    for (const share of [false, true]) {
      const m = buildLonsamhetModel(segaGubben(undefined, share), OPTS);
      const notes = trendNotes(m.trend.day, "day", share, {
        profitOre: m.totals.profitOre,
        marginBp: m.totals.marginBp,
      }).join(" ");
      const kpiProfit = m.kpis.find((k) => k.id === "profit")!;
      const kpiMargin = m.kpis.find((k) => k.id === "margin")!;
      expect(notes).toContain(`${kpiProfit.label} ${formatSek(m.totals.profitOre / 100)}`);
      expect(notes).toContain(
        `${kpiMargin.label.toLowerCase()} ${formatPercent((m.totals.marginBp ?? 0) / 10_000)}`,
      );
      expect(notes).toMatch(share ? /efter butikernas andel/ : /före butikernas andel/);
    }
  });

  it("marginalen vid sista stapeln säger vilken dag den gäller (inte periodens marginal)", () => {
    expect(
      marginMarkerText({
        axis: "6 nov",
        name: "tor 6 nov.",
        profit: 100,
        margin: 0.11,
        revenue: 900,
        orders: 3,
      }),
    ).toBe("6 nov: 11,0\u00a0%");
  });

  it("uppdelningen av andelen heter som nyckeltalet, inte Butiksersättning", () => {
    const on = buildLonsamhetModel(segaGubben(undefined, true), OPTS);
    expect(compensationBreakdownLabel(on.bridge)).toBe("Butikernas andel");
    const one = buildLonsamhetModel(segaGubben({ storeId: "s1", machineId: null }, true), OPTS);
    expect(compensationBreakdownLabel(one.bridge)).toBe("Butikens andel");
  });
});
