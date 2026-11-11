import { describe, expect, it } from "vitest";

import { suggestionMeta } from "./suggestion-meta";

const plain = (s: string) => s.replace(/ /g, " ");

describe("förslagskortets rad under rubriken", () => {
  it("effekt, säkerhet och dagen siffrorna kommer från", () => {
    expect(
      plain(suggestionMeta({ effectSekMonth: 1500, confidence: "high", dataDate: "2026-11-04" })),
    ).toBe("≈ 1 500 kr/mån · säkert · siffror från 4 nov.");
  });

  it("orden är säkert, troligt och värt att prova, aldrig test", () => {
    const words = (["high", "medium", "low"] as const).map(
      (confidence) => suggestionMeta({ effectSekMonth: 0, confidence }).split(" · ")[1],
    );
    expect(words).toEqual(["säkert", "troligt", "värt att prova"]);
    expect(words.join(" ")).not.toMatch(/\btest\b/);
  });

  it("utan dag och utan effekt", () => {
    expect(suggestionMeta({ effectSekMonth: 0, confidence: "low" })).toBe(
      "effekt okänd · värt att prova",
    );
  });
});
