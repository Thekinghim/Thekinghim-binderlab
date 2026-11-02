import { describe, expect, it } from "vitest";

import { homeHref, roleLabel, routesForRole, shellRoutes } from "@/components/shell/nav";
import { buildStoreReport } from "@/reports";

import { FAULT_KINDS, faultStatus, isFaultKind } from "./faults";
import {
  buildPortalOverview,
  firstPortalMonth,
  machinesInStoreToday,
  monthsBetween,
  portalSources,
  resolvePortalMonth,
  salesWindow,
  todayIn,
  unmappedTitleId,
  type PortalAgreementRow,
  type PortalMachineRow,
  type PortalSaleRow,
} from "./model";

const STORE = { storeId: "s1", storeName: "ICA Nära", vatRateBp: 0 };
const MACHINES: PortalMachineRow[] = [
  { machineId: "m1", code: "BL-001", name: "Entré", placedFrom: "2026-08-15", placedTo: null },
  {
    machineId: "m2",
    code: "BL-002",
    name: "Kassa",
    placedFrom: "2026-09-01",
    placedTo: "2026-10-10",
  },
];
const AGREEMENTS: PortalAgreementRow[] = [
  { validFrom: "2026-08-01", validTo: null, commissionBp: 1000, monthlyRentOre: 31_000 },
];
const SALES: PortalSaleRow[] = [
  {
    businessDate: "2026-09-02",
    machineId: "m1",
    titleId: "t1",
    titleName: "151",
    amountOre: 4900,
    orderCount: 3,
  },
  {
    businessDate: "2026-09-03",
    machineId: "m2",
    titleId: "t2",
    titleName: "Sparks",
    amountOre: 5900,
    orderCount: 1,
  },
  {
    businessDate: "2026-10-05",
    machineId: "m1",
    titleId: "t1",
    titleName: "151",
    amountOre: 4900,
    orderCount: 2,
  },
  {
    businessDate: "2026-10-06",
    machineId: "m2",
    titleId: null,
    titleName: "Okänd källtitel",
    amountOre: 12900,
    orderCount: 1,
  },
];

describe("portalSources", () => {
  const sources = portalSources(STORE, SALES, AGREEMENTS, MACHINES);

  it("blir en order per sålt pack, med samma belopp", () => {
    expect(sources.orders).toHaveLength(7);
    expect(sources.orders.reduce((s, o) => s + o.amountOre, 0)).toBe(
      3 * 4900 + 5900 + 2 * 4900 + 12900,
    );
    expect(new Set(sources.orders.map((o) => o.id)).size).toBe(7);
  });

  it("har inga inköpspriser och ingen kortavgift", () => {
    expect(sources.prices).toEqual([]);
    expect(sources.settings).toEqual({ vatRateBp: 0, cardFeeBp: 0 });
  });

  it("order utan titel får källans namn som titel", () => {
    expect(sources.titles).toContainEqual({
      id: unmappedTitleId("Okänd källtitel"),
      name: "Okänd källtitel",
    });
  });

  it("avtal och placeringar gäller butiken", () => {
    expect(sources.agreements.every((a) => a.storeId === "s1")).toBe(true);
    expect(sources.placements.map((p) => [p.machineId, p.storeId, p.from, p.to])).toEqual([
      ["m1", "s1", "2026-08-15", null],
      ["m2", "s1", "2026-09-01", "2026-10-10"],
    ]);
  });

  it("ger samma ersättning som om orderna räknades en och en (provision per order)", () => {
    const report = buildStoreReport(sources, "s1", "2026-09");
    // 10 % av 4 900 = 490 per order × 3, 10 % av 5 900 = 590; hyra hel månad 310 kr.
    expect(report.compensation.commissionOre).toBe(3 * 490 + 590);
    expect(report.compensation.rentOre).toBe(31_000);
    expect(report.sales.revenueOre).toBe(3 * 4900 + 5900);
  });
});

