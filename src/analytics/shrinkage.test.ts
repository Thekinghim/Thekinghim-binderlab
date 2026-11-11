import { describe, expect, it } from "vitest";

import {
  buildShrinkage,
  isFlagged,
  shrinkageHeadline,
  shrinkageHomeLine,
  type ShrinkageAggregate,
} from "./shrinkage";

const plain = (s: string | null) => s?.replace(/\u00a0/g, " ") ?? null;

const names = {
  machines: [
    { id: "m1", code: "BL-001", name: "Automat 1", storeId: "s1" },
    { id: "m2", code: "BL-002", name: "Automat 2", storeId: null },
  ],
  stores: [{ id: "s1", name: "ICA Lund" }],
  titles: [
    { id: "t1", name: "151 Booster" },
    { id: "t2", name: "Surging Sparks" },
  ],
};

function agg(over: Partial<ShrinkageAggregate>): ShrinkageAggregate {
  return {
    machineId: "m1",
    titleId: "t1",
    refilled: 10,
    sold: 8,
    removed: 0,
    adjusted: 0,
    deviation: 0,
    compared: 2,
    opening: 5,
    closing: 7,
    unitCostOre: 4_000,
    ...over,
  };
}

describe("isFlagged", () => {
  it("kräver minst 3 pack och minst 5 % av flödet", () => {
    expect(isFlagged(2, 0)).toBe(false);
    expect(isFlagged(3, 0)).toBe(true);
    expect(isFlagged(3, 60)).toBe(true);
    expect(isFlagged(3, 61)).toBe(false);
    expect(isFlagged(10, 200)).toBe(true);
  });
});

describe("buildShrinkage", () => {
  it("flaggar saknade pack över tröskeln, med värde till inköpspris", () => {
    const r = buildShrinkage(
      [
        agg({ deviation: -4 }),
        agg({ titleId: "t2", deviation: -1 }),
        agg({ machineId: "m2", deviation: 0 }),
      ],
      names,
    );
    expect(r.missing).toBe(4);
    expect(r.valueOre).toBe(16_000);
    expect(r.flaggedLines).toBe(1);
    expect(r.flagged.map((m) => m.code)).toEqual(["BL-001"]);
    expect(r.flagged[0]?.storeName).toBe("ICA Lund");
    expect(r.flagged[0]?.lines[0]).toMatchObject({ titleName: "151 Booster", flagged: true });
    // Ett pack under tröskeln flaggas inte men visas.
    expect(r.flagged[0]?.lines[1]).toMatchObject({ missing: 1, flagged: false, state: "missing" });
    expect(r.ok.map((m) => m.code)).toEqual(["BL-002"]);
    expect(r.headline.title).toContain("4");
    expect(plain(shrinkageHomeLine(r))).toBe("4 pack borta ur BL-001 (svinn).");
  });

  it("fler pack än väntat flaggas aldrig", () => {
    const r = buildShrinkage([agg({ deviation: 12 })], names);
    expect(r.missing).toBe(0);
    expect(r.ok[0]?.lines[0]).toMatchObject({ state: "extra", missing: -12, flagged: false });
    expect(shrinkageHomeLine(r)).toBeNull();
    expect(r.headline.title).toBe("Inget saknas.");
  });

  it("utan räkning att jämföra är raden okänd", () => {
    const r = buildShrinkage([agg({ deviation: null, compared: 0 })], names);
    expect(r.unknownLines).toBe(1);
    expect(r.ok[0]?.lines[0]?.state).toBe("unknown");
    expect(r.headline.title).toBe("Inget att jämföra än.");
  });

  it("värdet saknas när en flaggad titel saknar inköpspris", () => {
    const r = buildShrinkage(
      [agg({ deviation: -5 }), agg({ titleId: "t2", deviation: -3, unitCostOre: null })],
      names,
    );
    expect(r.missing).toBe(8);
    expect(r.valueOre).toBeNull();
  });

  it("flest saknade först", () => {
    const r = buildShrinkage(
      [agg({ deviation: -3 }), agg({ machineId: "m2", deviation: -9 })],
      names,
    );
    expect(r.flagged.map((m) => m.code)).toEqual(["BL-002", "BL-001"]);
    expect(plain(shrinkageHomeLine(r))).toBe("12 pack borta ur 2 automater (svinn).");
  });
});

describe("shrinkageHeadline", () => {
  it("visar värdet när det finns", () => {
    expect(
      shrinkageHeadline({ missing: 3, machines: 1, valueOre: 12_000, compared: true }).aside,
    ).toMatch(/I 1\s+automat · 120/);
  });

  it("utan registrerade påfyllningar säger rubriken det (inte 'Påfyllt 0' som svinn)", () => {
    const r = buildShrinkage(
      [
        agg({ refilled: 0, sold: 156, deviation: null, compared: 0 }),
        agg({ titleId: "t2", refilled: 0 }),
      ],
      names,
    );
    expect(r.headline.aside).toBe("Ingen påfyllning registrerad än.");
    expect(r.ok[0]?.refilled).toBe(0);
  });

  it("med påfyllningar men utan räkning väntar jämförelsen på nästa räkning", () => {
    const r = buildShrinkage([agg({ deviation: null, compared: 0 })], names);
    expect(r.headline).toEqual({
      title: "Inget att jämföra än.",
      aside: "Jämförelsen börjar efter nästa räkning.",
    });
  });
});
