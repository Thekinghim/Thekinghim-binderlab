import { describe, expect, it } from "vitest";

import type { TitleRow } from "@/app/(app)/inkopspriser/_lib/model";

import { perOrderText, priceNote, priceRowData, priceSortKey } from "./prices-view";

function row(over: Partial<TitleRow> = {}): TitleRow {
  return {
    id: "t1",
    name: "151 Booster",
    series: null,
    archived: false,
    currentCostOre: 4_000,
    currentFrom: "2026-10-01",
    averagePriceOre: 8_000,
    averageCostOre: 4_000,
    leftBeforeOre: 3_000,
    storeShareOre: 1_500,
    leftOre: 1_500,
    marginBeforeBp: 3_750,
    marginBeforeShare: 0.375,
    marginBp: 1_875,
    rentOre: 200,
    leftBeforeAfterRentOre: 2_800,
    leftAfterRentOre: 1_300,
    orders: 10,
    unpricedOrders: 0,
    unpricedRevenueOre: 0,
    unpricedFirstDate: null,
    status: "ok",
    own: false,
    ...over,
  } as TitleRow;
}

/** Belopp formateras med hårt mellanslag (formatSek). */
const sp = (s: string) => s.replace(/\u00a0/g, " ");

const FULL = { share: false, rent: false };
const SPLIT = { share: true, rent: false, scope: "ICA Assistent" };

