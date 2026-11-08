import { describe, expect, it } from "vitest";

import {
  MYSTERY_HREF,
  REFILL_HREF,
  SALES_HREF,
  simpleHomeFor,
  simpleTabsFor,
  simpleViewAllows,
} from "./simple-view";

describe("Enkel vy: tillåtna sökvägar", () => {
  it.each([
    "/",
    "/forsaljning",
    "/fyll-pa",
    "/fyll-pa/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f",
    "/fyll-pa/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f/qr",
    "/vart-lager/mystery",
    "/vart-lager/mystery/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f",
    "/vart-lager/mystery/",
    "/logga-in",
    "/inbjudan/abc",
  ])("släpper igenom %s", (path) => {
    expect(simpleViewAllows(path)).toBe(true);
  });

  it.each([
    "//",
    "/?",
    "/lonsamhet",
    "/installningar",
    "/installningar/anvandare",
    "/installningar/konto",
    "/vart-lager",
    "/vart-lager/flytta",
    "/vart-lager/mysteryx",
    "/forsaljningar",
    "/fyll-pax",
    "/att-gora",
    "/drift",
    "/assistent",
    "/sok",
    "/order",
    "/installningar/export",
    "/fyll-pa/../lonsamhet",
    "/vart-lager/mystery/../../installningar",
    "fyll-pa",
    "",
    "/fyll-pa\\..\\installningar",
  ])("stoppar %s", (path) => {
    expect(simpleViewAllows(path)).toBe(false);
  });
});

describe("Enkel vy: flikar och startsida", () => {
  it("ägaren ser Fyll på, Försäljning och Mystery i den ordningen", () => {
    expect(simpleTabsFor("owner").map((t) => t.href)).toEqual([
      REFILL_HREF,
      SALES_HREF,
      MYSTERY_HREF,
    ]);
    expect(simpleHomeFor("owner")).toBe(SALES_HREF);
    expect(SALES_HREF).toBe("/");
  });

  it("påfyllaren ser ingen försäljning och börjar på Fyll på", () => {
    expect(simpleTabsFor("refiller").map((t) => t.id)).toEqual(["refill", "mystery"]);
    expect(simpleHomeFor("refiller")).toBe(REFILL_HREF);
  });

  it("läsaren fyller inte på", () => {
    expect(simpleTabsFor("viewer").map((t) => t.id)).toEqual(["sales", "mystery"]);
    expect(simpleHomeFor("viewer")).toBe(SALES_HREF);
  });

  it("varje flik och startsida är själv tillåten", () => {
    for (const role of ["owner", "admin", "refiller", "viewer"] as const) {
      expect(simpleViewAllows(simpleHomeFor(role))).toBe(true);
      for (const tab of simpleTabsFor(role)) expect(simpleViewAllows(tab.href)).toBe(true);
    }
  });
});
