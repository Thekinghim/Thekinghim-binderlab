import { describe, expect, it } from "vitest";

import { amountsAlike } from "./view";

const plain = (s: string[]) => s.map((t) => t.replace(/[  ]/g, " "));

describe("amountsAlike (Bokförings siffror i samma form)", () => {
  it("ett belopp med ören: alla får två decimaler", () => {
    expect(plain(amountsAlike([8_164_520, 3_000_000, -120_000]))).toEqual([
      "81 645,20 kr",
      "30 000,00 kr",
      "−1 200,00 kr",
    ]);
  });
  it("inga ören: hela kronor", () => {
    expect(plain(amountsAlike([8_164_500, 3_000_000]))).toEqual(["81 645 kr", "30 000 kr"]);
  });
});
