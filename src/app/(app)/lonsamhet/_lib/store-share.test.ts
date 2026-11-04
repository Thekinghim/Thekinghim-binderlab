/**
 * Lönsamhet leder med vår vinst; butikernas andel visas bara på begäran (?andel=1) eller
 * med vald butik. Vår vinst är densamma i båda lägena (andelen dras alltid).
 */
import { describe, expect, it } from "vitest";

import type { ProfitabilityInput } from "@/domain";

import { bridgeSteps, FEES_AND_STORES_LABEL } from "../_components/bridge";
import { columnsFor } from "../_components/profit-table";
import { lonsamhetHeadline } from "./headline";
import { buildLonsamhetModel, type LonsamhetInput } from "./model";

const PERIOD = { start: "2026-10-14", end: "2026-11-03" };

/** Sega gubben: 50 % av vinsten, kortavgift 2,5 %, ingen hyra. */
function segaGubben(scope = { storeId: null as string | null, machineId: null as string | null }) {
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
    settings: { vatRateBp: 0, cardFeeBp: 250 },
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

describe("Lönsamhet: butikernas andel på begäran", () => {
  it("visar vår vinst utan nyckeltal, steg eller kolumn för butikens andel som standard", () => {
    const m = buildLonsamhetModel(segaGubben(), OPTS);
    expect(m.showStoreShare).toBe(false);
    expect(m.totals.compensationOre).toBeGreaterThan(0);
    expect(m.kpis.map((k) => k.id)).toEqual(["profit", "margin", "revenue", "orders"]);
    expect(m.kpis[0]).toMatchObject({ label: "Vår vinst", value: m.totals.profitOre });
    expect(m.kpis[1]?.label).toBe("Vår marginal");
    // Vattenfallet: andelen ligger i avgiftssteget, så att stegen ändå blir vår vinst.
    const steps = bridgeSteps(m.bridge);
    expect(steps.storeShareOre).toBeNull();
    expect(steps.feesLabel).toBe(FEES_AND_STORES_LABEL);
    const b = m.bridge;
    expect(b.revenueOre - b.costOre - steps.feesOre).toBe(b.profitOre);
    // Tabellen: ingen kolumn för andelen; vinsten heter Vår vinst.
    const cols = columnsFor("title", m.views.title, m.totals, false, null, m.showStoreShare);
    expect(cols.map((c) => c.key)).not.toContain("compensation");
    expect(cols.find((c) => c.key === "profit")?.header).toBe("Vår vinst");
  });

  it("visar andelen med vyknappen, och vår vinst är densamma", () => {
    const off = buildLonsamhetModel(segaGubben(), OPTS);
    const on = buildLonsamhetModel(segaGubben(), { ...OPTS, showStoreShare: true });
    expect(on.showStoreShare).toBe(true);
    expect(on.totals.profitOre).toBe(off.totals.profitOre);
    expect(on.kpis.find((k) => k.id === "compensation")).toMatchObject({
      label: "Butikernas andel",
      value: on.totals.compensationOre,
    });
    const steps = bridgeSteps(on.bridge);
    expect(steps).toEqual({
      feesOre: on.bridge.feesOre,
      storeShareOre: on.bridge.compensationOre,
      feesLabel: "Avgifter",
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
  });

  it("visar butikens andel när en butik är vald, utan vyknappen", () => {
    const m = buildLonsamhetModel(segaGubben({ storeId: "s1", machineId: null }), OPTS);
    expect(m.showStoreShare).toBe(true);
    expect(m.bridge.storeShareLabel).toBe("Butikens andel");
    expect(m.kpis.find((k) => k.id === "compensation")?.label).toBe("Butikens andel");
  });

  it("nämner inte butikernas andel för sig i förlustrubriken utan vyknappen", () => {
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
    expect(lonsamhetHeadline({ ...base, showStoreShare: false }).aside).toMatch(
      /^Avgifterna och butikerna tog/,
    );
  });
});
