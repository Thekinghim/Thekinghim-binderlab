import { describe, expect, it } from "vitest";

import { collectNumbers, extractNumbers, parseSwedishNumber, verifyNumbers } from "./verify";

const NB = " ";

describe("extractNumbers", () => {
  it("läser svenska tal med hårt mellanslag, decimalkomma och minus", () => {
    expect(
      extractNumbers(`Vinst 12${NB}480${NB}kr, marginal 23,7${NB}%, förlust −1${NB}240 kr.`),
    ).toEqual([`12${NB}480`, "23,7", `1${NB}240`]);
  });

  it("hoppar över datum, årtal, klockslag, veckor och id", () => {
    const text =
      "I oktober 2026 (1–31 okt.) sålde BL‑002 och BL-003 mest, senast 13 okt. kl. 09:05 och vecka 44. Datum 2026-10-01.";
    expect(extractNumbers(text)).toEqual([]);
  });

  it("hoppar över numrerade listor men inte tal i raden", () => {
    expect(extractNumbers("1. Automat 3: 4 120 kr\n2. Automat 1: 980 kr")).toEqual([
      "3",
      "4 120",
      "1",
      "980",
    ]);
  });
});

describe("parseSwedishNumber", () => {
  it("tolkar mellanslag och decimalkomma", () => {
    expect(parseSwedishNumber(`12${NB}480,5`)).toBe(12480.5);
    expect(parseSwedishNumber("abc")).toBeNull();
  });
});

describe("collectNumbers", () => {
  it("räknar om öre, baspunkter och tusendelar och läser tal i texter", () => {
    const set = collectNumbers([
      {
        profitOre: 1_248_050,
        marginBp: 2370,
        unitsMilli: 1500,
        text: `4${NB}120${NB}kr`,
        rows: [1, 2, 3],
      },
    ]);
    expect(set.has("12480.50")).toBe(true);
    expect(set.has("12481.00")).toBe(true); // hela kronor
    expect(set.has("23.70")).toBe(true);
    expect(set.has("1.50")).toBe(true);
    expect(set.has("4120.00")).toBe(true);
    expect(set.has("3.00")).toBe(true); // antal rader
  });
});

describe("verifyNumbers", () => {
  const sources = [
    {
      rader: [
        { namn: "Automat 3", intakt: `7${NB}964${NB}kr`, intaktOre: 796_400, marginBp: 2513 },
        { namn: "Automat 1", intakt: `3${NB}120${NB}kr`, intaktOre: 312_000, marginBp: 1800 },
      ],
    },
  ];

  it("godkänner tal som finns i underlaget", () => {
    const answer = `Automat 3 tjänade mest i oktober 2026: 7${NB}964 kr i intäkt, marginal 25,1 %.`;
    expect(verifyNumbers(answer, sources)).toEqual({ checked: 3, unverified: [] });
  });

  it("markerar tal som inte finns (avrundning, uppskattning)", () => {
    const answer = `Ungefär 8 tkr, alltså cirka 11 000 kr totalt för 2 automater.`;
    const result = verifyNumbers(answer, sources);
    expect(result.unverified).toEqual(["11 000"]);
  });

  it("godtar tal från frågan", () => {
    const result = verifyNumbers("De 5 bästa titlarna …", [
      sources[0],
      "Vilka är de 5 bästa titlarna?",
    ]);
    expect(result.unverified).toEqual([]);
  });
});
