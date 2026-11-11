import { describe, expect, it } from "vitest";

import {
  CONTRACT_NOT_SIGNED,
  placementAgreementWarning,
  placementContractWarning,
} from "./placement-warning";

const plain = (t: string | null) => t?.replace(/ /g, " ") ?? null;

describe("placementAgreementWarning (placera/flytta automat)", () => {
  const deal = {
    storeId: "s1",
    validFrom: "2026-11-10",
    validTo: null,
    commissionBp: 1_000,
    monthlyRentOre: 50_000,
  };
  const kiosk = { id: "s1", name: "Kiosken", agreements: [deal] };

  it("butik utan avtal: varnar att den räknas som 0 %", () => {
    expect(
      plain(placementAgreementWarning({ id: "s3", name: "Hörnan", agreements: [] }, "2026-11-08")),
    ).toBe("Hörnan har inget avtal – butiken räknas som 0 %.");
  });

  it("avtalet börjar senare: 0 % tills det börjar; avtal den dagen: ingen varning", () => {
    expect(plain(placementAgreementWarning(kiosk, "2026-11-08"))).toBe(
      "Kiosken har inget avtal från den dagen än. Butiken räknas som 0 % tills avtalet börjar.",
    );
    expect(placementAgreementWarning(kiosk, "2026-11-10")).toBeNull();
  });

  it("okända avtal, ingen butik eller ogiltigt datum: ingen varning", () => {
    expect(placementAgreementWarning({ id: "s1", name: "Kiosken" }, "2026-11-08")).toBeNull();
    expect(placementAgreementWarning(undefined, "2026-11-08")).toBeNull();
    expect(placementAgreementWarning(kiosk, "")).toBeNull();
  });
});

describe("placementContractWarning (kontraktet när automaten placeras)", () => {
  it("osignerat eller inget kontrakt: en rad som inte stoppar placeringen", () => {
    for (const contract of ["unsigned", "missing"] as const) {
      expect(placementContractWarning({ id: "s1", name: "Kiosken", contract })).toBe(
        "Kontraktet är inte signerat. Signera först eller placera ändå.",
      );
    }
    expect(CONTRACT_NOT_SIGNED).toContain("placera ändå");
  });

  it("signerat, okänt eller ingen butik vald: ingen rad", () => {
    expect(placementContractWarning({ id: "s1", name: "Kiosken", contract: "signed" })).toBeNull();
    expect(placementContractWarning({ id: "s1", name: "Kiosken" })).toBeNull();
    expect(placementContractWarning(undefined)).toBeNull();
  });
});
