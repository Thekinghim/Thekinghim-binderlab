import { describe, expect, it } from "vitest";

import {
  advanceLine,
  advancePartsOf,
  coverage,
  coveredPaidOn,
  dayRangeText,
  leftLine,
  monthSlices,
  parseKrInput,
  parseParts,
  partEffectText,
  sliceTarget,
  splitPayment,
  type MonthInfo,
} from "./advance";

const plain = (t: string | null) => t?.replace(/[  ]/g, " ") ?? null;

const oct = (over: Partial<MonthInfo> = {}): MonthInfo => ({
  month: "2026-10",
  start: "2026-10-14",
  end: "2026-10-31",
  settlement: null,
  rangeOre: null,
  monthOre: null,
  future: false,
  ...over,
});
const nov = (over: Partial<MonthInfo> = {}): MonthInfo => ({
  month: "2026-11",
  start: "2026-11-01",
  end: "2026-11-14",
  settlement: null,
  rangeOre: null,
  monthOre: null,
  future: false,
  ...over,
});

describe("perioden i kalendermånader", () => {
  it("14 okt.–14 nov. blir två delar", () => {
    expect(monthSlices({ start: "2026-10-14", end: "2026-11-14" })).toEqual([
      { month: "2026-10", start: "2026-10-14", end: "2026-10-31" },
      { month: "2026-11", start: "2026-11-01", end: "2026-11-14" },
    ]);
  });
  it("över årsskiftet och inom en månad", () => {
    expect(monthSlices({ start: "2026-12-20", end: "2027-01-05" }).map((s) => s.month)).toEqual([
      "2026-12",
      "2027-01",
    ]);
    expect(monthSlices({ start: "2026-11-03", end: "2026-11-03" })).toHaveLength(1);
  });
});

describe("uppdelningen (regeln i advance.ts)", () => {
  it("det riktiga fallets form: oktober betald, resten blir förskott för november", () => {
    // Oktober (maskinen från den 14:e) är betald med 8 388,08 kr. Betalningen 10 089,32 kr
    // för 14 okt.–14 nov.: oktober får det som betalades för den, november resten.
    const split = splitPayment(1_008_932, [
      oct({ settlement: { paid: true, openOre: 838_808 }, rangeOre: 917_828, monthOre: 917_828 }),
      nov(),
    ]);
    expect(split).toEqual({
      ok: true,
      parts: [
        { month: "2026-10", start: "2026-10-14", end: "2026-10-31", amountOre: 838_808 },
        { month: "2026-11", start: "2026-11-01", end: "2026-11-14", amountOre: 170_124 },
      ],
    });
  });

  it("en obetald avräkning får sitt belopp, inte en andel efter antal dagar", () => {
    const split = splitPayment(500_000, [
      oct({
        start: "2026-10-01",
        settlement: { paid: false, openOre: 300_000 },
      }),
      nov(),
    ]);
    expect(split.ok && split.parts.map((p) => p.amountOre)).toEqual([300_000, 200_000]);
  });

  it("utan avräkning: appens belopp för dagarna", () => {
    const split = splitPayment(500_000, [oct({ rangeOre: 120_000, monthOre: 400_000 }), nov()]);
    expect(split.ok && split.parts.map((p) => p.amountOre)).toEqual([120_000, 380_000]);
  });

  it("mindre än första månaden: allt dit, 0 kr till nästa", () => {
    const split = splitPayment(100_000, [
      oct({ settlement: { paid: false, openOre: 300_000 }, start: "2026-10-01" }),
      nov(),
    ]);
    expect(split.ok && split.parts.map((p) => p.amountOre)).toEqual([100_000, 0]);
  });

  it("en betald månad som bara delvis ingår: samma andel av det betalda", () => {
    const t = sliceTarget(
      oct({ settlement: { paid: true, openOre: 1_000 }, rangeOre: 600, monthOre: 1_200 }),
    );
    expect(t).toEqual({ ok: true, targetOre: 500 });
  });

  it("andra betalningar som redan ligger på månaden räknas bort (inga pengar två gånger)", () => {
    const t = sliceTarget(oct({ start: "2026-10-01", settlement: { paid: true, openOre: 0 } }));
    expect(t).toEqual({ ok: true, targetOre: 0 });
  });

  it("en månad som inte är slut, eller inte går att räkna, delas inte", () => {
    const future = splitPayment(500_000, [oct({ future: true }), nov()]);
    expect(future.ok).toBe(false);
    expect(!future.ok && future.message).toContain("Oktober är inte slut");
    const blocked = splitPayment(500_000, [oct({ why: "Inköpspris saknas." }), nov()]);
    expect(!blocked.ok && plain(blocked.message)).toContain(
      "Butikens andel för 14–31 okt. går inte att räkna: Inköpspris saknas.",
    );
    expect(!blocked.ok && blocked.message).toContain("en betalning för varje månad");
  });

  it("mer än det som återstår på en betald sista månad: inget registreras", () => {
    const split = splitPayment(1_000_000, [
      nov({ start: "2026-11-01", end: "2026-11-30", settlement: { paid: true, openOre: 838_808 } }),
    ]);
    expect(split.ok).toBe(false);
    expect(!split.ok && plain(split.message)).toContain(
      "November är redan betald. Betalningen är 1 611,92 kr mer",
    );
  });

  it("belopp över 0 krävs", () => {
    expect(splitPayment(0, [nov()]).ok).toBe(false);
  });
});

