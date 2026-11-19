import { describe, expect, it } from "vitest";

import {
  ownerChoices,
  ownerFromOptionValue,
  ownerOptionLabel,
  ownerOptionValue,
} from "./owner-filter";

describe("butiksägaren i filtret", () => {
  it("värdet skiljer en ägare från en butik", () => {
    expect(ownerOptionValue("o1")).toBe("agare:o1");
    expect(ownerFromOptionValue("agare:o1")).toBe("o1");
    expect(ownerFromOptionValue("s1")).toBeNull();
    expect(ownerFromOptionValue(null)).toBeNull();
  });

  it("etiketten har namnet och antalet butiker", () => {
    expect(ownerOptionLabel({ name: "Godisbolaget Väst AB", storeIds: ["a", "b", "c"] })).toBe(
      "Godisbolaget Väst AB (3 butiker)",
    );
  });

  it("bara aktiva ägare med fler än en aktiv butik, i namnordning", () => {
    const owners = [
      { id: "o1", name: "Östra AB", archived: false },
      { id: "o2", name: "Ensam AB", archived: false },
      { id: "o3", name: "Arkiverad AB", archived: true },
      { id: "o4", name: "Alfa AB", archived: false },
    ];
    const stores = [
      { id: "s1", ownerId: "o1", archived: false },
      { id: "s2", ownerId: "o1", archived: false },
      { id: "s3", ownerId: "o2", archived: false },
      { id: "s4", ownerId: "o2", archived: true },
      { id: "s5", ownerId: "o3", archived: false },
      { id: "s6", ownerId: "o3", archived: false },
      { id: "s7", ownerId: "o4", archived: false },
      { id: "s8", ownerId: "o4", archived: false },
      { id: "s9", ownerId: null, archived: false },
    ];
    expect(ownerChoices(owners, stores)).toEqual([
      { id: "o4", name: "Alfa AB", storeIds: ["s7", "s8"] },
      { id: "o1", name: "Östra AB", storeIds: ["s1", "s2"] },
    ]);
  });
});
