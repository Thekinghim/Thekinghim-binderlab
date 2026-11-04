import { describe, expect, it } from "vitest";

import { settlementIdleHeadline } from "./settlement-headline";

describe("settlementIdleHeadline (Butiksportal utan något att betala)", () => {
  const base = { blocked: 0, failed: 0, missing: 0, monthLabel: "oktober 2026" };

  it("en butik vars avräkning inte kan skapas har inte fått betalt (inte 'Allt är betalt.')", () => {
    const h = settlementIdleHeadline({ ...base, failed: 1 });
    expect(h.title).toBe("Inte klart än.");
    expect(h.aside).toBe("1 avräkning kan inte räknas än.");
  });

  it("spärrade och saknade räknas ihop; saknade som kan skapas ger Skapa", () => {
    expect(settlementIdleHeadline({ ...base, blocked: 1, failed: 1 }).aside).toBe(
      "2 avräkningar kan inte räknas än.",
    );
    expect(settlementIdleHeadline({ ...base, missing: 1 })).toEqual({
      title: "Inte avräknat än.",
      aside: "Skapa avräkningarna för oktober 2026.",
    });
    expect(settlementIdleHeadline(base).title).toBe("Allt är betalt.");
  });
});
