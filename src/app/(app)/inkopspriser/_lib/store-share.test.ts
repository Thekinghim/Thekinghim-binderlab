/**
 * Ägarens regel på Inköpspriser: "Kvar per order" är hela beloppet (före butikens andel).
 * Andelen och vår del visas bara med vald butik eller "Visa butikernas andel". Förlust
 * räknas på vår del, och texten säger när förlusten kommer först efter butikens andel.
 */

import { describe, expect, it } from "vitest";

import { titleEconomics, type TitleEconomicsInput } from "@/domain";
import { agreement, order, placement, price } from "@/domain/testing/fixtures";

import {
  correctionText,
  marginText,
  pageHeadline,
  priceTodos,
  signalTitleIds,
  splitPreviewText,
  statusLabel,
  titleHeadline,
  titleRows,
  type PriceCorrection,
} from "./model";
import { currentPriceEconomics, splitWithPrice } from "./price-economics";

const plain = (t: string) => t.replace(/ | /g, " ").replace(/−/g, "-");
const DATES = { asOf: "2026-11-30", today: "2026-11-30" };

/** Mystery pack premium i Sega gubben: 299 kr, inköp 190 kr, kortavgift 2,5 %. */
function mystery(
  terms: Parameters<typeof agreement>[3],
  extra: TitleEconomicsInput["orders"] = [],
) {
  const input: TitleEconomicsInput = {
    orders: [order({ titleId: "t-mp", businessDate: "2026-11-02", amountOre: 29_900 }), ...extra],
    prices: [price("t-mp", 19_000, "2026-01-01"), price("t-x", 1_000, "2026-01-01")],
    agreements: [agreement("s-sega", "2026-01-01", null, terms)],
    placements: [placement("m-1", "s-sega", "2026-01-01", null)],
    settings: { vatRateBp: 0, cardFeeBp: 250 },
    period: { start: "2026-11-01", end: "2026-11-30" },
  };
  const titles = [
    { id: "t-mp", name: "Mystery pack premium", series: null, archived: false },
    { id: "t-x", name: "Annan", series: null, archived: false },
  ];
  const rows = titleRows(titleEconomics(input), titles);
  return { input, rows, row: rows.find((r) => r.id === "t-mp")! };
}

const SPLIT_50 = { commissionBp: 5000, commissionBase: "profit_after_costs" as const };

describe("Inköpspriser: kvar per order före och efter butikens andel", () => {
  it("Mystery pack premium: 101,52 kr kvar per order, 50,76 kr butikens andel, 50,76 kr vår del", () => {
    const { row } = mystery(SPLIT_50);
    expect(row).toMatchObject({
      leftBeforeOre: 10_152,
      storeShareOre: 5_076,
      leftOre: 5_076,
      marginBeforeBp: 3395,
      status: "ok",
    });
    expect(statusLabel(row)).toBe("Lönsam");
  });

  it("andel av intäkten (20 %): samma kvar före andel, annan delning", () => {
    const { row } = mystery({ commissionBp: 2000 });
    expect(row).toMatchObject({ leftBeforeOre: 10_152, storeShareOre: 5_980, leftOre: 4_172 });
  });

  it("utan avtal är före andel och vår del samma tal", () => {
    const { row } = mystery({});
    expect(row.leftBeforeOre).toBe(10_152);
    expect(row.leftOre).toBe(10_152);
    expect(row.storeShareOre).toBe(0);
  });

  it("rubriken för titeln: hela beloppet som standard, delningen när andelen visas", () => {
    const { row } = mystery(SPLIT_50);
    const hidden = plain(titleHeadline(row, row.name, DATES.today).aside);
    expect(hidden).toContain("101,52 kr kvar per order");
    expect(hidden).not.toContain("50,76");
    const shown = plain(titleHeadline(row, row.name, DATES.today, true).aside);
    expect(shown).toContain("101,52 kr kvar per order (butikens andel 50,76 kr, vår del 50,76 kr)");
  });

  it("utan vald butik heter andelen butikernas andel", () => {
    const { row } = mystery(SPLIT_50);
    expect(plain(titleHeadline(row, row.name, DATES.today, "Butikernas andel").aside)).toContain(
      "(butikernas andel 50,76 kr, vår del 50,76 kr)",
    );
  });

  it("sidans rubrik: minst kvar per order på samma grund som kolumnen", () => {
    const { rows } = mystery(SPLIT_50);
    expect(plain(pageHeadline(rows, DATES).aside)).toContain("Mystery pack premium, 101,52 kr");
  });
});

