import { describe, expect, it } from "vitest";

import {
  baselineSchema,
  effectSettingsSchema,
  goalSchema,
  investmentSchema,
  leadSchema,
  measurementSchema,
  parseHundredths,
  parseSignedOre,
} from "./schemas";

const UUID = "6178a492-31f6-4a5b-a7d0-ad92e1859ce5";

describe("tal ur text", () => {
  it("hundradelar utan flyttal", () => {
    expect(parseHundredths("12,5")).toBe(1250);
    expect(parseHundredths("0.25")).toBe(25);
    expect(parseHundredths("1 000")).toBe(100_000);
    expect(parseHundredths("3")).toBe(300);
    expect(parseHundredths("1,234")).toBeNull();
    expect(parseHundredths("-1")).toBeNull();
    expect(parseHundredths("abc")).toBeNull();
  });

  it("kronor med tecken", () => {
    expect(parseSignedOre("5")).toBe(500);
    expect(parseSignedOre("+10,50")).toBe(1050);
    expect(parseSignedOre("−2,50")).toBe(-250);
    expect(parseSignedOre("-5 kr")).toBe(-500);
    expect(parseSignedOre("x")).toBeNull();
  });
});

describe("formulär", () => {
  it("investering: kronor till öre, tom avskrivning blir null", () => {
    expect(
      investmentSchema.parse({
        machineId: UUID,
        kind: "installation",
        amountOre: "2 500",
        investedOn: "2026-09-30",
        depreciationMonths: "",
        note: " ",
      }),
    ).toEqual({
      id: null,
      machineId: UUID,
      kind: "installation",
      amountOre: 250_000,
      investedOn: "2026-09-30",
      depreciationMonths: null,
      note: null,
    });
  });

  it("investering: fel visas vid fältet", () => {
    const r = investmentSchema.safeParse({
      machineId: UUID,
      kind: "purchase",
      amountOre: "-5",
      investedOn: "30/9",
      depreciationMonths: "0",
    });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["amountOre", "investedOn", "depreciationMonths"]),
    );
  });

  it("mål: butik krävs för omfattningen butik", () => {
    const r = goalSchema.safeParse({
      month: "2026-11",
      metric: "profit",
      target: "1000",
      scope: "store",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["storeId"]);
  });

  it("lead: procent till bp, tomma fält blir null", () => {
    const v = leadSchema.parse({
      name: " Ny ",
      stage: "contacted",
      commissionBp: "12,5",
      areaSqm: "",
    });
    expect(v).toMatchObject({
      name: "Ny",
      stage: "contacted",
      commissionBp: 1250,
      areaSqm: null,
      storeId: null,
    });
  });

  it("utgångsläge och mätvärden i rätt enhet", () => {
    expect(
      baselineSchema.parse({ metric: "admin_hours_month", value: "1,5", scope: "organization" }),
    ).toMatchObject({
      value: 90,
      unit: "minutes",
    });
    expect(
      baselineSchema.parse({
        metric: "profit_per_machine_month",
        value: "−200",
        scope: "organization",
      }).value,
    ).toBe(-20_000);
    expect(
      baselineSchema.parse({ metric: "stockout_days_month", value: "4", scope: "organization" })
        .unit,
    ).toBe("days");
    expect(
      baselineSchema.safeParse({
        metric: "stockout_days_month",
        value: "4,5",
        scope: "organization",
      }).success,
    ).toBe(false);
    expect(
      baselineSchema.safeParse({
        metric: "admin_hours_month",
        value: "2",
        scope: "organization",
        measuredFrom: "2026-08-01",
        measuredTo: "2026-07-01",
      }).success,
    ).toBe(false);
    expect(
      measurementSchema.parse({
        metric: "refill_hours_month",
        month: "2026-10",
        value: "0,33",
        scope: "organization",
      }).value,
    ).toBe(20); // 0,33 h = 19,8 min → 20
  });

  it("timkostnad: tomt fält är null", () => {
    expect(effectSettingsSchema.parse({ hourlyCostOre: "350", stockoutDayValueOre: "" })).toEqual({
      hourlyCostOre: 35_000,
      stockoutDayValueOre: null,
    });
  });
});
