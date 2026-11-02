import { describe, expect, it } from "vitest";
import { Ratio } from "../expansion/common";
import {
  bpOf,
  ceilRatio,
  floorRatio,
  hundredthsFixed,
  listText,
  marketEvidence,
  modalAmount,
  orderContributions,
  pctAbs,
  relativeChangeBp,
  signedTenths,
  tenthsOf,
  tenthsText,
} from "./common";
import { ord, plain, sources } from "./test-fixtures";

describe("avrundning av bråk", () => {
  it("golv och tak, även negativa", () => {
    expect(floorRatio(new Ratio(7, 2))).toBe(3);
    expect(floorRatio(new Ratio(-7, 2))).toBe(-4);
    expect(ceilRatio(new Ratio(7, 2))).toBe(4);
    expect(ceilRatio(new Ratio(-7, 2))).toBe(-3);
    expect(ceilRatio(new Ratio(6, 2))).toBe(3);
  });

  it("bp, tiondelar, halva bort från noll", () => {
    expect(bpOf(new Ratio(1, 3))).toBe(3_333);
    expect(bpOf(new Ratio(1, 20_000))).toBe(1);
    expect(tenthsOf(new Ratio(25, 2))).toBe(125);
    expect(tenthsOf(new Ratio(-1, 20))).toBe(-1);
  });
});

describe("relativeChangeBp", () => {
  it("(nu − före) / före", () => {
    expect(relativeChangeBp(110, 100)).toBe(1_000);
    expect(relativeChangeBp(84, 140)).toBe(-4_000);
  });

  it("före 0 ger null", () => {
    expect(relativeChangeBp(5, 0)).toBeNull();
  });

  it("negativ bas räknas mot absolutbeloppet", () => {
    expect(relativeChangeBp(-50, -100)).toBe(5_000);
  });
});

describe("orderContributions", () => {
  it("netto − inköp − avgift − provision; null utan pris", () => {
    const orders = [ord("a", "t-a", "m-1", "2026-10-01"), ord("b", "t-x", "m-1", "2026-10-01")];
    const c = orderContributions(orders, sources({ "t-a": 2_000 }));
    // 4 900 − 2 000 − 490
    expect(c.get("a")).toBe(2_410);
    expect(c.get("b")).toBeNull();
  });

  it("utan placering: ingen provision", () => {
    const c = orderContributions([ord("a", "t-a", "m-9", "2026-10-01")], sources({ "t-a": 2_000 }));
    expect(c.get("a")).toBe(2_900);
  });
});

describe("modalAmount", () => {
  it("vanligaste beloppet; lika → lägst", () => {
    expect(modalAmount([{ amountOre: 5_900 }, { amountOre: 4_900 }, { amountOre: 4_900 }])).toBe(
      4_900,
    );
    expect(modalAmount([{ amountOre: 5_900 }, { amountOre: 4_900 }])).toBe(4_900);
    expect(modalAmount([])).toBeNull();
  });
});

describe("text", () => {
  it("tiondelar, procent och listor", () => {
    expect(tenthsText(125)).toBe("12,5");
    expect(tenthsText(120)).toBe("12");
    expect(tenthsText(-5)).toBe("−0,5");
    expect(signedTenths(30)).toBe("+3");
    expect(signedTenths(0)).toBe("±0");
    expect(plain(pctAbs(-2_140))).toBe("21 %");
    expect(hundredthsFixed(472)).toBe("4,72");
    expect(hundredthsFixed(-350)).toBe("−3,50");
    expect(listText(["A", "B", "C"])).toBe("A, B och C");
    expect(listText(["A"])).toBe("A");
    expect(listText([])).toBe("");
  });
});

describe("marketEvidence", () => {
  it("sorterade unika listor och inköps-id", () => {
    const e = marketEvidence({ rule: "r", purchaseIds: ["p2", "p1", "p2"], titleIds: ["b", "a"] });
    expect(e.purchaseIds).toEqual(["p1", "p2"]);
    expect(e.titleIds).toEqual(["a", "b"]);
    expect(e.orderIds).toEqual([]);
    expect(e.figures).toEqual([]);
  });
});
