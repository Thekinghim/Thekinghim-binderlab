import { describe, expect, it } from "vitest";
import { TIER, fuzzyMatch, fuzzyRank, highlightSegments, matchFields, normalize } from "./fuzzy";

describe("normalize", () => {
  it("gör gemener och behåller längden", () => {
    expect(normalize("Försäljning")).toBe("försäljning");
    expect(normalize("BL-001")).toBe("bl-001");
  });
  it("behåller å ä ö som egna bokstäver", () => {
    expect(normalize("ÅÄÖ")).toBe("åäö");
  });
  it("tar bort övrig diakritik", () => {
    expect(normalize("Café Müller")).toBe("cafe muller");
  });
});

describe("fuzzyMatch", () => {
  it("prefix", () => {
    const m = fuzzyMatch("för", "Försäljning");
    expect(m?.tier).toBe(TIER.prefix);
    expect(m?.indices).toEqual([0, 1, 2]);
  });
  it("ordstart", () => {
    const m = fuzzyMatch("scan", "Mall of Scandinavia");
    expect(m?.tier).toBe(TIER.wordStart);
    expect(m?.indices).toEqual([8, 9, 10, 11]);
  });
  it("siffror efter bindestreck räknas som ordstart", () => {
    expect(fuzzyMatch("001", "BL-001")?.tier).toBe(TIER.wordStart);
  });
  it("delsträng", () => {
    const m = fuzzyMatch("älj", "Försäljning");
    expect(m?.tier).toBe(TIER.substring);
    expect(m?.indices).toEqual([4, 5, 6]);
  });
  it("subsekvens", () => {
    const m = fuzzyMatch("fsg", "Försäljning");
    expect(m?.tier).toBe(TIER.subsequence);
    expect(m?.indices).toEqual([0, 3, 10]);
  });
  it("subsekvens föredrar ordstart", () => {
    const m = fuzzyMatch("rp", "Registrera påfyllning");
    expect(m?.indices).toEqual([0, 11]);
  });
  it("skiftlägesokänslig", () => {
    expect(fuzzyMatch("MALL", "Mall of Scandinavia")?.tier).toBe(TIER.prefix);
  });
  it("a matchar inte å, o matchar inte ö", () => {
    expect(fuzzyMatch("ovreally", "Översikt")).toBeNull();
    expect(fuzzyMatch("oversikt", "Översikt")).toBeNull();
    expect(fuzzyMatch("över", "Översikt")?.tier).toBe(TIER.prefix);
    expect(fuzzyMatch("pafyll", "Registrera påfyllning")).toBeNull();
  });
  it("é matchar e", () => {
    expect(fuzzyMatch("cafe", "Café")?.tier).toBe(TIER.prefix);
  });
  it("flera ord matchas var för sig", () => {
    const m = fuzzyMatch("rapport butik", "Skapa rapport till butik");
    expect(m?.tier).toBe(TIER.wordStart);
    const m2 = fuzzyMatch("butik rapport", "Skapa rapport till butik");
    expect(m2?.tier).toBe(TIER.wordStart);
    expect(m2?.indices).toEqual([6, 7, 8, 9, 10, 11, 12, 19, 20, 21, 22, 23]);
  });
  it("saknad bokstav ger null", () => {
    expect(fuzzyMatch("xyz", "Försäljning")).toBeNull();
    expect(fuzzyMatch("", "Försäljning")).toBeNull();
  });
});

describe("matchFields och fuzzyRank", () => {
  it("träff i nyckelord kräver minst delsträng", () => {
    expect(matchFields("sna", { label: "Mall of Scandinavia", keywords: ["Solna"] })?.field).toBe(
      "label",
    );
    expect(matchFields("sln", { label: "Westfield", keywords: ["Solna"] })).toBeNull();
    expect(matchFields("soln", { label: "Westfield", keywords: ["Solna"] })?.field).toBe("keyword");
  });
  it("hint matchas och markeras", () => {
    const m = matchFields("bl-01", { label: "Mobilia", hint: "BL-010" });
    expect(m?.field).toBe("hint");
    expect(m?.indices).toEqual([0, 1, 2, 3, 4]);
  });
  it("rangordnar prefix > ordstart > delsträng > subsekvens", () => {
    const items = ["Skapa rapport", "Rapporter", "Exportera", "Registrera påfyllning"];
    const ranked = fuzzyRank(items, "rap", (label) => ({ label })).map((r) => r.item);
    expect(ranked).toEqual(["Rapporter", "Skapa rapport", "Registrera påfyllning"]);
  });
  it("etikettträff går före nyckelordsträff i samma tier", () => {
    const items = [
      { label: "Inställningar", keywords: ["lager"] },
      { label: "Lager", keywords: [] },
    ];
    const ranked = fuzzyRank(items, "lager", (i) => i).map((r) => r.item.label);
    expect(ranked).toEqual(["Lager", "Inställningar"]);
  });
});

describe("subsekvens med hopp till ordstart", () => {
  it("hoppar inte förbi en position som resten av frågan behöver", () => {
    const m = fuzzyMatch("tt", "Skapa rapport till bokhållare");
    expect(m?.tier).toBe(TIER.subsequence);
    expect(m?.indices).toEqual([12, 14]);
    expect(fuzzyMatch("ac", "xabc a")?.indices).toEqual([1, 3]);
    expect(fuzzyMatch("tti", "Byt till ljust läge")).not.toBeNull();
  });
  it("hittar varje subsekvens på tre tecken i exempeletiketterna", () => {
    const labels = [
      "Skapa rapport till bokhållare",
      "Byt till ljust läge",
      "Registrera påfyllning",
      "Exportera CSV",
      "Skapa rapport till butik",
    ];
    const isSubsequence = (q: string, t: string) => {
      let i = 0;
      for (const ch of t) if (ch === q[i]) i++;
      return i === q.length;
    };
    for (const label of labels) {
      const t = normalize(label).replace(/\s+/g, "");
      const chars = [...new Set(t)];
      for (const a of chars)
        for (const b of chars)
          for (const c of chars) {
            const q = a + b + c;
            if (!isSubsequence(q, normalize(label))) continue;
            expect(fuzzyMatch(q, label), `${q} i ${label}`).not.toBeNull();
          }
    }
  });
});

describe("highlightSegments", () => {
  it("delar upp i matchade och omatchade delar", () => {
    expect(highlightSegments("Försäljning", [0, 3, 10])).toEqual([
      { text: "F", match: true },
      { text: "ör", match: false },
      { text: "s", match: true },
      { text: "äljnin", match: false },
      { text: "g", match: true },
    ]);
  });
  it("utan index blir hela texten omatchad", () => {
    expect(highlightSegments("Lager", [])).toEqual([{ text: "Lager", match: false }]);
  });
});
