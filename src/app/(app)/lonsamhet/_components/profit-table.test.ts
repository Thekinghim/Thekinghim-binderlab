import { describe, expect, it } from "vitest";

import type { ProfitLine } from "../_lib/model";
import { lonsamhetCsv, sortedLines } from "./profit-table";

function line(p: Partial<ProfitLine> & Pick<ProfitLine, "key" | "name">): ProfitLine {
  return {
    kind: "item",
    code: null,
    orders: 10,
    revenueOre: 100_000,
    costOre: 50_000,
    feesOre: 2_000,
    vmbVatOre: 0,
    compensationOre: 10_000,
    profitOre: 38_000,
    marginBp: 3800,
    unpricedOrders: 0,
    unpricedRevenueOre: 0,
    priceHref: null,
    ...p,
  };
}

const rows: ProfitLine[] = [
  line({ key: "b", name: "Black Bolt", profitOre: 2_111_350, marginBp: 2784 }),
  line({ key: "u", name: "Ej fördelad hyra", kind: "unallocated", profitOre: -11_112 }),
  line({ key: "d", name: "Destin Rivals", profitOre: 880_210 }),
  line({ key: "m", name: "Mega Evolution", profitOre: -3_350, marginBp: -50 }),
  line({
    key: "s",
    name: "=Surging",
    orders: 4,
    unpricedOrders: 4,
    revenueOre: 0,
    profitOre: 0,
    marginBp: null,
    unpricedRevenueOre: 40_000,
  }),
];
const totals = line({ key: "total", name: "Totalt", profitOre: 2_976_098 });

describe("sortering i tabellen och exporten", () => {
  it("lägger de särskilda raderna och saknade värden sist i båda riktningarna", () => {
    const asc = sortedLines(rows, [{ key: "name", dir: "asc" }]).map((r) => r.key);
    // Tecken före bokstäver, som i svensk ordning.
    expect(asc).toEqual(["s", "b", "d", "m", "u"]);
    const desc = sortedLines(rows, [{ key: "name", dir: "desc" }]).map((r) => r.key);
    expect(desc).toEqual(["m", "d", "b", "s", "u"]);
    const profit = sortedLines(rows, [{ key: "profit", dir: "asc" }]).map((r) => r.key);
    // Titeln utan pris har ingen vinst och hamnar sist, före ingenting.
    expect(profit.slice(0, 3)).toEqual(["m", "d", "b"]);
    expect(profit.slice(3).sort()).toEqual(["s", "u"]);
  });
});

describe("lonsamhetCsv", () => {
  it("skriver belopp med två decimaler, i tabellens ordning och med totalen sist", () => {
    const csv = lonsamhetCsv("title", rows, totals, [{ key: "name", dir: "asc" }]);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Titel;Order;Order med inköpspris;Order utan inköpspris;Intäkt med inköpspris (kr);Inköp (kr);Avgifter (kr);VMB-moms (kr);Butiksersättning (kr);Vinst (kr);Marginal (%);Intäkt utan inköpspris (kr)",
    );
    expect(lines.map((l) => l.split(";")[0])).toEqual([
      "Titel",
      "'=Surging",
      "Black Bolt",
      "Destin Rivals",
      "Mega Evolution",
      "Ej fördelad hyra",
      "Totalt",
    ]);
    expect(lines[2]).toBe(
      "Black Bolt;10;10;0;1000,00;500,00;20,00;0,00;100,00;21113,50;27,84;0,00",
    );
    // Negativa belopp blir tal, inte text med apostrof.
    expect(lines[4]).toContain(";-33,50;-0,50;");
    expect(lines[5]?.split(";")[9]).toBe("-111,12");
  });
});