describe("månader", () => {
  it("todayIn ger datumet i tidszonen", () => {
    const now = new Date("2026-10-31T23:30:00Z");
    expect(todayIn("Europe/Stockholm", now)).toBe("2026-11-01");
    expect(todayIn("UTC", now)).toBe("2026-10-31");
  });

  it("första månaden är första placering eller försäljning", () => {
    expect(firstPortalMonth(MACHINES, "2026-09-02", "2026-11-02")).toBe("2026-08");
    expect(firstPortalMonth([], "2026-09-02", "2026-11-02")).toBe("2026-09");
    expect(firstPortalMonth([], null, "2026-11-02")).toBe("2026-11");
  });

  it("vald månad begränsas till [första, innevarande] och ogiltigt blir innevarande", () => {
    expect(resolvePortalMonth(undefined, "2026-08", "2026-11")).toBe("2026-11");
    expect(resolvePortalMonth("2026-09", "2026-08", "2026-11")).toBe("2026-09");
    expect(resolvePortalMonth("2027-01", "2026-08", "2026-11")).toBe("2026-11");
    expect(resolvePortalMonth("2020-01", "2026-08", "2026-11")).toBe("2026-08");
    expect(resolvePortalMonth("2026-13", "2026-08", "2026-11")).toBe("2026-11");
    expect(resolvePortalMonth("'; drop", "2026-08", "2026-11")).toBe("2026-11");
  });

  it("monthsBetween ger senaste först", () => {
    expect(monthsBetween("2026-10", "2027-01")).toEqual([
      "2027-01",
      "2026-12",
      "2026-11",
      "2026-10",
    ]);
  });

  it("hämtningsfönstret täcker trenden och jämförelsemånaden", () => {
    expect(salesWindow("2026-11", "2026-08")).toEqual({ start: "2026-08-01", end: "2026-11-30" });
    expect(salesWindow("2027-12", "2020-01")).toEqual({ start: "2026-12-01", end: "2027-12-31" });
  });
});

describe("buildPortalOverview", () => {
  const sources = portalSources(STORE, SALES, AGREEMENTS, MACHINES);

  it("trenden räknar varje månad med rapportberäkningen och markerar pågående månad", () => {
    const o = buildPortalOverview(sources, "s1", "2026-10", "2026-08", "2026-10-20");
    expect(o.partial).toBe(true);
    expect(o.trend.map((t) => t.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(o.trend.map((t) => t.partial)).toEqual([false, false, true]);
    const sep = buildStoreReport(sources, "s1", "2026-09");
    expect(o.trend[1]).toMatchObject({
      revenueOre: sep.sales.revenueOre,
      orders: sep.sales.orders,
      compensationOre: sep.compensation.totalOre,
    });
    expect(o.trendTotals.months).toBe(2);
  });

  it("pågående månad räknar dagar i butiken bara till och med i dag", () => {
    const o = buildPortalOverview(sources, "s1", "2026-10", "2026-08", "2026-10-20");
    // m1 hela oktober hittills (1–20), m2 till och med 10 oktober
    expect(o.placedDaysSoFar).toEqual({ m1: 20, m2: 10 });
    const m1 = o.report.machines.find((m) => m.machineId === "m1")!;
    expect(m1.placedDays).toBe(31);
    const full = buildPortalOverview(sources, "s1", "2026-09", "2026-08", "2026-10-20");
    expect(full.placedDaysSoFar).toEqual(
      Object.fromEntries(full.report.machines.map((m) => [m.machineId, m.placedDays])),
    );
  });

  it("innehåller aldrig inköp, marginal eller vinst", () => {
    const o = buildPortalOverview(sources, "s1", "2026-09", "2026-08", "2026-11-02");
    expect(JSON.stringify(o)).not.toMatch(/cost|margin|profit|purchase|inköp|vinst/i);
  });
});

describe("felanmälan", () => {
  it("bara kända typer", () => {
    expect(FAULT_KINDS.every((k) => k.startsWith("store_"))).toBe(true);
    expect(isFaultKind("store_other")).toBe(true);
    expect(isFaultKind("coin_jam")).toBe(false);
  });

  it("status ur ärendet, annars ur åtgärdsdatumet", () => {
    expect(faultStatus("in_progress", null)).toBe("in_progress");
    expect(faultStatus(null, "2026-11-01T10:00:00Z")).toBe("resolved");
    expect(faultStatus(undefined, null)).toBe("open");
  });

  it("bara automater som står i butiken i dag kan felanmälas", () => {
    expect(machinesInStoreToday(MACHINES, "2026-10-10").map((m) => m.code)).toEqual([
      "BL-001",
      "BL-002",
    ]);
    expect(machinesInStoreToday(MACHINES, "2026-10-11").map((m) => m.code)).toEqual(["BL-001"]);
  });
});

describe("rollen store i skalet", () => {
  it("ser inga appmenyer och har portalen som startsida", () => {
    expect(routesForRole("store")).toEqual([]);
    expect(shellRoutes.some((r) => r.roles.includes("store"))).toBe(false);
    expect(homeHref("store")).toBe("/portal");
    expect(roleLabel.store).toBe("Butik");
  });
});
