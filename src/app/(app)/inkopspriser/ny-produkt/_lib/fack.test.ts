import { describe, expect, it } from "vitest";

import { goodsPreselect, goodsTab, initialSlotMachine, pickPreselectedGood } from "./fack";

const T = "0b6c8a0e-1f2a-4c3d-9e8f-0123456789ab";

describe("goodsTab", () => {
  it("fack och ny är egna flikar, allt annat är Redigera vara", () => {
    expect(goodsTab("fack")).toBe("fack");
    expect(goodsTab("ny")).toBe("ny");
    expect(goodsTab(null)).toBe("redigera");
    expect(goodsTab("FACK")).toBe("redigera");
    expect(goodsTab("<script>")).toBe("redigera");
  });
});

describe("goodsPreselect", () => {
  it("läser vara och titel", () => {
    expect(goodsPreselect("42", T.toUpperCase())).toEqual({ goodId: 42, titleId: T });
  });
  it("ogiltiga värden ignoreras", () => {
    for (const v of ["0", "-1", "1.5", "1e3", "abc", "", "99999999999999999999"]) {
      expect(goodsPreselect(v, null).goodId).toBeNull();
    }
    expect(goodsPreselect(null, "inte-en-uuid").titleId).toBeNull();
  });
});

describe("initialSlotMachine", () => {
  it("en enda automat väljs alltid", () => {
    expect(initialSlotMachine([{ id: "a" }], null)).toBe("a");
    expect(initialSlotMachine([{ id: "a" }], "b")).toBe("a");
  });
  it("flera: den valda i Inköpspriser om den är kopplad, annars ingen", () => {
    const ms = [{ id: "a" }, { id: "b" }];
    expect(initialSlotMachine(ms, "b")).toBe("b");
    expect(initialSlotMachine(ms, "x")).toBe("");
    expect(initialSlotMachine(ms, null)).toBe("");
    expect(initialSlotMachine([], null)).toBe("");
  });
});

describe("pickPreselectedGood", () => {
  const goods = [{ id: 6 }, { id: 88 }];
  it("varan i adressen väljs om den finns i Awish", () => {
    expect(pickPreselectedGood({ goodId: 88, titleId: null }, goods, null)).toEqual({
      goodId: "88",
      notice: null,
    });
  });
  it("en vara som inte finns i Awish ignoreras", () => {
    const r = pickPreselectedGood({ goodId: 999, titleId: null }, goods, null);
    expect(r.goodId).toBe("");
    expect(r.notice).toMatch(/finns inte i Awish/);
  });
  it("titelns vara väljs; ingen vara säger till lugnt", () => {
    const want = { goodId: null, titleId: T };
    expect(pickPreselectedGood(want, goods, { titleName: "Mystery Pack", goodId: 6 })).toEqual({
      goodId: "6",
      notice: null,
    });
    expect(pickPreselectedGood(want, goods, { titleName: "Box", goodId: null })).toEqual({
      goodId: "",
      notice: "Ingen vara i Awish hör till Box. Välj vara i listan.",
    });
    // Okänd titel (annan organisation, raderad): inget val och ingen text.
    expect(pickPreselectedGood(want, goods, { titleName: null, goodId: null })).toEqual({
      goodId: "",
      notice: null,
    });
  });
  it("inget förval: inget väljs", () => {
    expect(pickPreselectedGood({ goodId: null, titleId: null }, goods, null)).toEqual({
      goodId: "",
      notice: null,
    });
  });
});
