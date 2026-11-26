import { describe, expect, it } from "vitest";

import type { RecipientRow } from "@/server/payouts/balances";

import { missingSettlementsText, payoutPayCard } from "./pay-card-model";

function row(key: string, kind: RecipientRow["kind"], leftOre: number): RecipientRow {
  return {
    key,
    kind,
    name: key,
    orgNumber: null,
    bankgiro: null,
    leftOre,
    paidOre: 0,
    lineIds: [`${key}-1`],
    oldestPaidOn: null,
    periodTexts: [],
    partnerParts: null,
  };
}

describe("payoutPayCard (Att betala på Pengar = Utbetalningar)", () => {
  // Läget ägaren såg: inga obetalda avräkningar, men utbetalningarna har pengar kvar att betala.
  const recipients = [
    row("store:a", "store", 12_345_600),
    row("partner", "partner", 9_876_543),
    row("vat_reserve", "vat_reserve", 2_521_957),
    row("store:b", "store", 0),
  ];
  const toPayOre = recipients.reduce((a, r) => a + r.leftOre, 0);

  it("summan är sidans 'Att betala just nu', inte avräkningarnas", () => {
    const card = payoutPayCard({ recipients, toPayOre });
    expect(card.totalOre).toBe(toPayOre);
    expect(card.totalOre).toBe(24_744_100);
    expect(card.rows.reduce((a, r) => a + r.leftOre, 0)).toBe(card.totalOre);
  });

  it("visar bara mottagare med något kvar, i Utbetalningars ordning", () => {
    const card = payoutPayCard({ recipients, toPayOre });
    expect(card.rows.map((r) => r.key)).toEqual(["store:a", "partner", "vat_reserve"]);
    expect(card.rows[0]!.lineIds).toEqual(["store:a-1"]);
  });

  it("allt betalt: inga rader och 0 kr", () => {
    expect(payoutPayCard({ recipients: [], toPayOre: 0 })).toEqual({ rows: [], totalOre: 0 });
  });
});

describe("missingSettlementsText", () => {
  it("en butik, flera butiker, flera månader, inget", () => {
    expect(missingSettlementsText([{ storeName: "Bio Ett", month: "2026-10" }])).toBe(
      "Bio Ett saknar avräkning för oktober.",
    );
    expect(
      missingSettlementsText([
        { storeName: "Bio Ett", month: "2026-10" },
        { storeName: "Kafé Två", month: "2026-10" },
      ]),
    ).toBe("2 butiker saknar avräkning för oktober.");
    expect(
      missingSettlementsText([
        { storeName: "Bio Ett", month: "2026-09" },
        { storeName: "Kafé Två", month: "2026-10" },
      ]),
    ).toBe("2 butiker saknar avräkning.");
    expect(missingSettlementsText([])).toBeNull();
  });
});
