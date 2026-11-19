/**
 * Underlaget för butikens bokföring i butiksrapporten: vem som betalar, avtalet och momsen.
 * Texterna här är de som står i rapporten (sidan, PDF:en, mejlet och butiksportalen).
 */

import { describe, expect, it } from "vitest";

import {
  asStoreBasis,
  basisGaps,
  basisText,
  contractForPeriod,
  contractLine,
  normalizeVatNumber,
  payerLines,
  suggestedVatNumber,
  vatRows,
  vatSentences,
  type BasisContractRow,
  type StoreBasis,
} from "./store-basis";

const NBSP = " ";

const BASIS: StoreBasis = {
  payer: {
    name: "Binderlab AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Storgatan 1, 111 22 Stockholm",
    vatNumber: "SE559000123401",
  },
  contract: { title: "Placeringsavtal", validFrom: "2026-11-03", signedOn: "2026-11-09" },
  vatMode: "added",
  vatRateBp: 2500,
};

const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };

function row(over: Partial<BasisContractRow>): BasisContractRow {
  return {
    title: "Placeringsavtal",
    validFrom: "2026-01-01",
    validTo: null,
    terminatedOn: null,
    template: "placering-v1",
    signedOn: "2025-12-20",
    ...over,
  };
}

describe("momsregistreringsnumret", () => {
  it("föreslås från organisationsnumret: SE + tio siffror + 01", () => {
    expect(suggestedVatNumber("559000-1234")).toBe("SE559000123401");
    expect(suggestedVatNumber("5590001234")).toBe("SE559000123401");
  });

  it("inget förslag utan ett helt organisationsnummer", () => {
    expect(suggestedVatNumber(null)).toBeNull();
    expect(suggestedVatNumber("")).toBeNull();
    expect(suggestedVatNumber("559000-12")).toBeNull();
  });

  it("tar emot numret med mellanslag och små bokstäver, men bara ett svenskt nummer", () => {
    expect(normalizeVatNumber("se 559000-1234 01")).toBe("SE559000123401");
    expect(normalizeVatNumber("SE559000123401")).toBe("SE559000123401");
    expect(normalizeVatNumber("559000123401")).toBeNull();
    expect(normalizeVatNumber("SE559000123402")).toBeNull();
    expect(normalizeVatNumber("DE123456789")).toBeNull();
  });
});

describe("avtalet för perioden", () => {
  it("det undertecknade kontraktet som gällde under perioden", () => {
    expect(contractForPeriod([row({})], OCTOBER)).toEqual({
      title: "Placeringsavtal",
      validFrom: "2026-01-01",
      signedOn: "2025-12-20",
    });
  });

  it("ett kontrakt från mallen som inte är undertecknat räknas inte", () => {
    expect(contractForPeriod([row({ signedOn: null })], OCTOBER)).toBeNull();
  });

  it("ett kontrakt registrerat för hand räknas, utan dag för undertecknandet", () => {
    expect(contractForPeriod([row({ template: null, signedOn: null })], OCTOBER)).toEqual({
      title: "Placeringsavtal",
      validFrom: "2026-01-01",
      signedOn: null,
    });
  });

  it("kontrakt som slutat före perioden, eller börjar efter den, räknas inte", () => {
    expect(contractForPeriod([row({ validTo: "2026-09-30" })], OCTOBER)).toBeNull();
    expect(contractForPeriod([row({ terminatedOn: "2026-09-30" })], OCTOBER)).toBeNull();
    expect(contractForPeriod([row({ validFrom: "2026-11-01" })], OCTOBER)).toBeNull();
    // Sista dagen i perioden räcker.
    expect(contractForPeriod([row({ validFrom: "2026-10-31" })], OCTOBER)).not.toBeNull();
    expect(contractForPeriod([row({ validTo: "2026-10-01" })], OCTOBER)).not.toBeNull();
  });

  it("med flera gäller det senaste, och ett kontrakt utan namn heter Placeringsavtal", () => {
    const picked = contractForPeriod(
      [
        row({ title: "Gammalt avtal", validFrom: "2025-01-01" }),
        row({ title: "  ", validFrom: "2026-06-01", signedOn: "2026-05-28" }),
        row({ title: "Inte undertecknat", validFrom: "2026-09-01", signedOn: null }),
      ],
      OCTOBER,
    );
    expect(picked).toEqual({
      title: "Placeringsavtal",
      validFrom: "2026-06-01",
      signedOn: "2026-05-28",
    });
  });
});

