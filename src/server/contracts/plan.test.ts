import { describe, expect, it } from "vitest";

import { backdatedFrom, contractStatus, planContractAgreement, suggestContractStart } from "./plan";

describe("planContractAgreement", () => {
  it("nytt villkor när butiken saknar villkor", () => {
    expect(planContractAgreement([], "2026-11-03")).toEqual({ kind: "insert", close: null });
  });

  it("avslutar villkor som gäller tills vidare dagen före", () => {
    expect(
      planContractAgreement([{ id: "a", validFrom: "2026-01-01", validTo: null }], "2026-11-03"),
    ).toEqual({ kind: "insert", close: { id: "a", validTo: "2026-11-02" } });
  });

  it("skriver om villkor som börjar samma dag", () => {
    expect(
      planContractAgreement([{ id: "a", validFrom: "2026-11-03", validTo: null }], "2026-11-03"),
    ).toEqual({ kind: "update", id: "a" });
  });

  it("ignorerar villkor som redan har slutat", () => {
    expect(
      planContractAgreement(
        [
          { id: "old", validFrom: "2025-01-01", validTo: "2025-12-31" },
          { id: "a", validFrom: "2026-01-01", validTo: null },
        ],
        "2026-11-03",
      ),
    ).toEqual({ kind: "insert", close: { id: "a", validTo: "2026-11-02" } });
  });

  it("krock med villkor som börjar senare eller har egen slutdag efter starten", () => {
    expect(
      planContractAgreement([{ id: "a", validFrom: "2026-12-01", validTo: null }], "2026-11-03"),
    ).toEqual({ kind: "conflict", validFrom: "2026-12-01" });
    expect(
      planContractAgreement(
        [{ id: "a", validFrom: "2026-01-01", validTo: "2026-12-31" }],
        "2026-11-03",
      ),
    ).toEqual({ kind: "conflict", validFrom: "2026-01-01" });
  });
});

describe("status", () => {
  it("utkast, skickat, signerat; null för avtal registrerade för hand", () => {
    const t = "placering-vinstdelning-v1";
    expect(contractStatus({ template: null, sentAt: null, signedAt: null })).toBeNull();
    expect(contractStatus({ template: t, sentAt: null, signedAt: null })).toBe("draft");
    expect(contractStatus({ template: t, sentAt: new Date(), signedAt: null })).toBe("sent");
    expect(contractStatus({ template: t, sentAt: null, signedAt: new Date() })).toBe("signed");
  });

  it("bakåtdaterat bara före i dag", () => {
    expect(backdatedFrom("2026-11-03", "2026-11-03")).toBeNull();
    expect(backdatedFrom("2026-11-01", "2026-11-03")).toBe("2026-11-01");
  });
});

describe("suggestContractStart", () => {
  const base = {
    today: "2026-11-03",
    openTermsFrom: null,
    closedUntil: null,
    firstSale: null,
    firstPlacement: null,
  } as const;

  it("Sega gubben: öppna villkor från 14 okt. ger kontrakt från 14 okt., inte i dag", () => {
    const start = suggestContractStart({
      ...base,
      openTermsFrom: "2026-10-14",
      firstSale: "2026-10-14",
      firstPlacement: "2026-10-14",
    });
    expect(start).toBe("2026-10-14");
    // Och det krockar inte: villkoren skrivs om från början i stället för att avslutas 2 nov.
    expect(
      planContractAgreement([{ id: "a", validFrom: "2026-10-14", validTo: null }], start),
    ).toEqual({ kind: "update", id: "a" });
  });

  it("utan villkor: första försäljningen (eller placeringen om den är tidigare)", () => {
    expect(suggestContractStart({ ...base, firstSale: "2026-10-15" })).toBe("2026-10-15");
    expect(
      suggestContractStart({ ...base, firstSale: "2026-10-15", firstPlacement: "2026-10-12" }),
    ).toBe("2026-10-12");
  });

  it("aldrig före dagen efter avslutade villkor", () => {
    const start = suggestContractStart({
      ...base,
      firstSale: "2026-10-14",
      closedUntil: "2026-11-02",
    });
    expect(start).toBe("2026-11-03");
    expect(
      planContractAgreement([{ id: "a", validFrom: "2026-10-14", validTo: "2026-11-02" }], start),
    ).toEqual({ kind: "insert", close: null });
  });

  it("ingen försäljning: i dag; aldrig efter i dag", () => {
    expect(suggestContractStart(base)).toBe("2026-11-03");
    expect(suggestContractStart({ ...base, firstPlacement: "2026-12-01" })).toBe("2026-11-03");
  });
});
