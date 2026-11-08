import { describe, expect, it } from "vitest";

import { noAgreementLine, settlementIdleHeadline } from "./settlement-headline";

describe("settlementIdleHeadline (Utbetalning utan något att betala)", () => {
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

describe("noAgreementLine (butik utan avtal i avräkningsmånaden)", () => {
  const plain = (t: string) => t.replace(/\u00a0/g, " ");
  it("hela månaden: 0 kr; några dagar: 0 % de dagarna", () => {
    expect(plain(noAgreementLine({ storeName: "Hörnan", days: 31, whole: true }))).toBe(
      "Hörnan: inget avtal – får 0 kr.",
    );
    expect(plain(noAgreementLine({ storeName: "Hörnan", days: 3, whole: false }))).toBe(
      "Hörnan: inget avtal 3 dagar – 0 % de dagarna.",
    );
    expect(plain(noAgreementLine({ storeName: "Hörnan", days: 1, whole: false }))).toBe(
      "Hörnan: inget avtal 1 dag – 0 % de dagarna.",
    );
  });
});
