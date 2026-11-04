import { describe, expect, it } from "vitest";

import { costLinesFrom } from "./cost-lines";

describe("costLinesFrom", () => {
  it("bara vinstdelning utan hyra och inga fasta kostnader: inget visas", () => {
    expect(costLinesFrom([{ monthlyRentOre: null }], 0)).toEqual({ rent: false, fixed: false });
  });
  it("hyra 0 kr räknas som ingen hyra", () => {
    expect(costLinesFrom([{ monthlyRentOre: 0 }], 0).rent).toBe(false);
  });
  it("ett avtal med hyra och en fast kostnad: raderna kommer tillbaka", () => {
    expect(costLinesFrom([{ monthlyRentOre: null }, { monthlyRentOre: 90_000 }], 1)).toEqual({
      rent: true,
      fixed: true,
    });
  });
});
