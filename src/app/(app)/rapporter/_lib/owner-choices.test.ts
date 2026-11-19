import { describe, expect, it } from "vitest";

import { ownerReportChoices } from "./owner-choices";

describe("butiksägare på Rapporter", () => {
  it("bara ägare med minst två butiker som hade automat i perioden", () => {
    const owners = [
      { id: "o1", name: "Godisbolaget Väst AB", archived: false },
      { id: "o2", name: "Annat AB", archived: false },
    ];
    const stores = [
      { id: "s1", ownerId: "o1", archived: false },
      { id: "s2", ownerId: "o1", archived: false },
      { id: "s3", ownerId: "o1", archived: false },
      { id: "s4", ownerId: "o2", archived: false },
      { id: "s5", ownerId: "o2", archived: false },
    ];
    const period = [
      { id: "s1", name: "Alfa" },
      { id: "s3", name: "Gamma" },
      { id: "s4", name: "Delta" },
    ];
    expect(ownerReportChoices(owners, stores, period)).toEqual([
      {
        id: "o1",
        name: "Godisbolaget Väst AB",
        stores: [
          { id: "s1", name: "Alfa" },
          { id: "s3", name: "Gamma" },
        ],
      },
    ]);
  });
});
