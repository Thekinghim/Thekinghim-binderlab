import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import {
  DEFAULT_SIMILARITY_WEIGHTS,
  normalizeAttribute,
  numericMatchBp,
  rankBySimilarity,
  storeSimilarity,
} from "./similarity";
import { STORES } from "./test-fixtures";

const target = STORES[0]!; // Ica Nära Söder: livs, Malmö, 98 h, 400 m²
const byId = (id: string) => STORES.find((s) => s.id === id)!;

describe("normalizeAttribute", () => {
  it("trimmar, gör gemener och slår ihop mellanslag", () => {
    expect(normalizeAttribute("  Livs   Butik ")).toBe("livs butik");
    expect(normalizeAttribute("MALMÖ")).toBe("malmö");
  });
  it("tom text och null blir null", () => {
    expect(normalizeAttribute("   ")).toBeNull();
    expect(normalizeAttribute(null)).toBeNull();
    expect(normalizeAttribute(undefined)).toBeNull();
  });
});

describe("numericMatchBp", () => {
  it("lika värden ger 100 %", () => {
    expect(numericMatchBp(98, 98)).toBe(10_000);
    expect(numericMatchBp(0, 0)).toBe(10_000);
  });
  it("100 % − |a − b| / max(a, b), avrundat", () => {
    // 14 / 98 = 0,142857 → 1 429 bp → 8 571
    expect(numericMatchBp(98, 84)).toBe(8_571);
    expect(numericMatchBp(84, 98)).toBe(8_571);
    // 50 / 400 = 12,5 %
    expect(numericMatchBp(400, 350)).toBe(8_750);
    expect(numericMatchBp(0, 10)).toBe(0);
  });
  it("kastar för negativa tal och decimaltal", () => {
    expect(() => numericMatchBp(-1, 5)).toThrow(DomainError);
    expect(() => numericMatchBp(1.5, 5)).toThrow(DomainError);
  });
});

describe("storeSimilarity", () => {
  it("samma butik ger 100 %", () => {
    const s = storeSimilarity(target, target);
    expect(s.scoreBp).toBe(10_000);
    expect(s.text).toBe(
      "samma butikstyp (livs), samma ort (Malmö), öppet 98 h/vecka som målbutiken, 400 m² som målbutiken",
    );
  });

  it("väger attributen: Coop Väster 95 % lik (skiftläge och mellanslag spelar ingen roll)", () => {
    // 4 000 × 100 % + 2 500 × 100 % + 2 000 × 85,71 % + 1 500 × 87,5 % = 9 526,7 → 9 527
    const s = storeSimilarity(target, byId("s-3"));
    expect(s.scoreBp).toBe(9_527);
    expect(s.parts.map((p) => p.matchBp)).toEqual([10_000, 10_000, 8_571, 8_750]);
    expect(s.parts[2]!.text).toBe("öppet 84 h/vecka mot 98 h (86 % lika)");
  });

  it("annan ort ger 0 för orten", () => {
    expect(storeSimilarity(target, byId("s-4")).scoreBp).toBe(7_500);
    expect(storeSimilarity(target, byId("s-4")).parts[1]!.text).toBe("annan ort (Lund mot Malmö)");
  });

  it("annan butikstyp: Pressbyrån 45 %", () => {
    // 0 + 2 500 + 2 000 × 87,5 % + 1 500 × 15 % = 4 475
    expect(storeSimilarity(target, byId("s-2")).scoreBp).toBe(4_475);
  });

  it("okända värden ger 0 för attributet", () => {
    const s = storeSimilarity(target, byId("s-5"));
    expect(s.scoreBp).toBe(0);
    expect(s.parts[2]!.text).toBe("öppettider okänd");
    const unknownTarget = { storeType: null, city: "Malmö", openHoursPerWeek: null, areaSqm: null };
    expect(storeSimilarity(unknownTarget, target).scoreBp).toBe(2_500);
  });

  it("egna vikter normaliseras med summan", () => {
    const onlyCity = { storeType: 0, city: 1, openHours: 0, area: 0 };
    expect(storeSimilarity(target, byId("s-2"), onlyCity).scoreBp).toBe(10_000);
    expect(storeSimilarity(target, byId("s-4"), onlyCity).scoreBp).toBe(0);
    // Attribut med vikt 0 syns inte i texten.
    expect(storeSimilarity(target, byId("s-2"), onlyCity).text).toBe("samma ort (Malmö)");
  });

  it("kastar för ogiltiga vikter", () => {
    const zero = { storeType: 0, city: 0, openHours: 0, area: 0 };
    expect(() => storeSimilarity(target, target, zero)).toThrow(DomainError);
    expect(() =>
      storeSimilarity(target, target, { ...DEFAULT_SIMILARITY_WEIGHTS, city: -1 }),
    ).toThrow(DomainError);
  });
});

describe("rankBySimilarity", () => {
  it("högst likhet först, lika likhet i id-ordning", () => {
    const twin = { ...target, id: "s-0", name: "Tvilling" };
    const ranked = rankBySimilarity(target, [...STORES, twin]);
    expect(ranked.map((r) => [r.storeId, r.scoreBp])).toEqual([
      ["s-0", 10_000],
      ["s-1", 10_000],
      ["s-3", 9_527],
      ["s-4", 7_500],
      ["s-2", 4_475],
      ["s-5", 0],
    ]);
  });

  it("oberoende av indataordningen", () => {
    const a = rankBySimilarity(target, STORES);
    const b = rankBySimilarity(target, [...STORES].reverse());
    expect(b).toEqual(a);
  });
});
