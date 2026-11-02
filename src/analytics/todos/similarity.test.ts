import { describe, expect, it } from "vitest";
import { compareTitles, damerauLevenshtein, normalizeTitle } from "./similarity";

describe("normalizeTitle", () => {
  it("gemener, accenter bort (utom å ä ö), skiljetecken blir mellanslag", () => {
    expect(normalizeTitle("  Black-Bolt ")).toBe("black bolt");
    expect(normalizeTitle("Pokémon 151")).toBe("pokemon 151");
    expect(normalizeTitle("Ägg & Öl")).toBe("ägg öl");
    expect(normalizeTitle("Scarlet/Violet: 151")).toBe("scarlet violet 151");
    expect(normalizeTitle("---")).toBe("");
  });
});

describe("damerauLevenshtein", () => {
  it("räknar infogning, borttag, utbyte och byte av grannar som 1", () => {
    expect(damerauLevenshtein("", "abc")).toBe(3);
    expect(damerauLevenshtein("abc", "")).toBe(3);
    expect(damerauLevenshtein("bolt", "bolt")).toBe(0);
    expect(damerauLevenshtein("bolt", "blot")).toBe(1);
    expect(damerauLevenshtein("bolt", "bolts")).toBe(1);
    expect(damerauLevenshtein("bolt", "belt")).toBe(1);
    expect(damerauLevenshtein("kitten", "sitting")).toBe(3);
    expect(damerauLevenshtein("ca", "abc")).toBe(3); // optimal string alignment
  });
});

describe("compareTitles", () => {
  it("'Black bolt' och 'Black Bolt' är samma titel", () => {
    const r = compareTitles("Black bolt", "Black Bolt");
    expect(r).toMatchObject({ duplicate: true, reason: "same", distance: 0, similarityBp: 10_000 });
  });

  it("'Mystery Pack' och 'Mystery pack premium' är INTE samma titel", () => {
    expect(compareTitles("Mystery Pack", "Mystery pack premium").duplicate).toBe(false);
    expect(compareTitles("Mystery pack premium", "Mystery Pack").duplicate).toBe(false);
  });

  it("mellanslag och ordföljd", () => {
    expect(compareTitles("Blackbolt", "Black Bolt").reason).toBe("spacing");
    expect(compareTitles("Bolt Black", "Black Bolt").reason).toBe("word-order");
    expect(compareTitles("Pokémon 151", "Pokemon 151").reason).toBe("same");
  });

  it("felstavning inom gränsen", () => {
    expect(compareTitles("Surging Sparks", "Surgnig Sparks").reason).toBe("typo");
    expect(compareTitles("Paldea Evolved", "Paldea Evolvd").reason).toBe("typo");
    expect(compareTitles("Prismatic Evolutions", "Prismatic Evolution").reason).toBe("typo");
    expect(compareTitles("30th Celebration", "30th Celebraton").reason).toBe("typo");
  });

  it("för många fel, korta ord och olika siffror är olika titlar", () => {
    expect(compareTitles("Black Bolt", "Blakc Bott").duplicate).toBe(false); // 2 fel i kort namn
    expect(compareTitles("Series 1", "Series 2").duplicate).toBe(false);
    expect(compareTitles("Booster EX", "Booster GX").duplicate).toBe(false);
    expect(compareTitles("Stellar Crown", "Shrouded Fable").duplicate).toBe(false);
    expect(compareTitles("Pack", "Park").duplicate).toBe(true); // 4 tecken, 1 fel: tillåtet
    expect(compareTitles("Box", "Bix").duplicate).toBe(false); // under 4 tecken
  });

  it("tomma namn är aldrig dubbletter", () => {
    expect(compareTitles("", "").duplicate).toBe(false);
    expect(compareTitles("!!", "??").duplicate).toBe(false);
  });

  it("är symmetrisk", () => {
    const pairs: [string, string][] = [
      ["Black bolt", "Black Bolt"],
      ["Surging Sparks", "Surgnig Sparks"],
      ["Mystery Pack", "Mystery pack premium"],
      ["Series 1", "Series 2"],
    ];
    for (const [a, b] of pairs) expect(compareTitles(a, b)).toEqual(compareTitles(b, a));
  });
});