describe("Inköpspriser: förlust räknas på vår del", () => {
  // 40 % av intäkten = 119,60 kr > 101,52 kr: förlust först efter butikens andel.
  const after = mystery({ commissionBp: 4000 });

  it("förlust efter butikens andel: status, rubrik, att göra och signal säger det", () => {
    const r = after.row;
    expect(r).toMatchObject({ leftBeforeOre: 10_152, leftOre: -1_808, status: "loss" });
    expect(statusLabel(r)).toBe("Förlust efter butikens andel");
    const head = pageHeadline(after.rows, DATES);
    expect(head.title).toBe("Mystery pack premium går med förlust efter butikens andel.");
    expect(plain(head.aside)).toContain(
      "101,52 kr per order före butikens andel, vår del -18,08 kr",
    );
    expect(priceTodos(after.rows)).toEqual([
      expect.objectContaining({ id: "t-mp", verb: "Förlust efter andel", tone: "critical" }),
    ]);
    expect(signalTitleIds(after.rows)).toEqual(["t-mp"]);
  });

  it("titelns rubrik utan andel visar hela beloppet och förlusten efter andelen", () => {
    const aside = plain(titleHeadline(after.row, after.row.name, DATES.today).aside);
    expect(aside).toContain(
      "101,52 kr kvar per order, men förlust 18,08 kr per order efter butikens andel",
    );
  });

  it("förlust efter hyra: texten säger när även andelen behövs för förlusten", () => {
    const base = { status: "loss-after-rent" as const, leftBeforeOre: 5_000 };
    expect(statusLabel({ ...base, leftBeforeAfterRentOre: -100 })).toBe("Förlust efter hyra");
    expect(statusLabel({ ...base, leftBeforeAfterRentOre: 1_000 })).toBe(
      "Förlust efter hyra och andel",
    );
  });

  it("förlust redan före andelen: bara Förlust, beloppet före andelen", () => {
    // Inköp 300 kr > 299 kr: förlust redan före andelen (ingen andel utan avtal).
    const { input } = mystery({});
    const loss = titleRows(
      titleEconomics({ ...input, prices: [price("t-mp", 30_000, "2026-01-01")] }),
      [{ id: "t-mp", name: "Mystery pack premium", series: null, archived: false }],
    )[0]!;
    expect(loss).toMatchObject({ leftBeforeOre: -848, leftOre: -848, status: "loss" });
    expect(statusLabel(loss)).toBe("Förlust");
    expect(pageHeadline([loss], DATES).title).toBe("Mystery pack premium går med förlust.");
    expect(plain(pageHeadline([loss], DATES).aside)).toBe(
      "-8,48 kr per order med inköpspriset som gäller 30 nov.",
    );
    expect(priceTodos([loss])[0]!.verb).toBe("Förlust");
  });
});

describe("Prisformuläret: kvar per order med nytt pris", () => {
  it("räknas med samma titleEconomics som tabellen", () => {
    const { input, row } = mystery(SPLIT_50, [
      order({ titleId: "t-x", businessDate: "2026-11-03", amountOre: 4_900 }),
    ]);
    // Samma pris som i dag ger exakt tabellens tal.
    expect(splitWithPrice(input, "t-mp", 19_000)).toEqual({
      orders: 1,
      leftBeforeOre: row.leftBeforeOre,
      storeShareOre: row.storeShareOre,
      leftOre: row.leftOre,
    });
    // 200 kr: 299 − 7,48 − 200 = 91,52 kr före andel, hälften till butiken.
    const next = splitWithPrice(input, "t-mp", 20_000);
    expect(next).toEqual({ orders: 1, leftBeforeOre: 9_152, storeShareOre: 4_576, leftOre: 4_576 });
    const priced = titleEconomics({
      ...input,
      prices: [price("t-mp", 20_000, "2026-01-01"), price("t-x", 1_000, "2026-01-01")],
    }).find((e) => e.titleId === "t-mp")!;
    expect(next.leftBeforeOre).toBe(priced.leftBeforeStoreOre);
    expect(next.storeShareOre).toBe(priced.storeSharePerOrderOre);
    expect(next.leftOre).toBe(priced.leftPerOrderOre);
  });

  it("texten följer tabellen: hela beloppet, delningen bara när andelen visas", () => {
    const now = { leftBeforeOre: 10_152, storeShareOre: 5_076, leftOre: 5_076 };
    const next = { leftBeforeOre: 9_152, storeShareOre: 4_576, leftOre: 4_576 };
    expect(splitPreviewText(next, now, false).map(plain)).toEqual([
      "Kvar per order blir 91,52 kr (nu 101,52 kr).",
    ]);
    expect(splitPreviewText(next, now, true).map(plain)).toEqual([
      "Kvar per order blir 91,52 kr (nu 101,52 kr).",
      "Butikens andel 45,76 kr, vår del 45,76 kr.",
    ]);
    // Förlust först efter andelen syns även när andelen är dold.
    const loss = { leftBeforeOre: 10_152, storeShareOre: 11_960, leftOre: -1_808 };
    expect(splitPreviewText(loss, null, false).map(plain)).toEqual([
      "Kvar per order blir 101,52 kr.",
      "Förlust 18,08 kr per order efter butikens andel.",
    ]);
    expect(
      splitPreviewText({ leftBeforeOre: null, storeShareOre: null, leftOre: null }, now, true),
    ).toEqual([]);
  });

  it("Rätta priset: vinsten är hela beloppet, utskrivet när andelen visas", () => {
    const c: PriceCorrection = {
      start: "2026-11-01",
      validTo: null,
      closedUntil: null,
      steps: [],
      affectedOrders: 2,
      ordersGainingPrice: 0,
      costDeltaOre: 2_000,
      profitDeltaOre: -2_000,
    };
    expect(plain(correctionText(c, "2026-11-30")[0]!)).toBe(
      "2 order får nytt inköp, vinsten ändras med -20 kr.",
    );
    expect(plain(correctionText(c, "2026-11-30", true)[0]!)).toBe(
      "2 order får nytt inköp, vinsten före butikens andel ändras med -20 kr.",
    );
  });
});

