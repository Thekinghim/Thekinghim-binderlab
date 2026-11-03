import { describe, expect, it } from "vitest";

import {
  contractInForce,
  isSigned,
  signedCount,
  storeContractState,
  storeContractStates,
  type SignableContract,
} from "./signed";

const TODAY = "2026-11-03";

function c(p: Partial<SignableContract> & { id: string; storeId: string }): SignableContract {
  return { validFrom: "2026-10-01", validTo: null, ...p };
}

describe("kontrakt per butik", () => {
  it("signerat: mallen med signed_at, eller registrerat för hand", () => {
    expect(isSigned(c({ id: "a", storeId: "s", template: "placering-vinstdelning-v1" }))).toBe(
      false,
    );
    expect(
      isSigned(
        c({
          id: "a",
          storeId: "s",
          template: "placering-vinstdelning-v1",
          signedAt: "2026-11-01T10:00:00Z",
        }),
      ),
    ).toBe(true);
    expect(isSigned(c({ id: "a", storeId: "s", template: null }))).toBe(true);
    expect(isSigned(c({ id: "a", storeId: "s" }))).toBe(true);
  });

  it("utgånget räknas inte; ett som börjar senare gör det", () => {
    expect(contractInForce(c({ id: "a", storeId: "s", validTo: "2026-10-31" }), TODAY)).toBe(false);
    expect(contractInForce(c({ id: "a", storeId: "s", validFrom: "2026-12-01" }), TODAY)).toBe(
      true,
    );
    // Förlängs automatiskt: gäller fortfarande.
    expect(
      contractInForce(
        c({
          id: "a",
          storeId: "s",
          validFrom: "2026-01-01",
          validTo: "2026-06-30",
          renewalMonths: 12,
        }),
        TODAY,
      ),
    ).toBe(true);
  });

  it("läget per butik: signerat, osignerat eller saknas", () => {
    const list = [
      c({ id: "1", storeId: "a", template: "t", signedAt: "2026-11-01T10:00:00Z" }),
      c({ id: "2", storeId: "b", template: "t", sentAt: "2026-11-01T10:00:00Z" }),
      c({ id: "3", storeId: "c", validTo: "2026-10-01" }),
      // Ett osignerat utkast bredvid ett signerat: butiken har signerat.
      c({ id: "4", storeId: "a", template: "t" }),
    ];
    expect(storeContractState(list, "a", TODAY)).toBe("signed");
    expect(storeContractState(list, "b", TODAY)).toBe("unsigned");
    expect(storeContractState(list, "c", TODAY)).toBe("missing");
    expect(storeContractState(list, "d", TODAY)).toBe("missing");
    const states = storeContractStates(list, ["a", "b", "c", "d"], TODAY);
    // Bara butiker med automat räknas; utan automater alla.
    expect(signedCount(states, new Set(["a", "b"]))).toEqual({ signed: 1, total: 2 });
    expect(signedCount(states, new Set())).toEqual({ signed: 1, total: 4 });
  });
});