describe("texterna i rapporten", () => {
  it("vem som betalar: namn, org.nr, adress och momsreg.nr", () => {
    expect(payerLines(BASIS)).toEqual([
      "Binderlab AB",
      "Org.nr 559000-1234",
      "Storgatan 1, 111 22 Stockholm",
      "Momsreg.nr SE559000123401",
    ]);
  });

  it("det som inte är ifyllt står inte med (momsreg.nr gissas aldrig)", () => {
    const bare: StoreBasis = {
      ...BASIS,
      payer: { name: "Binderlab", legal: false, orgNumber: null, address: null, vatNumber: null },
    };
    expect(payerLines(bare)).toEqual(["Binderlab"]);
    expect(basisGaps(bare)).toEqual(["företagsnamn", "organisationsnummer"]);
    expect(basisGaps(BASIS)).toEqual([]);
    expect(basisGaps({ ...BASIS, payer: { ...BASIS.payer, orgNumber: null } })).toEqual([
      "organisationsnummer",
    ]);
  });

  it("avtalsraden", () => {
    expect(contractLine(BASIS)).toBe(
      "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
    );
    expect(contractLine({ ...BASIS, contract: { ...BASIS.contract!, signedOn: null } })).toBe(
      "Enligt Placeringsavtal från 3 november 2026.",
    );
  });

  it("utan undertecknat avtal finns ingen rad (rapporten påstår inget)", () => {
    expect(contractLine({ ...BASIS, contract: null })).toBeNull();
    expect(basisText({ ...BASIS, contract: null }, "Sega gubben", 749_300).join("\n")).not.toMatch(
      /Enligt|avtal/i,
    );
  });

  it("moms tillkommer: ersättningen, 25 % moms och beloppet att fakturera", () => {
    expect(vatRows(BASIS, 749_300)).toEqual([
      { key: "amount", label: "Ersättning exkl. moms", amountOre: 749_300 },
      { key: "vat", label: "Moms 25 %", amountOre: 187_325 },
      { key: "total", label: "Att fakturera", amountOre: 936_625 },
    ]);
    // Öresavrundning: halva ören uppåt.
    expect(vatRows(BASIS, 1_234_567).map((r) => r.amountOre)).toEqual([
      1_234_567, 308_642, 1_543_209,
    ]);
    expect(vatSentences(BASIS, 749_300)).toEqual([
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
  });

  it("ingen ersättning: inget att fakturera", () => {
    expect(vatRows(BASIS, 0)).toEqual([]);
    expect(vatRows(BASIS, -5_000)).toEqual([]);
    // Inget påstående om hur vi själva redovisar momsen, och inga ord som stoppas i butiksmejlet.
    for (const ore of [749_300, 0, -5_000])
      for (const mode of ["added", "none"] as const)
        expect(vatSentences({ ...BASIS, vatMode: mode }, ore).join(" ")).not.toMatch(
          /redovisar|vinst|marginal/i,
        );
    expect(vatSentences(BASIS, 0)).toEqual(["Binderlab AB är säljare av varorna i automaten."]);
  });

  it("Visa ingen momsrad: inga momsbelopp och inget påstående om moms", () => {
    const none: StoreBasis = { ...BASIS, vatMode: "none" };
    expect(vatRows(none, 749_300)).toEqual([]);
    expect(vatSentences(none, 749_300)).toEqual([
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
    expect(basisText(none, "Sega gubben", 749_300).join("\n")).not.toMatch(/moms(?!reg)/i);
  });

  it("hela blocket som text (mejlets textdel)", () => {
    expect(basisText(BASIS, "Sega gubben", 749_300)).toEqual([
      "Ersättningen betalas av: Binderlab AB, Org.nr 559000-1234, Storgatan 1, 111 22 Stockholm, Momsreg.nr SE559000123401",
      "Mottagare: Sega gubben",
      "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
      `Ersättning exkl. moms: 7${NBSP}493,00${NBSP}kr`,
      `Moms 25 %: 1${NBSP}873,25${NBSP}kr`,
      `Att fakturera: 9${NBSP}366,25${NBSP}kr`,
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
  });
});

describe("sparat värde", () => {
  it("läses tillbaka, och ett saknat eller trasigt värde ger inget block", () => {
    expect(asStoreBasis(JSON.parse(JSON.stringify(BASIS)))).toEqual(BASIS);
    expect(asStoreBasis(undefined)).toBeNull();
    expect(asStoreBasis(null)).toBeNull();
    expect(asStoreBasis({ payer: { name: "X" } })).toBeNull();
    expect(asStoreBasis({ ...BASIS, vatMode: "annat" })).toBeNull();
  });
});
