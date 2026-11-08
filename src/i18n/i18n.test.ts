import { describe, expect, it } from "vitest";

import { en } from "./en";
import { formatters } from "./format";
import { messages } from "./index";
import { isLocale, localeFromAcceptLanguage, requestLocale } from "./locale";
import { sv } from "./sv";

/** Alla nycklar som sökvägar ("fill.confirmYes"), med typen på värdet. */
function shape(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [`${prefix}:${typeof value}`];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => shape(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

describe("katalogerna", () => {
  it("svenska och engelska har exakt samma nycklar och samma sorts värden", () => {
    expect(shape(en)).toEqual(shape(sv));
  });

  it("inga tomma texter", () => {
    for (const cat of [sv, en]) {
      for (const path of shape(cat)) {
        const value = path
          .split(":")[0]!
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], cat);
        if (typeof value === "string") expect(value.trim(), path).not.toBe("");
      }
    }
  });

  it("messages ger rätt katalog och locale-fältet stämmer", () => {
    expect(messages("sv")).toBe(sv);
    expect(messages("en")).toBe(en);
    expect(sv.locale).toBe("sv");
    expect(en.locale).toBe("en");
  });

  it("Fyll på-bekräftelsen på båda språken", () => {
    expect(sv.fill.confirmQuestion).toBe("Har du fyllt på automaten nu?");
    expect(sv.fill.confirmYes).toBe("Ja, jag har fyllt på");
    expect(sv.fill.confirmNo).toBe("Nej, jag packar bara");
    expect(en.fill.confirmQuestion).toBe("Have you refilled the machine now?");
    expect(en.fill.confirmYes).toBe("Yes, I refilled");
    expect(en.fill.confirmNo).toBe("No, I'm only packing");
  });

  it("böjning efter antal", () => {
    expect(sv.common.packs(1)).toBe("1 pack");
    expect(en.common.packs(1)).toBe("1 pack");
    expect(en.common.packs(2)).toBe("2 packs");
    expect(sv.common.batches(2)).toBe("2 omgångar");
    expect(en.common.batches(1)).toBe("1 batch");
    expect(en.fill.needHeadline(3)).toBe("Refill 3 machines.");
    expect(sv.fill.needHeadline(1)).toBe("Fyll på 1 automat.");
  });

  it("lagernamn: Hemma blir at home på engelska", () => {
    expect(sv.common.inPlace("Hemma")).toBe("hemma");
    expect(sv.common.inPlace("Kontoret")).toBe("i Kontoret");
    expect(en.common.inPlace("Hemma")).toBe("at home");
    expect(en.common.inPlace("Kontoret")).toBe("at Kontoret");
    expect(en.common.placeName("hemma")).toBe("Home");
  });

  it("vinsten heter före butikernas andel på båda språken", () => {
    expect(sv.sales.profit).toBe("Vår vinst (före butikernas andel)");
    expect(en.sales.profit).toBe("Our profit (before stores' share)");
  });
});

describe("serverns felmeddelanden på engelska", () => {
  it("kända texter översätts, okända blir en lugn mening, svenska visas som de är", () => {
    expect(en.serverError("Packningen är redan ångrad.")).toBe("The packing is already undone.");
    expect(en.serverError("Fel e-postadress eller lösenord.")).toBe("Wrong email or password.");
    expect(en.serverError("Hemma saknar 3 Delta Reign.")).toBe("Home is missing 3 Delta Reign.");
    expect(en.serverError("Något helt okänt.")).toMatch(/^Something went wrong/);
    expect(sv.serverError("Något helt okänt.")).toBe("Något helt okänt.");
  });
});

