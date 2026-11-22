import { describe, expect, it } from "vitest";

import { portalContractStatus } from "./contract-status";

const plain = (s: string) => s.replace(/[ ⁠]/g, " ");
const base = { terminatedOn: null, signedAt: null, signerName: null, signed: false };

describe("portalContractStatus (portalens Avräkning)", () => {
  it("registrerat för hand: Signerat, som på ägarens Kontrakt (demons Bio Fyren)", () => {
    expect(portalContractStatus({ ...base, signed: true })).toBe("Signerat");
  });

  it("utkast eller skickat från mallen: inte signerat än", () => {
    expect(portalContractStatus(base)).toBe("Inte signerat än");
  });

  it("signerat med datum och namn", () => {
    expect(
      plain(
        portalContractStatus({
          ...base,
          signed: true,
          signedAt: "2026-11-03T10:00:00.000Z",
          signerName: "Butikens firmatecknare",
        }),
      ),
    ).toMatch(/^Signerat 3 nov\.? 2026 av Butikens firmatecknare$/);
  });

  it("uppsagt går före", () => {
    expect(
      plain(portalContractStatus({ ...base, signed: true, terminatedOn: "2027-02-28" })),
    ).toMatch(/^Uppsagt, slutar 28 feb\.? 2027$/);
  });
});
