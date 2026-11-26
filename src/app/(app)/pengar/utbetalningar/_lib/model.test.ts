import { describe, expect, it } from "vitest";

import {
  countedRows,
  oreToField,
  parseKr,
  payoutBadge,
  periodsText,
  storeComponentText,
  warningViews,
} from "./model";

const sp = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");

describe("utbetalningarnas texter", () => {
  it("varningar på enkel svenska med en åtgärd, viktigast först och utan dubbletter", () => {
    const v = warningViews(
      [
        { code: "UNPRICED", orders: 12 },
        { code: "UNPRICED", orders: 12 },
        { code: "NEGATIVE_OWNER", ore: -120_000 },
        { code: "NO_AGREEMENT", storeId: "s1", grossOre: 1 },
        { code: "GAP_DAYS", from: "2026-11-04", to: "2026-11-05" },
        { code: "LIVE_ESTIMATE", months: ["2026-11"] },
      ],
      () => "Butik C",
      "/pengar/utbetalningar/x",
    );
    expect(v.map((w) => sp(w.text))).toEqual([
      "Pengarna räcker inte. Du behöver lägga till 1 200 kr.",
      "12 sålda paket saknar inköpspris. Partnern får inget tillbaka för dem förrän priset finns.",
      "Butik C har inget avtal, så butiken får 0 kr.",
      "4–5 nov. saknas i utbetalningarna.",
    ]);
    for (const w of v) {
      expect(w.text).not.toMatch(/VMB|allokering|\bbp\b/i);
    }
  });

  it("Varför? för en justering och för en del av månaden", () => {
    const t = storeComponentText({
      month: "2026-10",
      from: null,
      to: null,
      grossOre: 0,
      refundsOre: 0,
      orders: 0,
      shareOre: 300,
      wantedOre: 300,
      source: "trueup",
    });
    expect({ ...t, amount: sp(t.amount) }).toEqual({
      label: "Justering oktober",
      detail: "Skillnad mot butikens avräkning för hela månaden.",
      amount: "+3 kr",
    });
    expect(
      storeComponentText({
        month: "2026-11",
        from: "2026-11-03",
        to: "2026-11-09",
        grossOre: 5_200_000,
        refundsOre: 0,
        orders: 520,
        shareOre: 650_000,
        wantedOre: 650_000,
        source: "live",
      }).label,
    ).toBe("3–9 nov.");
  });

  it("badge och fälten", () => {
    expect(payoutBadge(0, true).text).toBe("Allt utbetalt");
    expect(payoutBadge(0, true, 16_100).text).toMatch(/^Allt utbetalt · 161\s?kr kvar till dig$/);
    expect(payoutBadge(0, false).text).toBe("Räknas inte");
    expect(payoutBadge(2, true).text).toBe("2 kvar");
    expect(parseKr("48 210,50")).toBe(4_821_050);
    expect(parseKr("0")).toBeNull();
    expect(parseKr("0", true)).toBe(0);
    expect(parseKr("abc")).toBeNull();
    expect(oreToField(4_821_050)).toBe("48210,50");
    expect(oreToField(null)).toBe("");
  });
});

describe("periodsText", () => {
  it("högst två perioder utskrivna, fler som första … sista", () => {
    expect(periodsText(["1–15 okt", "1–15 okt"])).toBe("Nayax 1–15 okt");
    expect(periodsText(["1–15 okt", "16–31 okt"])).toBe("Nayax 1–15 okt, 16–31 okt");
    expect(periodsText(["1–15 sep", "16–30 sep", "1–15 okt", "16–31 okt"])).toBe(
      "Nayax 1–15 sep … 16–31 okt (4 perioder)",
    );
  });
});

describe("countedRows (Så räknade vi)", () => {
  const t = {
    grossOre: 100_000,
    refundsOre: 0,
    expectedNetOre: 96_000,
    amountOre: 96_000,
    storesOre: 20_000,
    partnerReimbOre: 30_000,
    vatOre: 5_000,
    refundsOutsideOre: 0,
    profitOre: 41_000,
    partnerAdjustOre: 0,
    costOre: 30_000,
  };

  it("med partner: inköpet tillbaka och vinsten att dela", () => {
    const rows = countedRows(t, true);
    expect(rows.map((r) => r.label)).toContain("Inköpet tillbaka till partnern");
    expect(rows.at(-1)).toEqual({ label: "Vinst att dela", ore: 41_000 });
    // Pengar in − raderna = vinsten.
    const minus = rows.filter((r) => r.ore < 0 && r.label !== "Återbetalt till kunder");
    expect(t.amountOre + minus.reduce((a, r) => a + r.ore, 0)).toBe(t.profitOre);
  });

  it("utan partner: inte 'Vinst att dela', inköpet står som varav", () => {
    const solo = { ...t, partnerReimbOre: 0, profitOre: 71_000 };
    const rows = countedRows(solo, false);
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain("Vinst att dela");
    expect(labels).not.toContain("Inköpet tillbaka till partnern");
    expect(rows.find((r) => r.label === "Kvar till dig, inköpet ingår")!.ore).toBe(71_000);
    expect(rows.at(-1)).toEqual({ label: "Varav inköpet av packen", ore: 30_000, info: true });
    const minus = rows.filter((r) => r.ore < 0 && !r.info);
    expect(solo.amountOre + minus.reduce((a, r) => a + r.ore, 0)).toBe(solo.profitOre);
  });
});
