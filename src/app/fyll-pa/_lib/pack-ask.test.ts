/**
 * "Packade du en omgång?": frågan före Klar när mystery packs fylls på fast de inte finns
 * färdiga i lagret man fyller från.
 */
import { describe, expect, it } from "vitest";

import { en } from "@/i18n/en";
import { sv } from "@/i18n/sv";

import { mysteryShortAtHome, packAsks, withPacked, type FillRecipe, type FillRow } from "./model";

const MP = "mp";
const A = "a";
const B = "b";

function row(over: Partial<FillRow> = {}): FillRow {
  return {
    titleId: MP,
    name: "Mystery Pack",
    now: 0,
    capacity: 20,
    home: 0,
    suggested: 0,
    emptySlots: 1,
    sold: 20,
    status: "empty",
    batchSize: 14,
    ...over,
  };
}

const recipe: FillRecipe = {
  recipeId: "r1",
  batchSize: 14,
  items: [
    { titleId: A, quantity: 8 },
    { titleId: B, quantity: 6 },
  ],
};
const recipes = { [MP]: recipe };

describe("packAsks", () => {
  it("frågar när 14 mystery packs fylls på med 0 färdiga i lagret", () => {
    const asks = packAsks([{ row: row(), quantity: 14 }], recipes, { [A]: 8, [B]: 6 });
    expect(asks).toEqual([
      { titleId: MP, name: "Mystery Pack", home: 0, batches: 1, packs: 14, recipeId: "r1" },
    ]);
  });

  it("frågar inte när en hel omgång ligger färdig", () => {
    expect(
      packAsks([{ row: row({ home: 14 }), quantity: 14 }], recipes, { [MP]: 14, [A]: 8, [B]: 6 }),
    ).toEqual([]);
  });

  it("ett minus i lagret räknas som 0 färdiga", () => {
    const asks = packAsks([{ row: row({ home: -3 }), quantity: 14 }], recipes, {
      [MP]: -3,
      [A]: 20,
      [B]: 20,
    });
    expect(asks[0]).toMatchObject({ home: 0, batches: 1, packs: 14 });
  });

  it("delarna räcker inte: ingen fråga, påfyllningen går igenom som förut", () => {
    expect(packAsks([{ row: row(), quantity: 14 }], recipes, { [A]: 8, [B]: 5 })).toEqual([]);
    expect(packAsks([{ row: row(), quantity: 14 }], recipes, {})).toEqual([]);
  });

  it("inget eget lager, okänt innehåll eller vanlig titel: ingen fråga", () => {
    expect(packAsks([{ row: row(), quantity: 14 }], recipes, null)).toEqual([]);
    expect(packAsks([{ row: row(), quantity: 14 }], {}, { [A]: 99, [B]: 99 })).toEqual([]);
    expect(
      packAsks([{ row: row({ batchSize: null }), quantity: 14 }], recipes, { [A]: 99, [B]: 99 }),
    ).toEqual([]);
  });

  it("räknar omgångarna som fattas (5 färdiga, 28 fylls på: 2 omgångar)", () => {
    const asks = packAsks([{ row: row({ home: 5 }), quantity: 28 }], recipes, {
      [MP]: 5,
      [A]: 16,
      [B]: 12,
    });
    expect(asks[0]).toMatchObject({ home: 5, batches: 2, packs: 28 });
  });

  it("två mystery packs med samma delar: den första får delarna", () => {
    const second = row({ titleId: "mp2", name: "Mystery Premium" });
    const asks = packAsks(
      [
        { row: row(), quantity: 14 },
        { row: second, quantity: 14 },
      ],
      { ...recipes, mp2: { ...recipe, recipeId: "r2" } },
      { [A]: 8, [B]: 6 },
    );
    expect(asks.map((a) => a.titleId)).toEqual([MP]);
  });
});

describe("mysteryShortAtHome", () => {
  it("tomt fack och ingen hel omgång färdig: erbjuder en omgång", () => {
    expect(mysteryShortAtHome(row({ now: 0, home: 0 }))).toBe(14);
    expect(mysteryShortAtHome(row({ now: 0, home: 13 }))).toBe(14);
    expect(mysteryShortAtHome(row({ now: 0, home: -14 }))).toBe(14);
  });

  it("inget när omgången finns, facket har pack eller titeln är vanlig", () => {
    expect(mysteryShortAtHome(row({ now: 0, home: 14 }))).toBeNull();
    expect(mysteryShortAtHome(row({ now: 3, home: 0 }))).toBeNull();
    expect(mysteryShortAtHome(row({ batchSize: null }))).toBeNull();
  });
});

describe("withPacked", () => {
  it("lägger packningen på lagrets saldo utan att ändra originalet", () => {
    const stock = { p1: { [A]: 8, [B]: 6 }, p2: { [A]: 1 } };
    const out = withPacked(stock, [
      { placeId: "p1", titleId: MP, delta: 14 },
      { placeId: "p1", titleId: A, delta: -8 },
      { placeId: "p1", titleId: B, delta: -6 },
    ]);
    expect(out).toEqual({ p1: { [A]: 0, [B]: 0, [MP]: 14 }, p2: { [A]: 1 } });
    expect(stock.p1).toEqual({ [A]: 8, [B]: 6 });
    expect(withPacked(stock, [])).toBe(stock);
  });
});

describe("texterna", () => {
  it("svenska: frågan som ägaren ser", () => {
    const f = sv.r2.t1.fill;
    expect(f.packAskHave(0, "Mystery Pack", "Kontoret")).toBe(
      "Det finns 0 Mystery Pack i Kontoret.",
    );
    expect(f.packAskQuestion(1)).toBe("Packade du en omgång?");
    expect(f.packAskYes(1, true)).toBe("Ja, packa 1 omgång och fyll på");
    expect(f.packAskNo(true)).toBe("Nej, fyll bara på");
  });

  it("engelska: samma fråga för delägaren", () => {
    const f = en.r2.t1.fill;
    expect(f.packAskHave(0, "Mystery Pack", "Kontoret")).toBe(
      "There are 0 Mystery Pack at Kontoret.",
    );
    expect(f.packAskQuestion(1)).toBe("Did you pack a batch?");
    expect(f.packAskYes(1, true)).toBe("Yes, pack 1 batch and refill");
  });

  it("flera automater väntar på Awish: en rad, högst tre koder", () => {
    const two = ["BL-001", "BL-002"];
    const ten = Array.from({ length: 10 }, (_, i) => `BL-${String(i + 1).padStart(3, "0")}`);
    expect(sv.r2.t1.fill.awishPendingMany(two)).toBe(
      "Awish fick inte antalen för BL-001 och BL-002.",
    );
    expect(sv.r2.t1.fill.awishPendingMany(ten.slice(0, 3))).toBe(
      "Awish fick inte antalen för BL-001, BL-002 och BL-003.",
    );
    expect(sv.r2.t1.fill.awishPendingMany(ten)).toBe("Awish fick inte antalen för 10 automater.");
    expect(en.r2.t1.fill.awishPendingMany(two)).toBe(
      "BL-001 and BL-002 did not get the new numbers.",
    );
    expect(en.r2.t1.fill.awishPendingMany(ten)).toBe("10 machines did not get the new numbers.");
  });
});
