import { describe, expect, it } from "vitest";

import {
  agreementFields,
  connectSchema,
  guideSchema,
  machineName,
  newMachineKey,
  startDate,
} from "./plan";

const ID = "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";

describe("nya automater: regler", () => {
  it("nyckeln följer Att görans form", () => {
    expect(newMachineKey(ID)).toMatch(/^[a-z][a-z-]*:[^\s]+$/);
  });

  it("driftstart = första orderns dag, högst i dag", () => {
    expect(startDate("2026-10-20", "2026-11-03")).toBe("2026-10-20");
    expect(startDate("2026-11-09", "2026-11-03")).toBe("2026-11-03");
    expect(startDate(null, "2026-11-03")).toBe("2026-11-03");
    expect(startDate("fel", "2026-11-03")).toBe("2026-11-03");
  });

  it("namnet: valt, annars Awish, annars maskinnumret", () => {
    expect(machineName("Hörnet", { name: "Awish 1", deviceNo: "77" }, "BL-004")).toBe("Hörnet");
    expect(machineName(null, { name: " Awish 1 ", deviceNo: "77" }, "BL-004")).toBe("Awish 1");
    expect(machineName(null, { name: null, deviceNo: "77" }, "BL-004")).toBe("Automat 77");
    expect(machineName(null, { name: "", deviceNo: null }, "BL-004")).toBe("Automat BL-004");
  });

  it("koden normaliseras och valideras", () => {
    expect(connectSchema.parse({ sourceMachineId: ID, storeId: ID, code: " bl-9 " }).code).toBe(
      "BL-9",
    );
    expect(
      connectSchema.safeParse({ sourceMachineId: ID, storeId: ID, code: "BL 9" }).success,
    ).toBe(false);
    expect(connectSchema.safeParse({ sourceMachineId: "x", storeId: ID }).success).toBe(false);
  });
});

describe("guiden: villkor", () => {
  it("50/50 vinst är standard", () => {
    expect(agreementFields({ preset: "split" })).toEqual({
      model: "split",
      commission: "50",
      rent: "",
    });
    expect(agreementFields({ preset: "split", share: "40" }).commission).toBe("40");
  });

  it("procent av omsättning och fast hyra", () => {
    expect(agreementFields({ preset: "sales", share: "12,5" })).toEqual({
      model: "sales",
      commission: "12,5",
      rent: "",
    });
    expect(agreementFields({ preset: "rent", share: "50", rent: "750" })).toEqual({
      model: "sales",
      commission: "",
      rent: "750",
    });
  });

  it("schemat tar emot automat från Awish, ny automat eller ingen", () => {
    const base = { store: { name: "ICA" }, terms: { preset: "split" } };
    expect(guideSchema.safeParse({ ...base, machine: null }).success).toBe(true);
    expect(
      guideSchema.safeParse({ ...base, machine: { kind: "awish", sourceMachineId: ID } }).success,
    ).toBe(true);
    expect(guideSchema.safeParse({ ...base, machine: { kind: "new" } }).success).toBe(true);
    expect(
      guideSchema.safeParse({ ...base, terms: { preset: "fel" }, machine: null }).success,
    ).toBe(false);
  });
});