describe("avdraget och texterna", () => {
  const payment = {
    id: "p1",
    storeId: "s1",
    paidOn: "2026-11-16",
    amountOre: 1_008_932,
    periodStart: "2026-10-14",
    periodEnd: "2026-11-14",
    note: null,
    parts: [
      { month: "2026-10", start: "2026-10-14", end: "2026-10-31", amountOre: 838_808 },
      { month: "2026-11", start: "2026-11-01", end: "2026-11-14", amountOre: 170_124 },
    ],
  } as const;

  it("förskottet för november och raden på avräkningen", () => {
    const parts = advancePartsOf([payment]).filter((p) => p.month === "2026-11");
    expect(plain(advanceLine(parts))).toBe(
      "Redan betalt i förskott 1 701,24 kr (1–14 nov., betalt 16 nov.)",
    );
  });

  it("kvar att betala, täckt och för mycket", () => {
    expect(coverage(500_000, 170_124)).toEqual({ leftOre: 329_876, covered: false, overOre: 0 });
    expect(coverage(170_124, 170_124)).toMatchObject({ covered: true, leftOre: 0 });
    expect(coverage(150_000, 170_124)).toEqual({
      leftOre: -20_124,
      covered: true,
      overOre: 20_124,
    });
    expect(coverage(0, 0).covered).toBe(false);
    expect(plain(leftLine(329_876))).toBe("Kvar att betala 3 298,76 kr");
    expect(plain(leftLine(-20_124))).toBe("Butiken har fått 201,24 kr för mycket");
  });

  it("dagen en täckt avräkning räknas som betald: aldrig före månaden", () => {
    const parts = advancePartsOf([payment]);
    expect(
      coveredPaidOn(
        parts.filter((p) => p.month === "2026-11"),
        "2026-11",
      ),
    ).toBe("2026-11-16");
    expect(
      coveredPaidOn([{ ...parts[0]!, paidOn: "2026-10-20", month: "2026-11" }], "2026-11"),
    ).toBe("2026-11-01");
  });

  it("vad varje del gör", () => {
    const part = payment.parts[1];
    expect(partEffectText(part, null)).toBe("Dras av när avräkningen för november skapas");
    expect(partEffectText(part, { paid: false, fromPayments: false })).toBe(
      "Dras av på avräkningen för november",
    );
    expect(partEffectText(payment.parts[0], { paid: true, fromPayments: false })).toBe(
      "Ingår i det som betalades för oktober",
    );
    expect(partEffectText(part, { paid: true, fromPayments: true })).toBe(
      "Täcker avräkningen för november",
    );
  });

  it("perioder som text", () => {
    expect(plain(dayRangeText({ start: "2026-10-14", end: "2026-11-14" }))).toBe("14 okt.–14 nov.");
    expect(plain(dayRangeText({ start: "2026-11-01", end: "2026-11-14" }))).toBe("1–14 nov.");
    expect(dayRangeText({ start: "2026-11-01", end: "2026-11-30" })).toBe("hela november");
  });

  it("sparade delar med fel form läses som inga", () => {
    expect(parseParts([{ month: "2026-11", start: "x" }])).toEqual([]);
    expect(parseParts(payment.parts)).toHaveLength(2);
  });

  it("belopp som de skrivs", () => {
    expect(parseKrInput("10 089,32")).toBe(1_008_932);
    expect(parseKrInput("1701.24 kr")).toBe(170_124);
    expect(parseKrInput("1 701")).toBe(170_100);
    expect(parseKrInput("0")).toBeNull();
    expect(parseKrInput("12,345")).toBeNull();
    expect(parseKrInput("-5")).toBeNull();
  });
});