describe("inkopspriser: hela beloppet som standard", () => {
  it("kvar per order och marginal är före butikens andel; andelen och vår del saknas", () => {
    const d = priceRowData(row(), FULL);
    expect(d.kvarPerOrderOre).toBe(3_000);
    expect(sp(String(d.kvarPerOrder))).toBe("30 kr");
    expect(d.marginalBp).toBe(3_750);
    expect(d).not.toHaveProperty("butikensAndelPerOrderOre");
    expect(d).not.toHaveProperty("varDelPerOrderOre");
    expect(d).not.toHaveProperty("kvarEfterHyraOre");
    expect(sp(perOrderText(row(), FULL))).toBe("30 kr per order");
  });

  it("med hyra: kvar efter hyra är också före andelen", () => {
    const d = priceRowData(row(), { share: false, rent: true });
    expect(d.kvarEfterHyraOre).toBe(2_800);
    expect(d).not.toHaveProperty("varDelEfterHyraOre");
  });

  it("förlust som kommer av andelen: vår del står med för att förklara förlusten", () => {
    const loss = row({ status: "loss", leftBeforeOre: 500, storeShareOre: 700, leftOre: -200 });
    const d = priceRowData(loss, FULL);
    expect(d.kvarPerOrderOre).toBe(500);
    expect(d.varDelPerOrderOre).toBe(-200);
    expect(d).not.toHaveProperty("butikensAndelPerOrderOre");
  });

  it("förlust utan andel: bara hela beloppet", () => {
    const loss = row({ status: "loss", leftBeforeOre: -100, storeShareOre: 0, leftOre: -100 });
    expect(priceRowData(loss, FULL)).not.toHaveProperty("varDelPerOrderOre");
  });

  it("sorterar på hela beloppet", () => {
    const a = row({ id: "a", leftBeforeOre: 100, leftOre: 900, marginBeforeBp: 10, marginBp: 90 });
    const b = row({ id: "b", leftBeforeOre: 200, leftOre: 50, marginBeforeBp: 20, marginBp: 5 });
    const byLeft = priceSortKey("kvar_per_order", FULL);
    expect([b, a].sort((x, y) => byLeft(x) - byLeft(y)).map((r) => r.id)).toEqual(["a", "b"]);
    const byMargin = priceSortKey("marginal", FULL);
    expect([b, a].sort((x, y) => byMargin(x) - byMargin(y)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("anmärkningen säger att svaret ska ge hela beloppet", () => {
    expect(priceNote(FULL)).toContain("före butikens andel");
    expect(priceNote(FULL)).toContain("svara med hela beloppet");
    expect(priceNote(FULL)).toContain("Ingen hyra");
  });
});

describe("inkopspriser: delningen vid vald butik eller fråga om andelen", () => {
  it("hela beloppet, butikens andel och vår del", () => {
    const d = priceRowData(row(), SPLIT);
    expect(d.kvarPerOrderOre).toBe(3_000);
    expect(d.butikensAndelPerOrderOre).toBe(1_500);
    expect(d.varDelPerOrderOre).toBe(1_500);
    expect(d.varMarginalBp).toBe(1_875);
    expect(d.marginalBp).toBe(3_750);
    expect(sp(perOrderText(row(), SPLIT))).toBe(
      "30 kr per order, butikens andel 15 kr, vår del 15 kr",
    );
  });

  it("med hyra: vår del efter hyra i stället för kvar efter hyra", () => {
    const d = priceRowData(row(), { ...SPLIT, rent: true });
    expect(d.varDelEfterHyraOre).toBe(1_300);
    expect(d).not.toHaveProperty("kvarEfterHyraOre");
  });

  it("titel utan andel: vår del är hela beloppet, texten nämner ingen delning", () => {
    const r = row({ storeShareOre: 0, leftOre: 3_000 });
    expect(priceRowData(r, SPLIT).varDelPerOrderOre).toBe(3_000);
    expect(sp(perOrderText(r, SPLIT))).toBe("30 kr per order");
  });

  it("sorterar på vår del", () => {
    const a = row({ id: "a", leftBeforeOre: 100, leftOre: 900, marginBp: 90 });
    const b = row({ id: "b", leftBeforeOre: 200, leftOre: 50, marginBp: 5 });
    const byLeft = priceSortKey("kvar_per_order", SPLIT);
    expect([a, b].sort((x, y) => byLeft(x) - byLeft(y)).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("anmärkningen nämner urvalet och ordningen", () => {
    expect(priceNote(SPLIT)).toContain("gäller ICA Assistent");
    expect(priceNote(SPLIT)).toContain("Ange hela beloppet och sedan delningen");
    expect(priceNote({ share: true, rent: false })).toContain("gäller alla butiker");
  });
});

describe("inkopspriser: status som sidan (statusLabel)", () => {
  it("förlust först efter butikens andel säger det, så att den inte motsäger hela beloppet", () => {
    const loss = row({ status: "loss", leftBeforeOre: 500, storeShareOre: 700, leftOre: -200 });
    expect(priceRowData(loss, FULL).status).toBe("går med förlust efter butikens andel");
    expect(priceRowData(loss, SPLIT).status).toBe("går med förlust efter butikens andel");
    const real = row({ status: "loss", leftBeforeOre: -100, storeShareOre: 0, leftOre: -100 });
    expect(priceRowData(real, FULL).status).toBe("går med förlust");
  });

  it("förlust efter hyra som kommer av andelen: status och vår del efter hyra står med", () => {
    const r = row({
      status: "loss-after-rent",
      leftBeforeAfterRentOre: 1_000,
      leftOre: 300,
      leftAfterRentOre: -200,
    });
    const d = priceRowData(r, { share: false, rent: true });
    expect(d.status).toBe("går med förlust efter hyra och andel");
    expect(d.kvarEfterHyraOre).toBe(1_000);
    expect(d.varDelEfterHyraOre).toBe(-200);
    expect(d).not.toHaveProperty("butikensAndelPerOrderOre");
    const plain = row({
      status: "loss-after-rent",
      storeShareOre: 0,
      leftBeforeAfterRentOre: -200,
      leftAfterRentOre: -200,
    });
    const p = priceRowData(plain, { share: false, rent: true });
    expect(p.status).toBe("går med förlust efter hyran");
    expect(p).not.toHaveProperty("varDelEfterHyraOre");
  });
});
