import { describe, expect, it } from "vitest";

import { classifySwaps, detectSwaps, swapNote, type DetectSwapsInput } from "./product-swap";

const base = (over: Partial<DetectSwapsInput> = {}): DetectSwapsInput => ({
  previous: new Map([
    ["A", ["A1", "A2"]],
    ["C", ["A3"]],
  ]),
  current: [
    { channel: "A1", titleId: "A" },
    { channel: "A2", titleId: "B" },
    { channel: "A3", titleId: "C" },
  ],
  unitsNow: new Map([
    ["A", 3],
    ["B", 8],
    ["C", 5],
  ]),
  levels: new Map([
    ["A", { quantity: 7, counted: true }],
    ["C", { quantity: 5, counted: true }],
  ]),
  syncedBefore: true,
  ...over,
});

describe("detectSwaps", () => {
  it("ett fack som bytt titel: A tillbaka, ny titel B tas ur lagret", () => {
    expect(detectSwaps(base())).toEqual([
      { channel: "A2", fromTitleId: "A", toTitleId: "B", returned: 4, taken: 8 },
    ]);
  });

  it("inget byte vid första läsningen eller utan förra läsningens fack", () => {
    expect(detectSwaps(base({ syncedBefore: false }))).toEqual([]);
    expect(detectSwaps(base({ previous: new Map() }))).toEqual([]);
  });

  it("väntar en annan titel på Awish hittas bytet ändå (bara väntande titlar skjuts upp)", () => {
    const r = classifySwaps(base({ unsent: new Set(["C"]) }));
    expect(r.swaps).toEqual([
      { channel: "A2", fromTitleId: "A", toTitleId: "B", returned: 4, taken: 8 },
    ]);
    expect(r.deferred).toEqual([]);
  });

  it("väntar A eller B på Awish skjuts facket upp", () => {
    expect(classifySwaps(base({ unsent: new Set(["A"]) }))).toEqual({
      swaps: [],
      deferred: ["A2"],
      renamed: [],
    });
    expect(classifySwaps(base({ unsent: new Set(["B"]) })).deferred).toEqual(["A2"]);
  });

  it("namnbyte i Awish (ny titel, gamla namnet borta ur automaten) flyttar inga pack", () => {
    const r = classifySwaps(
      base({
        current: [
          { channel: "A1", titleId: "A" },
          { channel: "A2", titleId: "A" },
          { channel: "A3", titleId: "C2" },
        ],
        unitsNow: new Map([
          ["A", 7],
          ["C2", 5],
        ]),
        newTitles: new Set(["C2"]),
      }),
    );
    expect(r.swaps).toEqual([]);
    expect(r.renamed).toEqual([{ channel: "A3", fromTitleId: "C", toTitleId: "C2" }]);
  });

  it("ny titel medan den gamla finns kvar i ett annat fack är ett byte", () => {
    const r = classifySwaps(base({ newTitles: new Set(["B"]) }));
    expect(r.swaps).toHaveLength(1);
    expect(r.renamed).toEqual([]);
  });

  it("samma fack som förut ger inget byte (vanlig påfyllning)", () => {
    expect(
      detectSwaps(
        base({
          current: [
            { channel: "A1", titleId: "A" },
            { channel: "A2", titleId: "A" },
            { channel: "A3", titleId: "C" },
          ],
          unitsNow: new Map([
            ["A", 16],
            ["C", 5],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it("påfyllning och byte samtidigt: A ökade i sitt andra fack, inget går tillbaka", () => {
    // A hade 7, A1 fylldes på till 8 medan A2 byttes till B: A har fler nu än före.
    const out = detectSwaps(
      base({
        unitsNow: new Map([
          ["A", 8],
          ["B", 8],
          ["C", 5],
        ]),
      }),
    );
    expect(out).toEqual([
      { channel: "A2", fromTitleId: "A", toTitleId: "B", returned: 0, taken: 8 },
    ]);
  });

  it("B med räknat saldo: ökningen dras av påfyllningsregeln, inte här", () => {
    const out = detectSwaps(
      base({
        levels: new Map([
          ["A", { quantity: 7, counted: true }],
          ["B", { quantity: 2, counted: true }],
          ["C", { quantity: 5, counted: true }],
        ]),
      }),
    );
    expect(out[0]).toMatchObject({ returned: 4, taken: 0 });
  });

  it("A utan räknat saldo: inget tillbaka (vi vet inte vad som fanns)", () => {
    const out = detectSwaps(base({ levels: new Map([["C", { quantity: 5, counted: true }]]) }));
    expect(out[0]).toMatchObject({ returned: 0, taken: 8 });
  });

  it("två bytta fack för samma titlar: talen står bara på det första", () => {
    const out = detectSwaps(
      base({
        current: [
          { channel: "A2", titleId: "B" },
          { channel: "A1", titleId: "B" },
          { channel: "A3", titleId: "C" },
        ],
        unitsNow: new Map([
          ["B", 12],
          ["C", 5],
        ]),
      }),
    );
    expect(out).toEqual([
      { channel: "A1", fromTitleId: "A", toTitleId: "B", returned: 7, taken: 12 },
      { channel: "A2", fromTitleId: "A", toTitleId: "B", returned: 0, taken: 0 },
    ]);
  });

  it("två titlar byter plats: varje titel får tillbaka sitt eget", () => {
    const out = detectSwaps(
      base({
        current: [
          { channel: "A1", titleId: "C" },
          { channel: "A2", titleId: "C" },
          { channel: "A3", titleId: "A" },
        ],
        unitsNow: new Map([
          ["A", 2],
          ["C", 9],
        ]),
      }),
    );
    // C hade ett räknat saldo: ökningen dras av påfyllningsregeln (taken 0).
    expect(out).toEqual([
      { channel: "A1", fromTitleId: "A", toTitleId: "C", returned: 5, taken: 0 },
      { channel: "A2", fromTitleId: "A", toTitleId: "C", returned: 0, taken: 0 },
      { channel: "A3", fromTitleId: "C", toTitleId: "A", returned: 0, taken: 0 },
    ]);
  });

  it("noteringen", () => {
    expect(swapNote("A3", "Black Bolt", "Surging Sparks")).toBe(
      "Produktbyte A3: Black Bolt → Surging Sparks",
    );
  });
});
