import { describe, expect, it } from "vitest";

import { suggestionMeta } from "./suggestion-meta";

const plain = (s: string) => s.replace(/ /g, " ");

describe("förslagskortets rad under rubriken", () => {
  it("effekt, säkerhet och dagen siffrorna kommer från", () => {
    expect(
      plain(suggestionMeta({ effectSekMonth: 1500, confidence: "high", dataDate: "2026-11-04" })),
    ).toBe("≈ 1 500 kr/mån · säker · siffror från 4 nov.");
  });

  it("utan dag och utan effekt", () => {
    expect(suggestionMeta({ effectSekMonth: 0, confidence: "low" })).toBe("effekt okänd · test");
  });
});
