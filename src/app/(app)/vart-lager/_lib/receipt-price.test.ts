import { describe, expect, it } from "vitest";

import { priceFieldText, receiptPriceOre, receiptPriceState } from "./receipt-price";

describe("prisfältet vid en leverans", () => {
  it("förifyllt med dagens pris, som det skrivs på språket", () => {
    expect(priceFieldText(11_250, "sv")).toBe("112,50");
    expect(priceFieldText(11_250, "en")).toBe("112.50");
    expect(priceFieldText(11_800, "sv")).toBe("118");
    expect(priceFieldText(5, "sv")).toBe("0,05");
  });
  it("samma pris: inget mer; annat pris: nytt från i dag; tomt: priset rörs inte", () => {
    expect(receiptPriceState("112,50", 11_250)).toEqual({ kind: "same", ore: 11_250 });
    expect(receiptPriceState("112.50", 11_250)).toEqual({ kind: "same", ore: 11_250 });
    expect(receiptPriceState("118", 11_250)).toEqual({ kind: "new", ore: 11_800 });
    expect(receiptPriceState("118", null)).toEqual({ kind: "new", ore: 11_800 });
    expect(receiptPriceState("  ", 11_250)).toEqual({ kind: "empty" });
    expect(receiptPriceState("abc", 11_250)).toEqual({ kind: "invalid" });
    expect(receiptPriceState("200000", null)).toEqual({ kind: "invalid" });
    expect(receiptPriceOre({ kind: "empty" })).toBeUndefined();
    expect(receiptPriceOre({ kind: "new", ore: 11_800 })).toBe(11_800);
  });
});