/**
 * 30th Celebration i Sega gubben (50 % av vinsten): inköpet höjs från 112 kr till 120 kr mitt
 * i perioden. "Kvar per order" räknas med dagens inköp, så butikens andel och vår del måste
 * också räknas med dagens inköp (annars får butiken mer än hälften av kvar per order).
 */
function priceChange(terms: Parameters<typeof agreement>[3]) {
  const sale = (date: string) => order({ titleId: "t-30", businessDate: date, amountOre: 18_500 });
  const input: TitleEconomicsInput = {
    orders: [sale("2026-11-02"), sale("2026-11-03"), sale("2026-11-04"), sale("2026-11-04")],
    prices: [price("t-30", 11_200, "2026-10-27"), price("t-30", 12_000, "2026-11-04")],
    agreements: [agreement("s-sega", "2026-01-01", null, terms)],
    placements: [placement("m-1", "s-sega", "2026-01-01", null)],
    settings: { vatRateBp: 0, cardFeeBp: 250 },
    period: { start: "2026-11-02", end: "2026-11-04" },
  };
  const titles = [{ id: "t-30", name: "30th Celebration", series: null, archived: false }];
  const rows = titleRows(currentPriceEconomics(input), titles);
  return { input, row: rows.find((r) => r.id === "t-30")! };
}

describe("Inköpspriser: andelen räknas med dagens inköpspris", () => {
  it("vinstdelning 50 %: andelen och vår del är hälften var av kvar per order", () => {
    const { row } = priceChange(SPLIT_50);
    // 185 − 4,63 kortavgift − 120 inköp = 60,37 kr; hälften 30,185 kr (avrundas var för sig).
    expect(row.leftBeforeOre).toBe(6_037);
    expect(row.storeShareOre).toBe(3_019);
    expect(row.leftOre).toBe(3_019);
    // Snittet av de inköp som faktiskt gällde orderna är oförändrat.
    expect(row.averageCostOre).toBe(11_600);
    expect(row.currentFrom).toBe("2026-11-04");
  });

  it("förhandsvisningen med dagens pris ger samma tal som tabellen", () => {
    const { input, row } = priceChange(SPLIT_50);
    expect(splitWithPrice(input, "t-30", 12_000)).toEqual({
      orders: 4,
      leftBeforeOre: row.leftBeforeOre,
      storeShareOre: row.storeShareOre,
      leftOre: row.leftOre,
    });
  });

  it("andel av intäkten påverkas inte av inköpet", () => {
    const { row } = priceChange({ commissionBp: 1500 });
    expect(row).toMatchObject({ leftBeforeOre: 6_037, storeShareOre: 2_775, leftOre: 3_262 });
  });

  it("order utan pris förblir utan pris", () => {
    const { input } = priceChange(SPLIT_50);
    const early = order({ titleId: "t-30", businessDate: "2026-11-02", amountOre: 18_500 });
    const late = { ...input, prices: [price("t-30", 12_000, "2026-11-03")], orders: [early] };
    const e = currentPriceEconomics(late).find((x) => x.titleId === "t-30")!;
    expect(e.unpricedOrders).toBe(1);
    expect(e.storeSharePerOrderOre).toBe(0);
  });
});

describe("Inköpspriser: Kvar av pris", () => {
  it("avrundas en gång (9,4465 % visas som 9,4 %, inte 9,45 → 9,5 %)", () => {
    const input: TitleEconomicsInput = {
      orders: [order({ titleId: "t-me", businessDate: "2026-11-02", amountOre: 15_900 })],
      prices: [price("t-me", 14_000, "2026-11-01")],
      agreements: [],
      placements: [placement("m-1", "s-norr", "2026-01-01", null)],
      settings: { vatRateBp: 0, cardFeeBp: 250 },
      period: { start: "2026-11-02", end: "2026-11-04" },
    };
    const titles = [{ id: "t-me", name: "Mega Evolution", series: null, archived: false }];
    const row = titleRows(currentPriceEconomics(input), titles)[0]!;
    // 159 − 3,98 − 140 = 15,02 kr av 159 kr = 9,4465 %.
    expect(row.leftBeforeOre).toBe(1_502);
    expect(plain(marginText(row))).toBe("9,4 %");
  });
});
