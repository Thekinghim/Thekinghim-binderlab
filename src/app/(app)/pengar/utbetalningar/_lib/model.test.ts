import { describe, expect, it } from "vitest";

import { oreToField, parseKr, payoutBadge, storeComponentText, warningViews } from "./model";

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
