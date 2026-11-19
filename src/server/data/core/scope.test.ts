import { describe, expect, it } from "vitest";

import {
  resolveOwnerScope,
  scopeFiltered,
  scopeStoreIds,
  storeInScope,
  storeScoped,
} from "./scope";

const NONE = { storeId: null, machineId: null };

describe("filtret på butik eller butiksägare", () => {
  const stores = [
    { id: "s1", ownerId: "o1" },
    { id: "s2", ownerId: "o1" },
    { id: "s3", ownerId: null },
  ];

  it("en ägare blir sina butiker; en vald butik vinner", () => {
    expect(resolveOwnerScope({ ...NONE, ownerId: "o1" }, stores).storeIds).toEqual(["s1", "s2"]);
    expect(resolveOwnerScope({ ...NONE, ownerId: "o9" }, stores).storeIds).toEqual([]);
    expect(resolveOwnerScope({ ...NONE, storeId: "s3", ownerId: "o1" }, stores)).toEqual({
      storeId: "s3",
      machineId: null,
      ownerId: null,
      storeIds: ["s3"],
    });
    expect(resolveOwnerScope(NONE, stores).storeIds).toBeNull();
  });

  it("butikerna i filtret och om en butik ingår", () => {
    expect(scopeStoreIds(NONE)).toBeNull();
    expect(scopeStoreIds({ ...NONE, storeId: "s3" })).toEqual(["s3"]);
    // En ägare som inte lösts upp än: inga butiker, aldrig "alla".
    expect(scopeStoreIds({ ...NONE, ownerId: "o1" })).toEqual([]);
    const owner = { ...NONE, ownerId: "o1", storeIds: ["s1", "s2"] };
    expect(storeInScope(owner, "s2")).toBe(true);
    expect(storeInScope(owner, "s3")).toBe(false);
    expect(storeInScope(owner, null)).toBe(false);
    expect(storeInScope(NONE, null)).toBe(true);
  });

  it("vad som räknas som filter", () => {
    expect(storeScoped({ ...NONE, ownerId: "o1" })).toBe(true);
    expect(storeScoped({ ...NONE, machineId: "m1" })).toBe(false);
    expect(scopeFiltered({ ...NONE, machineId: "m1" })).toBe(true);
    expect(scopeFiltered(NONE)).toBe(false);
  });
});