describe("formatering", () => {
  const svF = formatters("sv");
  const enF = formatters("en");

  it("tal och kronor: svenska med hårt mellanslag, engelska med komma", () => {
    expect(svF.int(1325)).toBe("1 325");
    expect(enF.int(1325)).toBe("1,325");
    expect(svF.sek(1325)).toBe("1 325 kr");
    expect(enF.sek(1325)).toBe("1,325 kr");
    expect(enF.sek(-1240.5)).toBe("−1,241 kr");
    expect(enF.kronor(79987)).toBe("79,987.00 kr");
    expect(enF.int(Number.NaN)).toBe("–");
  });

  it("procent ur baspunkter", () => {
    expect(svF.marginBp(2375)).toBe("23,8 %");
    expect(enF.marginBp(2375)).toBe("23.8%");
    expect(enF.marginBp(2100, 0)).toBe("21%");
  });

  it("datum och tid på engelska", () => {
    const d = new Date(2026, 10, 1, 17, 7);
    const now = new Date(2026, 10, 8);
    expect(enF.date(d)).toBe("1 Nov 2026");
    expect(enF.date(d, { year: "auto", now })).toBe("1 Nov");
    expect(enF.dateTime(d, { now })).toBe("1 Nov 17:07");
    expect(enF.time(d)).toBe("17:07");
    expect(svF.date(d, { year: "auto", now })).toBe("1 nov.");
  });
});

describe("språket i förfrågan", () => {
  it("Accept-Language: första av sv/en i webbläsarens ordning, annars svenska", () => {
    expect(localeFromAcceptLanguage("en-GB,en;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("sv-SE,sv;q=0.9,en;q=0.8")).toBe("sv");
    expect(localeFromAcceptLanguage("de-DE,en;q=0.5")).toBe("en");
    expect(localeFromAcceptLanguage("en;q=0.4,sv;q=0.8")).toBe("sv");
    expect(localeFromAcceptLanguage("fr-FR")).toBe("sv");
    expect(localeFromAcceptLanguage("en;q=0")).toBe("sv");
    expect(localeFromAcceptLanguage(null)).toBe("sv");
  });

  it("kakan går före webbläsaren; okänt värde i kakan räknas inte", () => {
    expect(requestLocale("en", "sv-SE")).toBe("en");
    expect(requestLocale("sv", "en-US")).toBe("sv");
    expect(requestLocale("de", "en-US")).toBe("en");
    expect(isLocale("en")).toBe(true);
    expect(isLocale("EN")).toBe(false);
  });
});

/** Alla texter i en katalog, funktioner anropade med exempelvärden. */
function allTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") {
    const out: string[] = [];
    for (const args of [[2, "Hemma", 3], ["14:52"], [null], [1]]) {
      try {
        const r = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof r === "string") out.push(r);
      } catch {
        // En funktion med andra argument (t.ex. en lista): hoppas över.
      }
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(allTexts);
  }
  return [];
}

describe("engelskan för den som inte är teknisk", () => {
  it("Fyll på, Mystery, Försäljning och fellägen nämner aldrig Awish, VMB eller kön", () => {
    const texts = [en.fill, en.mystery, en.sales, en.simple, en.state].flatMap(allTexts);
    expect(texts.length).toBeGreaterThan(100);
    for (const text of texts) {
      expect(text, text).not.toMatch(/awish|vmb|queue|purchasing/i);
    }
  });

  it("tomma lägen och fel har engelska prefix", () => {
    expect(en.state.prefix.empty).toBe("Empty");
    expect(sv.state.prefix.empty).toBe("Tomt");
    expect(en.state.showDetails).toBe("Show details");
    expect(en.state.areaTitle("Vårt lager")).not.toMatch(/[åäö]/i);
  });

  it("packningens version visas inte i den enkla vyn", () => {
    expect(en.mystery.packingMeta("1 Nov 14:52", null)).toBe("1 Nov 14:52");
    expect(en.mystery.packingMeta("1 Nov 14:52", 2)).toBe("1 Nov 14:52 · version 2");
  });

  it("engelska dagar skrivs ut", () => {
    expect(en.fill.fullFast(1)).toBe("Full · lasts about 1 day");
    expect(en.fill.fullFast(2)).toBe("Full · lasts about 2 days");
  });
});
