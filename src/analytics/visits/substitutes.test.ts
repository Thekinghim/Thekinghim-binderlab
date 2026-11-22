import { describe, expect, it } from "vitest";

import { suggestSubstitutes } from "./substitutes";

const names: Record<string, string> = { a: "Pokémon 151", b: "Surging Sparks", c: "Black Bolt" };
const titleName = (id: string) => names[id] ?? id;

describe("suggestSubstitutes", () => {
  it("föreslår titeln vi har mest kvar av hemma, i hela fack", () => {
    const out = suggestSubstitutes({
      stops: [
        {
          machineId: "m1",
          lines: [
            {
              titleId: "a",
              titleName: "Pokémon 151",
              shortBy: 12,
              capacity: 30,
              channels: ["A1", "A2", "A3"],
            },
          ],
        },
      ],
      home: new Map([
        ["a", 4],
        ["b", 100],
        ["c", 50],
      ]),
      load: new Map([
        ["a", 4],
        ["b", 20],
      ]),
      titleName,
    });
    // Fackets djup 10: 12 saknas → två hela fack (20 pack) Surging Sparks (80 kvar hemma).
    expect(out).toEqual([
      {
        machineId: "m1",
        forTitleId: "a",
        forTitleName: "Pokémon 151",
        titleId: "b",
        titleName: "Surging Sparks",
        packs: 20,
        slots: 2,
      },
    ]);
  });

  it("samma pack föreslås aldrig två gånger, och utan ett helt fack hemma: inget förslag", () => {
    const line = {
      titleId: "a",
      titleName: "Pokémon 151",
      shortBy: 10,
      capacity: 10,
      channels: ["A1"],
    };
    const out = suggestSubstitutes({
      stops: [
        { machineId: "m1", lines: [line] },
        { machineId: "m2", lines: [line] },
      ],
      home: new Map([["b", 15]]),
      load: new Map(),
      titleName,
    });
    expect(out.map((s) => [s.machineId, s.titleId, s.packs])).toEqual([["m1", "b", 10]]);
  });

  it("utan kända fack: bristen, högst det som finns; mystery packs och samma titel föreslås inte", () => {
    const out = suggestSubstitutes({
      stops: [
        {
          machineId: "m1",
          lines: [
            { titleId: "a", titleName: "Pokémon 151", shortBy: 8, capacity: null, channels: [] },
          ],
        },
      ],
      home: new Map([
        ["a", 500],
        ["mp", 900],
        ["c", 5],
      ]),
      load: new Map([["a", 500]]),
      titleName,
      exclude: new Set(["mp"]),
    });
    expect(out.map((s) => [s.titleId, s.packs, s.slots])).toEqual([["c", 5, 1]]);
  });
});
